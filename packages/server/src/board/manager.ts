// 任务看板调度器：卡片 = 一个顶层会话；依赖/并发/重试/审批门/预算/断点续跑都在这里。
// 数据以 ~/.tandem/boards/<id>.json 为准（每次状态迁移都落盘），运行中信息由会话状态实时推导。
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import type {
  Board,
  BoardCard,
  BoardCardAction,
  BoardCardInput,
  BoardCardStatus,
  BoardExec,
  BoardInput,
  BoardPlanDraft,
  BoardSummary,
  PermissionMode,
} from '@tandem/protocol';
import { BOARD_COLUMNS } from '@tandem/protocol';
import { detectSessionEnv } from '../util/git.js';
import { expandHome } from '../util/path.js';
import { errorMessage } from '../util/text.js';
import { gitRepoRoot } from '../worktree.js';
import { EFFORTS, PERMISSION_MODES } from '../host/helpers.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';
import { commitAndStat, currentHead, mergeBranchInto } from './git.js';
import { decideSchedule, topoOrder, validateDrafts, wouldCycle } from './graph.js';
import { planCards } from './planner.js';
import { BoardStore } from './store.js';

const TICK_MS = 1000;
/** 所有看板合计同时运行的卡数上限。 */
export const GLOBAL_MAX_RUNNING = 6;
const DEFAULT_PARALLEL = 2;
const MAX_PARALLEL = 8;
const UPSTREAM_CHARS = 2000;
const SUMMARY_CHARS = 4000;
export const BUDGET_ERROR = '超出单卡预算';

interface TurnNote {
  reason: 'done' | 'interrupted' | 'error';
  error?: string;
  lastText?: string;
}

const EDITABLE: BoardCardStatus[] = ['todo', 'queued', 'failed'];

function retryDelayMs(): number {
  const raw = Number(process.env.TANDEM_BOARD_RETRY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
}

function clampParallel(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_PARALLEL;
  return Math.min(MAX_PARALLEL, Math.max(1, n));
}

function cleanExec(input: BoardExec | undefined): BoardExec {
  const exec: BoardExec = {};
  if (!input || typeof input !== 'object') return exec;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  if (text(input.preset)) exec.preset = text(input.preset);
  if (text(input.profileId)) exec.profileId = text(input.profileId);
  if (text(input.groupId)) exec.groupId = text(input.groupId);
  if (text(input.model)) exec.model = text(input.model);
  if (input.effort && EFFORTS.has(input.effort)) exec.effort = input.effort;
  if (input.permissionMode && PERMISSION_MODES.has(input.permissionMode)) exec.permissionMode = input.permissionMode;
  if (typeof input.worktree === 'boolean') exec.worktree = input.worktree;
  if (typeof input.budgetUsd === 'number' && input.budgetUsd > 0) exec.budgetUsd = input.budgetUsd;
  if (typeof input.maxRetries === 'number' && input.maxRetries >= 0) exec.maxRetries = Math.min(5, Math.floor(input.maxRetries));
  if (typeof input.gate === 'boolean') exec.gate = input.gate;
  return exec;
}

function shortOf(id: string): string {
  return id.replace(/-/g, '').slice(0, 6);
}

function textOfMessage(rec: SessionRecord): string {
  for (let i = rec.messages.length - 1; i >= 0; i -= 1) {
    const message = rec.messages[i]!;
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** 最近一次工具调用/文本的一行描述，给运行中的卡片显示。 */
function activityOf(rec: SessionRecord): string | undefined {
  for (let i = rec.messages.length - 1; i >= 0 && i >= rec.messages.length - 6; i -= 1) {
    const message = rec.messages[i]!;
    if (message.role !== 'assistant') continue;
    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const block = message.content[j]!;
      if (block.type === 'tool_use') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const target = [input.file_path, input.path, input.command, input.pattern, input.description, input.url].find(
          (value): value is string => typeof value === 'string' && value.trim() !== '',
        );
        return oneLine(`${block.name}${target ? ` ${target}` : ''}`, 80);
      }
      if (block.type === 'text' && block.text.trim()) return oneLine(block.text, 80);
    }
  }
  return undefined;
}

export class BoardManager {
  private readonly store: BoardStore;
  private readonly boards = new Map<string, Board>();
  private timer?: NodeJS.Timeout;
  private started = false;
  /** 正在建会话 / 收尾（提交、统计）的卡，tick 不介入。 */
  private readonly busy = new Set<string>();
  /** host.send 尚未返回（回合仍在跑或刚排队）的卡。 */
  private readonly sends = new Set<string>();
  private readonly turnNotes = new Map<string, TurnNote>();
  /** 有过运行且尚未发出"整块跑完"通知的看板。 */
  private readonly active = new Set<string>();
  private mergeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: Host, home: string) {
    this.store = new BoardStore(home);
    for (const board of this.store.load()) this.boards.set(board.id, board);
  }

  /** Host 重启续跑完成后调用：开始调度，并收养仍在运行的卡。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const board of this.boards.values()) {
      if (board.cards.some((card) => ['queued', 'running', 'approval'].includes(card.status))) this.active.add(board.id);
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.tick();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ---------- 查询 ----------

  nameOf(boardId: string): string | undefined {
    return this.boards.get(boardId)?.name;
  }

  list(): BoardSummary[] {
    return [...this.boards.values()]
      .map((board) => this.summaryOf(board))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Board | undefined {
    const board = this.boards.get(id);
    if (board) this.refreshDerived(board);
    return board;
  }

  private summaryOf(board: Board): BoardSummary {
    const counts = Object.fromEntries(BOARD_COLUMNS.map((status) => [status, 0])) as Record<BoardCardStatus, number>;
    let costUsd = 0;
    for (const card of board.cards) {
      counts[card.status] += 1;
      costUsd += this.costOf(card);
    }
    return {
      id: board.id,
      name: board.name,
      cwd: board.cwd,
      counts,
      needsMe: counts.approval + counts.review + counts.failed,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      updatedAt: board.updatedAt,
    };
  }

  private costOf(card: BoardCard): number {
    const rec = card.sessionId ? this.host.store.get(card.sessionId) : undefined;
    return rec?.usage.costUsd ?? card.result?.costUsd ?? 0;
  }

  // ---------- 看板 CRUD ----------

  async createBoard(input: BoardInput): Promise<Board> {
    const rawCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
    if (!rawCwd) throw new Error('项目目录不能为空');
    const cwd = path.resolve(expandHome(rawCwd));
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {
      // 下面统一报错
    }
    if (!isDir) throw new Error(`项目目录不存在: ${cwd}`);
    const root = await gitRepoRoot(cwd);
    const env = root ? await detectSessionEnv(cwd) : undefined;
    const defaults = cleanExec(input.defaults);
    if (!defaults.profileId) {
      const first = this.host.profiles.list()[0];
      if (first) defaults.profileId = first.id;
    }
    if (!defaults.permissionMode) defaults.permissionMode = 'acceptEdits';
    const now = Date.now();
    const board: Board = {
      id: randomUUID(),
      name: (typeof input.name === 'string' && input.name.trim()) || path.basename(cwd) || '看板',
      cwd,
      isGit: !!root,
      ...(env?.branch ? { baseBranch: env.branch } : {}),
      maxParallel: clampParallel(input.maxParallel),
      mergePolicy: input.mergePolicy === 'auto' ? 'auto' : 'manual',
      defaults,
      cards: [],
      createdAt: now,
      updatedAt: now,
    };
    this.boards.set(board.id, board);
    this.commit(board);
    return board;
  }

  updateBoard(id: string, input: BoardInput): Board {
    const board = this.require(id);
    if (typeof input.name === 'string' && input.name.trim()) board.name = input.name.trim().slice(0, 80);
    if (input.maxParallel !== undefined) board.maxParallel = clampParallel(input.maxParallel);
    if (input.mergePolicy === 'auto' || input.mergePolicy === 'manual') board.mergePolicy = input.mergePolicy;
    if (input.defaults) {
      board.defaults = { ...cleanExec(input.defaults) };
      if (!board.defaults.permissionMode) board.defaults.permissionMode = 'acceptEdits';
    }
    this.commit(board);
    this.kick();
    return this.get(id)!;
  }

  async deleteBoard(id: string): Promise<void> {
    const board = this.require(id);
    for (const card of board.cards) {
      if (card.status === 'running' || card.status === 'approval') {
        if (card.sessionId) this.host.interrupt(card.sessionId);
      }
      const rec = card.sessionId ? this.host.store.get(card.sessionId) : undefined;
      if (rec) {
        delete rec.board;
        this.host.store.markDirty(rec.id, false);
        this.host.broadcastSummary(rec);
      }
    }
    this.boards.delete(id);
    this.active.delete(id);
    this.store.remove(id);
    this.host.hub.broadcastAll({ type: 'board_updated', boardId: id });
  }

  // ---------- 卡片 CRUD ----------

  createCard(boardId: string, input: BoardCardInput): BoardCard {
    const board = this.require(boardId);
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    const title = (typeof input.title === 'string' && input.title.trim()) || oneLine(prompt, 40);
    if (!title) throw new Error('标题或提示词不能为空');
    if (!prompt) throw new Error('提示词不能为空');
    const id = randomUUID();
    const deps = this.checkDeps(board, id, input.deps);
    const status: BoardCardStatus = input.status === 'queued' ? 'queued' : 'todo';
    const now = Date.now();
    const card: BoardCard = {
      id,
      title: title.slice(0, 120),
      prompt,
      deps,
      status,
      order: this.nextOrder(board, status),
      exec: cleanExec(input.exec),
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    board.cards.push(card);
    this.commit(board);
    this.kick();
    return card;
  }

  updateCard(boardId: string, cardId: string, input: BoardCardInput): BoardCard {
    const board = this.require(boardId);
    const card = this.requireCard(board, cardId);
    if (!EDITABLE.includes(card.status)) throw new Error('只有待办、排队或失败的卡片可以编辑');
    if (input.prompt !== undefined) {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) throw new Error('提示词不能为空');
      card.prompt = prompt;
    }
    if (input.title !== undefined) {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title) throw new Error('标题不能为空');
      card.title = title.slice(0, 120);
    }
    if (input.deps !== undefined) card.deps = this.checkDeps(board, card.id, input.deps);
    if (input.exec !== undefined) card.exec = cleanExec(input.exec);
    card.updatedAt = Date.now();
    this.commit(board);
    this.kick();
    return card;
  }

  async deleteCard(boardId: string, cardId: string): Promise<void> {
    const board = this.require(boardId);
    const card = this.requireCard(board, cardId);
    if (card.sessionId) {
      this.host.interrupt(card.sessionId);
      await this.host.deleteSession(card.sessionId, true).catch((err) => {
        console.warn('[tandem] 删除卡片会话失败:', errorMessage(err));
      });
    }
    board.cards = board.cards.filter((item) => item.id !== cardId);
    for (const other of board.cards) other.deps = other.deps.filter((dep) => dep !== cardId);
    this.commit(board);
    this.kick();
  }

  /** 列内排序：放到 beforeId 之前（null/缺省 = 列尾）。 */
  move(boardId: string, cardId: string, beforeId?: string | null): Board {
    const board = this.require(boardId);
    const card = this.requireCard(board, cardId);
    const column = board.cards
      .filter((item) => item.status === card.status && item.id !== card.id)
      .sort((a, b) => a.order - b.order);
    const index = beforeId ? column.findIndex((item) => item.id === beforeId) : -1;
    if (index >= 0) column.splice(index, 0, card);
    else column.push(card);
    column.forEach((item, i) => {
      item.order = (i + 1) * 1000;
    });
    this.commit(board);
    return this.get(boardId)!;
  }

  private checkDeps(board: Board, cardId: string, deps: string[] | undefined): string[] {
    const list = [...new Set((Array.isArray(deps) ? deps : []).filter((dep): dep is string => typeof dep === 'string'))];
    for (const dep of list) {
      if (dep === cardId) throw new Error('卡片不能依赖自己');
      if (!board.cards.some((card) => card.id === dep)) throw new Error('依赖的卡片不存在');
    }
    if (wouldCycle(board.cards, cardId, list)) throw new Error('依赖形成了环');
    return list;
  }

  // ---------- 动作 ----------

  async act(boardId: string, cardId: string, action: BoardCardAction, opts: { note?: string; strategy?: 'merge' | 'squash' } = {}): Promise<BoardCard> {
    const board = this.require(boardId);
    const card = this.requireCard(board, cardId);
    const must = (...allowed: BoardCardStatus[]) => {
      if (!allowed.includes(card.status)) throw new Error(`当前状态（${card.status}）不能执行该操作`);
    };
    switch (action) {
      case 'start':
        must('todo');
        this.setStatus(board, card, 'queued');
        delete card.retryAt;
        break;
      case 'unqueue':
        must('queued');
        this.setStatus(board, card, 'todo');
        delete card.retryAt;
        break;
      case 'stop':
        must('running', 'approval', 'queued');
        if (card.sessionId) this.host.interrupt(card.sessionId);
        delete card.retryAt;
        this.setStatus(board, card, 'todo');
        break;
      case 'retry':
        must('failed');
        card.attempts = 0;
        delete card.retryAt;
        this.setStatus(board, card, 'queued');
        break;
      case 'approve':
        must('review');
        this.setStatus(board, card, 'done');
        card.finishedAt = Date.now();
        this.afterDone(board, card);
        break;
      case 'reject':
        must('review');
        card.reviewNote = (opts.note ?? '').trim() || '请重新检查并改进后再次提交。';
        card.attempts = 0;
        this.setStatus(board, card, 'queued');
        break;
      case 'merge':
        must('done');
        card.updatedAt = Date.now();
        this.commit(board);
        await this.mergeCard(board, card, opts.strategy === 'merge' ? 'merge' : 'squash');
        return card;
      default:
        throw new Error('未知操作');
    }
    card.updatedAt = Date.now();
    this.commit(board);
    this.kick();
    return card;
  }

  /** 按依赖顺序合并所有已完成且未合并的卡。 */
  async mergeAll(boardId: string, strategy: 'merge' | 'squash' = 'squash'): Promise<{ merged: string[]; failed: { cardId: string; error: string }[] }> {
    const board = this.require(boardId);
    const merged: string[] = [];
    const failed: { cardId: string; error: string }[] = [];
    for (const card of topoOrder(board.cards)) {
      if (card.status !== 'done' || !card.result?.branch || card.result.mergedAt) continue;
      const result = await this.mergeCard(board, card, strategy);
      if (result.ok) merged.push(card.id);
      else {
        failed.push({ cardId: card.id, error: result.error ?? '合并失败' });
        break;
      }
    }
    return { merged, failed };
  }

  private mergeCard(board: Board, card: BoardCard, strategy: 'merge' | 'squash'): Promise<{ ok: boolean; error?: string }> {
    const run = async (): Promise<{ ok: boolean; error?: string }> => {
      if (!card.sessionId || !card.result?.branch) return { ok: false, error: '该卡片没有可合并的分支' };
      if (card.result.mergedAt) return { ok: true };
      let result: { ok: boolean; error?: string };
      try {
        result = await this.host.mergeSessionWorktree(card.sessionId, strategy);
      } catch (err) {
        result = { ok: false, error: errorMessage(err) };
      }
      if (card.result) {
        if (result.ok) {
          card.result.mergedAt = Date.now();
          delete card.result.mergeError;
        } else {
          card.result.mergeError = result.error ?? '合并失败';
        }
      }
      card.updatedAt = Date.now();
      this.commit(board);
      return result;
    };
    const next = this.mergeChain.then(run, run);
    this.mergeChain = next.catch(() => undefined);
    return next;
  }

  // ---------- 协调者（规划器） ----------

  async plan(boardId: string, goal: string): Promise<BoardPlanDraft[]> {
    const board = this.require(boardId);
    const text = typeof goal === 'string' ? goal.trim() : '';
    if (!text) throw new Error('请先写下目标');
    return planCards(this.host, board, text);
  }

  applyPlan(boardId: string, drafts: BoardPlanDraft[]): BoardCard[] {
    const board = this.require(boardId);
    if (!Array.isArray(drafts) || drafts.length === 0) throw new Error('没有可创建的草稿');
    const clean = drafts.map((draft) => ({
      ref: String(draft.ref ?? ''),
      title: String(draft.title ?? '').trim().slice(0, 120),
      prompt: String(draft.prompt ?? '').trim(),
      deps: Array.isArray(draft.deps) ? draft.deps.map(String) : [],
      ...(draft.preset ? { preset: String(draft.preset) } : {}),
      ...(draft.gate ? { gate: true } : {}),
    }));
    for (const draft of clean) if (!draft.ref || !draft.title || !draft.prompt) throw new Error('草稿缺少标题或提示词');
    validateDrafts(clean);
    const idOf = new Map(clean.map((draft) => [draft.ref, randomUUID()] as const));
    const now = Date.now();
    const created: BoardCard[] = clean.map((draft) => ({
      id: idOf.get(draft.ref)!,
      title: draft.title,
      prompt: draft.prompt,
      deps: draft.deps.map((ref) => idOf.get(ref)!),
      status: 'todo',
      order: 0,
      exec: cleanExec({ ...(draft.preset ? { preset: draft.preset } : {}), ...(draft.gate ? { gate: true } : {}) }),
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }));
    for (const card of created) {
      card.order = this.nextOrder(board, 'todo');
      board.cards.push(card);
    }
    this.commit(board);
    return created;
  }

  // ---------- 会话钩子 ----------

  /** sendToModel 回合结束时由 Host 调用，给收尾判断提供精确的结束原因。 */
  noteTurn(sessionId: string, note: TurnNote): void {
    this.turnNotes.set(sessionId, note);
  }

  /** assertBudget 调用：卡片会话累计花费达到单卡上限时抛错，回合以明确错误结束。 */
  assertCardBudget(rec: SessionRecord): void {
    if (!rec.board) return;
    const board = this.boards.get(rec.board.boardId);
    const card = board?.cards.find((item) => item.id === rec.board!.cardId);
    const cap = card?.exec.budgetUsd ?? board?.defaults.budgetUsd;
    if (!cap) return;
    const spent = rec.usage.costUsd ?? 0;
    if (spent >= cap) throw new Error(`${BUDGET_ERROR}：已用 $${spent.toFixed(4)} / 上限 $${cap}`);
  }

  // ---------- 调度 ----------

  /** 立即触发一次调度（动作之后、会话结束之后）。 */
  kick(): void {
    if (!this.started) return;
    setImmediate(() => this.tick());
  }

  private tick(): void {
    for (const board of this.boards.values()) {
      try {
        this.reconcile(board);
        this.schedule(board);
        this.maybeFinished(board);
        this.refreshDerived(board, true);
      } catch (err) {
        console.warn('[tandem] 看板调度出错:', errorMessage(err));
      }
    }
  }

  private runningCount(board: Board): number {
    return board.cards.filter((card) => card.status === 'running').length;
  }

  private globalRunning(): number {
    let count = 0;
    for (const board of this.boards.values()) count += this.runningCount(board);
    return count;
  }

  private exclusive(board: Board, card: BoardCard): boolean {
    return !this.useWorktree(board, card);
  }

  private useWorktree(board: Board, card: BoardCard): boolean {
    return board.isGit && (card.exec.worktree ?? board.defaults.worktree ?? true);
  }

  /** 同一目录下是否有不用 worktree 的卡正在占用（running/approval 都算）。 */
  private dirBusy(board: Board): boolean {
    for (const other of this.boards.values()) {
      if (other.cwd !== board.cwd) continue;
      if (other.cards.some((card) => (card.status === 'running' || card.status === 'approval') && this.exclusive(other, card))) {
        return true;
      }
    }
    return false;
  }

  private decide(board: Board) {
    return decideSchedule({
      cards: board.cards,
      now: Date.now(),
      maxParallel: board.maxParallel,
      running: this.runningCount(board),
      globalFree: GLOBAL_MAX_RUNNING - this.globalRunning(),
      dirBusy: this.dirBusy(board),
      exclusive: (id) => {
        const card = board.cards.find((item) => item.id === id);
        return !!card && this.exclusive(board, card);
      },
    });
  }

  private schedule(board: Board): void {
    const { launch } = this.decide(board);
    for (const id of launch) {
      const card = board.cards.find((item) => item.id === id);
      if (card) this.launch(board, card);
    }
  }

  private refreshDerived(board: Board, broadcastIfChanged = false): void {
    const before = broadcastIfChanged ? this.signature(board) : '';
    const { blocked } = this.decide(board);
    for (const card of board.cards) {
      const reason = blocked.get(card.id);
      if (reason && card.status === 'queued') card.blocked = reason;
      else delete card.blocked;
      const rec = (card.status === 'running' || card.status === 'approval') && card.sessionId ? this.host.store.get(card.sessionId) : undefined;
      if (rec) {
        const rt = this.host.runtimes.get(rec.id);
        const pending = rt ? [...rt.pending.values()][0] : undefined;
        const activity = pending ? `等待允许 ${pending.request.toolName}` : rec.resumePaused ? '重启后已暂停，等待继续' : activityOf(rec);
        if (activity) card.activity = activity;
        else delete card.activity;
      } else delete card.activity;
    }
    if (broadcastIfChanged && before !== this.signature(board)) {
      this.host.hub.broadcastAll({ type: 'board_updated', boardId: board.id });
    }
  }

  private signature(board: Board): string {
    return board.cards.map((card) => `${card.id}:${card.status}:${card.blocked ?? ''}:${card.activity ?? ''}`).join('|');
  }

  /** 把运行中/待审批的卡与会话的真实状态对齐；回合结束时收尾。 */
  private reconcile(board: Board): void {
    for (const card of board.cards) {
      if (card.status !== 'running' && card.status !== 'approval') continue;
      if (this.busy.has(card.id)) continue;
      if (!card.sessionId) {
        // 没有会话也不在启动中：Host 在建会话前就重启了，退回排队
        this.setStatus(board, card, 'queued');
        this.commit(board);
        continue;
      }
      const rec = this.host.store.get(card.sessionId);
      if (!rec) {
        this.fail(board, card, '卡片会话已被删除');
        continue;
      }
      const rt = this.host.runtimes.get(rec.id);
      if (rec.resumePaused || rec.status === 'waiting_permission' || (rt?.pending.size ?? 0) > 0) {
        if (card.status !== 'approval') {
          this.setStatus(board, card, 'approval');
          this.commit(board);
        }
        continue;
      }
      // 不看 rec.status：崩溃遗留的 running 状态没有运行时对应，会让卡永远停在运行中
      const running = rt?.running || rt?.draining || (rt?.queue.length ?? 0) > 0 || this.sends.has(card.id);
      if (running) {
        if (card.status !== 'running') {
          this.setStatus(board, card, 'running');
          this.commit(board);
        }
        continue;
      }
      this.busy.add(card.id);
      void this.finish(board, card, rec).finally(() => {
        this.busy.delete(card.id);
        this.kick();
      });
    }
  }

  private launch(board: Board, card: BoardCard): void {
    this.active.add(board.id);
    const resuming = !!card.sessionId && !!this.host.store.get(card.sessionId);
    this.setStatus(board, card, 'running');
    card.startedAt = card.startedAt ?? Date.now();
    delete card.retryAt;
    this.commit(board);
    this.busy.add(card.id);
    void (async () => {
      try {
        const rec = resuming ? this.host.store.get(card.sessionId!)! : await this.prepareSession(board, card);
        const text = this.composePrompt(board, card, resuming);
        card.sentPrompt = card.prompt;
        delete card.reviewNote;
        delete card.error;
        this.turnNotes.delete(rec.id);
        this.sends.add(card.id);
        this.commit(board);
        void this.host
          .send(rec.id, [{ type: 'text', text }])
          .catch((err) => this.turnNotes.set(rec.id, { reason: 'error', error: errorMessage(err) }))
          .finally(() => {
            this.sends.delete(card.id);
            this.kick();
          });
      } catch (err) {
        this.handleError(board, card, errorMessage(err), false);
      } finally {
        this.busy.delete(card.id);
      }
    })();
  }

  private async prepareSession(board: Board, card: BoardCard): Promise<SessionRecord> {
    const exec = { ...board.defaults, ...card.exec };
    const profileId = exec.profileId || this.host.profiles.list()[0]?.id || '';
    const permissionMode: PermissionMode = exec.permissionMode ?? 'acceptEdits';
    // 复用子代理预设解析：预设带来账号/模型/工具白名单/附加提示，卡上的显式设置优先
    const config = this.host.subagentConfig(
      { profileId, ...(exec.groupId ? { groupId: exec.groupId } : {}), model: '', permissionMode, cwd: board.cwd, ...(exec.effort ? { effort: exec.effort } : {}) } as SessionRecord,
      exec.preset,
      exec.model,
    );
    const useWorktree = this.useWorktree(board, card);
    const rec = await this.host.createSession({
      cwd: board.cwd,
      profileId: config.profileId,
      ...(config.groupId ? { groupId: config.groupId } : {}),
      model: config.model,
      permissionMode: exec.permissionMode ?? config.permissionMode,
      ...(config.effort ? { effort: config.effort } : {}),
      ...(exec.preset ? { delegation: config.delegation } : {}),
      title: card.title,
      ...(useWorktree ? { worktree: { branch: `tandem/board-${shortOf(board.id)}-${shortOf(card.id)}` } } : {}),
    });
    rec.board = { boardId: board.id, cardId: card.id };
    if (config.toolWhitelist) rec.toolWhitelist = config.toolWhitelist;
    if (config.systemPromptExtra) rec.systemPromptExtra = config.systemPromptExtra;
    this.host.store.markDirty(rec.id, true);
    card.sessionId = rec.id;
    this.commit(board);
    this.host.broadcastSummary(rec);

    if (rec.worktree) {
      // 下游卡的 worktree 先合入各依赖卡的分支，才能看到上游的改动
      for (const depId of card.deps) {
        const branch = board.cards.find((item) => item.id === depId)?.result?.branch;
        if (!branch) continue;
        const merged = await mergeBranchInto(rec.cwd, branch);
        if (!merged.ok) {
          card.sessionId = undefined;
          await this.host.deleteSession(rec.id, true).catch(() => undefined);
          throw new Error(merged.error);
        }
      }
      card.baseCommit = await currentHead(rec.cwd);
      this.commit(board);
    }
    return rec;
  }

  private composePrompt(board: Board, card: BoardCard, resuming: boolean): string {
    if (resuming) {
      if (card.reviewNote) return `评审意见：${card.reviewNote}\n\n请据此修改并完成任务。`;
      if (card.sentPrompt !== undefined && card.sentPrompt !== card.prompt) {
        return `任务说明已更新，请按新说明继续：\n${card.prompt}`;
      }
      if (card.error) return `上次执行出错：${card.error}\n\n请检查当前状态并继续完成任务。`;
      return `请继续完成任务：${card.prompt}`;
    }
    const upstream = card.deps
      .map((id) => board.cards.find((item) => item.id === id))
      .filter((dep): dep is BoardCard => !!dep?.result?.summary)
      .map((dep) => `- ${dep.title}：${dep.result!.summary.slice(0, UPSTREAM_CHARS)}`);
    return upstream.length > 0 ? `${card.prompt}\n\n上游卡片的结果（仅供参考）：\n${upstream.join('\n')}` : card.prompt;
  }

  // ---------- 收尾 ----------

  private async finish(board: Board, card: BoardCard, rec: SessionRecord): Promise<void> {
    const rt = this.host.runtimes.get(rec.id);
    const note = this.turnNotes.get(rec.id);
    this.turnNotes.delete(rec.id);
    const reason = note?.reason ?? (rec.status === 'error' ? 'error' : rt?.interrupted ? 'interrupted' : 'done');
    if (reason === 'interrupted') {
      this.fail(board, card, '已被中断');
      return;
    }
    if (reason === 'error') {
      this.handleError(board, card, note?.error ?? '回合出错', true);
      return;
    }
    const result: NonNullable<BoardCard['result']> = {
      summary: (note?.lastText ?? textOfMessage(rec)).slice(0, SUMMARY_CHARS),
      files: 0,
      additions: 0,
      deletions: 0,
      costUsd: rec.usage.costUsd ?? 0,
      durationMs: Date.now() - (card.startedAt ?? Date.now()),
    };
    if (rec.worktree) {
      try {
        const stat = await commitAndStat(rec.worktree.path, card.baseCommit ?? rec.worktree.baseBranch, card.title);
        Object.assign(result, { files: stat.files, additions: stat.additions, deletions: stat.deletions, ...(stat.commit ? { commit: stat.commit } : {}), branch: rec.worktree.branch });
      } catch (err) {
        console.warn('[tandem] 看板自动提交失败:', errorMessage(err));
        result.branch = rec.worktree.branch;
      }
    }
    card.result = result;
    card.finishedAt = Date.now();
    delete card.error;
    if (card.exec.gate ?? board.defaults.gate) {
      this.setStatus(board, card, 'review');
      this.commit(board);
      this.notify(board, card, 'review', `「${card.title}」已完成，等待你评审`);
    } else {
      this.setStatus(board, card, 'done');
      this.commit(board);
      this.afterDone(board, card);
    }
  }

  private afterDone(board: Board, card: BoardCard): void {
    if (board.mergePolicy === 'auto' && card.result?.branch) void this.mergeCard(board, card, 'squash');
  }

  private handleError(board: Board, card: BoardCard, message: string, canRetry: boolean): void {
    const limit = card.exec.maxRetries ?? board.defaults.maxRetries ?? 1;
    if (canRetry && !message.includes(BUDGET_ERROR) && card.attempts < limit) {
      card.attempts += 1;
      card.error = message;
      card.retryAt = Date.now() + retryDelayMs();
      this.setStatus(board, card, 'queued');
      this.commit(board);
      return;
    }
    this.fail(board, card, message);
  }

  private fail(board: Board, card: BoardCard, message: string): void {
    card.error = message;
    card.finishedAt = Date.now();
    delete card.retryAt;
    this.setStatus(board, card, 'failed');
    this.commit(board);
    this.notify(board, card, 'failed', `「${card.title}」失败：${message}`);
  }

  private maybeFinished(board: Board): void {
    if (!this.active.has(board.id)) return;
    const { blocked } = this.decide(board);
    const pending = board.cards.some((card) => {
      if (card.status === 'running' || card.status === 'approval') return true;
      return card.status === 'queued' && blocked.get(card.id) !== 'upstream_failed';
    });
    if (pending || this.busy.size > 0) return;
    this.active.delete(board.id);
    const counts = this.summaryOf(board).counts;
    const parts = [`${counts.done} 完成`, counts.review ? `${counts.review} 待评审` : '', counts.failed ? `${counts.failed} 失败` : ''].filter(Boolean);
    this.notify(board, undefined, 'finished', `看板「${board.name}」已跑完：${parts.join(' · ')}`);
  }

  // ---------- 内部工具 ----------

  private notify(board: Board, card: BoardCard | undefined, event: 'review' | 'failed' | 'finished', text: string): void {
    this.host.pushInbox(
      this.host.inbox.recordBoard({
        boardId: board.id,
        boardName: board.name,
        ...(card ? { cardId: card.id, cardTitle: card.title } : {}),
        event,
        text,
      }),
    );
  }

  private nextOrder(board: Board, status: BoardCardStatus): number {
    const orders = board.cards.filter((card) => card.status === status).map((card) => card.order);
    return (orders.length > 0 ? Math.max(...orders) : 0) + 1000;
  }

  private setStatus(board: Board, card: BoardCard, status: BoardCardStatus): void {
    if (card.status === status) return;
    // running/approval 之间切换不改排序；进入新列时排到列尾
    const sameColumn = (card.status === 'running' || card.status === 'approval') && (status === 'running' || status === 'approval');
    card.status = status;
    if (!sameColumn) card.order = this.nextOrder(board, status);
    card.updatedAt = Date.now();
  }

  private commit(board: Board): void {
    board.updatedAt = Date.now();
    this.store.save(board);
    this.host.hub.broadcastAll({ type: 'board_updated', boardId: board.id });
  }

  private require(id: string): Board {
    const board = this.boards.get(id);
    if (!board) throw Object.assign(new Error('看板不存在'), { statusCode: 404 });
    return board;
  }

  private requireCard(board: Board, cardId: string): BoardCard {
    const card = board.cards.find((item) => item.id === cardId);
    if (!card) throw Object.assign(new Error('卡片不存在'), { statusCode: 404 });
    return card;
  }
}
