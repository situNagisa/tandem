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
import type { SessionRecord, ToolResult } from '../types.js';
import type { Host } from '../host.js';
import { commitAndStat, currentHead, mergeBranchInto } from './git.js';
import { decideSchedule, topoOrder, validateDrafts, wouldCycle } from './graph.js';
import { planCards } from './planner.js';
import { openBoardPr, refreshBoardPr } from './pr.js';
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  if (typeof input.aiReview === 'boolean') exec.aiReview = input.aiReview;
  return exec;
}

function clampAutoAccept(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(10, n);
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
  /** 演示看板：只展示预置状态，不参与自动调度（用户手动动作仍可触发）。 */
  private readonly demoBoards = new Set<string>();
  private mergeChain: Promise<unknown> = Promise.resolve();
  /** 聚合 PR 最近一次状态刷新时间（毫秒），避免每次 tick 都调 gh/glab。 */
  private readonly prRefreshedAt = new Map<string, number>();

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

  /** 演示工作区：写入一张预置看板，不启动调度。 */
  seedDemo(board: Board): void {
    this.boards.set(board.id, board);
    this.demoBoards.add(board.id);
    this.store.save(board);
    this.host.hub.broadcastAll({ type: 'board_updated', boardId: board.id });
  }

  /** 演示清理：只移除内存与落盘，不触发卡片会话级联（由调用方统一删除）。 */
  removeDemo(id: string): void {
    this.boards.delete(id);
    this.active.delete(id);
    this.demoBoards.delete(id);
    this.store.remove(id);
    this.host.hub.broadcastAll({ type: 'board_updated', boardId: id });
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
      autoAcceptProposals: clampAutoAccept(input.autoAcceptProposals),
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
    if (input.autoAcceptProposals !== undefined) board.autoAcceptProposals = clampAutoAccept(input.autoAcceptProposals);
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
    // 演示看板默认不自动调度；用户显式开始/重试后恢复调度，方便体验真实卡片流程。
    if (card && (action === 'start' || action === 'retry')) this.demoBoards.delete(boardId);
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
      case 'resolve': {
        must('done');
        if (!card.result?.mergeError) throw new Error('这张卡没有待解决的合并冲突');
        const files = card.result.conflictFiles ?? [];
        const base = board.baseBranch ?? '基准分支';
        card.reviewNote =
          `合并到 ${base} 时发生冲突${files.length ? `，冲突文件：\n${files.map((file) => `- ${file}`).join('\n')}` : ''}\n\n` +
          `请在你当前的 worktree 里解决这些冲突：先 \`git merge ${base}\`（如果提示已是最新或状态不对，用 \`git status\` 查看），` +
          `手工编辑解决冲突后 \`git add\` 并提交；不要切换分支、不要动主仓库工作区。完成后说明你改了哪些冲突。`;
        card.attempts = 0;
        delete card.error;
        this.setStatus(board, card, 'queued');
        break;
      }
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

  private mergeCard(board: Board, card: BoardCard, strategy: 'merge' | 'squash'): Promise<{ ok: boolean; error?: string; conflicts?: string[] }> {
    const run = async (): Promise<{ ok: boolean; error?: string; conflicts?: string[] }> => {
      if (!card.sessionId || !card.result?.branch) return { ok: false, error: '该卡片没有可合并的分支' };
      if (card.result.mergedAt) return { ok: true };
      let result: { ok: boolean; error?: string; conflicts?: string[] };
      try {
        result = await this.host.mergeSessionWorktree(card.sessionId, strategy);
      } catch (err) {
        result = { ok: false, error: errorMessage(err) };
      }
      if (card.result) {
        if (result.ok) {
          card.result.mergedAt = Date.now();
          delete card.result.mergeError;
          delete card.result.conflictFiles;
        } else {
          card.result.mergeError = result.error ?? '合并失败';
          if (result.conflicts && result.conflicts.length > 0) card.result.conflictFiles = result.conflicts;
          else delete card.result.conflictFiles;
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

  // ---------- 运行时提议卡片 ----------

  /** ProposeCards 工具入口：卡片会话提议的后续工作落成草稿；看板设置允许时少量提议直接排队。 */
  async proposeFromSession(rec: SessionRecord, input: unknown): Promise<ToolResult> {
    if (!rec.board) return { content: '当前会话不是任务看板卡片，不能提议卡片', isError: true };
    const board = this.boards.get(rec.board.boardId);
    if (!board) return { content: '看板已删除，无法提议卡片', isError: true };
    const source = board.cards.find((card) => card.id === rec.board!.cardId);
    if (!source) return { content: '来源卡片已删除，无法提议卡片', isError: true };
    const rawCards =
      input && typeof input === 'object' && Array.isArray((input as Record<string, unknown>).cards)
        ? ((input as Record<string, unknown>).cards as unknown[])
        : [];
    if (rawCards.length === 0) return { content: 'cards 不能为空', isError: true };
    if (rawCards.length > 12) return { content: '一次最多提议 12 张卡片', isError: true };

    const parsed = rawCards.map((item) => {
      const raw = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : '';
      const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
      const dependsOn = Array.isArray(raw.dependsOn)
        ? raw.dependsOn.filter((dep): dep is string => typeof dep === 'string' && dep.trim() !== '').map((dep) => dep.trim())
        : [];
      return { title, prompt, dependsOn };
    });
    for (const item of parsed) {
      if (!item.title || !item.prompt) return { content: '每张提议卡都需要 title 与 prompt', isError: true };
    }

    // 同一来源卡 + 相同标题的未执行提议视为重复（回合重试时模型可能再次调用）
    const duplicates = parsed.filter((item) =>
      board.cards.some(
        (card) =>
          card.proposedByCardId === source.id &&
          card.title === item.title &&
          (card.status === 'todo' || card.status === 'queued'),
      ),
    );
    const fresh = parsed.filter((item) => !duplicates.includes(item));
    if (fresh.length === 0) {
      return { content: `这些提议已存在（${duplicates.map((item) => item.title).join('、')}），未重复创建。` };
    }

    const idOf = new Map<string, string>();
    fresh.forEach((item, index) => idOf.set(`#${index + 1}`, randomUUID()));
    const resolveDep = (dep: string, self: string): string | undefined => {
      const index = /^\d+$/.test(dep) ? Number(dep) - 1 : -1;
      if (index >= 0 && index < fresh.length) {
        const id = idOf.get(`#${index + 1}`)!;
        return id === self ? undefined : id;
      }
      const proposed = fresh.find((item) => item.title.toLowerCase() === dep.toLowerCase());
      if (proposed) {
        const id = idOf.get(`#${fresh.indexOf(proposed) + 1}`)!;
        return id === self ? undefined : id;
      }
      const existing = board.cards.find((card) => card.id === dep || card.title.toLowerCase() === dep.toLowerCase());
      return existing && existing.id !== self ? existing.id : undefined;
    };

    const now = Date.now();
    const created: BoardCard[] = [];
    for (const [index, item] of fresh.entries()) {
      const id = idOf.get(`#${index + 1}`)!;
      const deps: string[] = [];
      for (const dep of item.dependsOn) {
        const resolved = resolveDep(dep, id);
        if (!resolved) {
          return { content: `无法解析 「${item.title}」 的依赖：${dep}（可用同批标题/序号或看板已有卡标题/id）`, isError: true };
        }
        if (!deps.includes(resolved)) deps.push(resolved);
      }
      created.push({
        id,
        title: item.title,
        prompt: item.prompt,
        deps,
        status: 'todo',
        order: 0,
        exec: {},
        attempts: 0,
        proposedBy: source.title,
        proposedByCardId: source.id,
        createdAt: now,
        updatedAt: now,
      });
    }
    // 依赖成环（含与已有卡的环）直接拒绝，不留半成品
    for (const card of created) {
      if (wouldCycle([...board.cards, ...created.filter((item) => item.id !== card.id)], card.id, card.deps)) {
        return { content: `提议的依赖形成了环（${card.title}）`, isError: true };
      }
    }

    const autoMax = clampAutoAccept(board.autoAcceptProposals);
    const auto = autoMax > 0 && created.length <= autoMax;
    for (const card of created) {
      card.status = auto ? 'queued' : 'todo';
      board.cards.push(card);
    }
    // 新卡放在目标列顶部（按输入顺序）
    for (const status of ['todo', 'queued'] as const) {
      const group = created.filter((card) => card.status === status);
      if (group.length === 0) continue;
      const min = Math.min(1000, ...board.cards.filter((card) => card.status === status && !group.includes(card)).map((card) => card.order));
      group.forEach((card, index) => {
        card.order = min - (group.length - index) * 1000;
      });
    }
    this.commit(board);
    this.kick();
    if (!auto) {
      this.notify(
        board,
        source,
        'proposal',
        `「${source.title}」提议了 ${created.length} 张后续卡片：${created.map((card) => card.title).join('、')}`,
      );
    }
    const dupNote = duplicates.length > 0 ? `；跳过 ${duplicates.length} 张重复提议` : '';
    return {
      content: auto
        ? `已自动接受并排队 ${created.length} 张卡：${created.map((card) => card.title).join('、')}${dupNote}`
        : `已创建 ${created.length} 张待确认提议（在看板待办列顶部，标注「由 ${source.title} 提议」）：${created.map((card) => card.title).join('、')}${dupNote}`,
    };
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

  // ---------- 聚合 PR ----------

  /** 选若干已完成卡，按依赖顺序合到集成分支并开 PR（gh/glab）。 */
  async openPr(boardId: string, cardIds: unknown, base?: unknown): Promise<import('@tandem/protocol').BoardPrResult> {
    const board = this.require(boardId);
    const result = await openBoardPr(this.host, board, cardIds, base);
    if (result.ok && result.pr) {
      board.pr = result.pr;
      this.prRefreshedAt.set(board.id, Date.now());
      this.commit(board);
    }
    return result;
  }

  /** 立即用 gh/glab 刷新聚合 PR 状态。 */
  async refreshPr(boardId: string): Promise<{ pr?: import('@tandem/protocol').BoardPrState }> {
    const board = this.require(boardId);
    const pr = await refreshBoardPr(board);
    if (pr) {
      board.pr = pr;
      this.prRefreshedAt.set(board.id, Date.now());
      this.commit(board);
    }
    return pr ? { pr } : {};
  }

  /** 每 60 秒刷新一次有 PR 的看板；状态/CI 变化由 board_updated 推给客户端。 */
  private maybeRefreshPr(board: Board): void {
    if (!board.pr?.branch) return;
    if (board.pr.state === 'MERGED' || board.pr.state === 'CLOSED') return;
    const last = this.prRefreshedAt.get(board.id) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.prRefreshedAt.set(board.id, Date.now());
    void refreshBoardPr(board)
      .then((pr) => {
        if (!pr) return;
        const before = JSON.stringify(board.pr ?? null);
        board.pr = pr;
        if (before !== JSON.stringify(pr)) this.commit(board);
      })
      .catch(() => undefined);
  }

  private tick(): void {
    for (const board of this.boards.values()) {
      if (this.demoBoards.has(board.id)) continue;
      try {
        this.reconcile(board);
        this.schedule(board);
        this.maybeFinished(board);
        this.refreshDerived(board, true);
        this.maybeRefreshPr(board);
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
      ...(config.autoRoute ? { autoRoute: true } : {}),
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
    const wantAiReview = (card.exec.aiReview ?? board.defaults.aiReview) && !!rec.worktree && !!card.baseCommit;
    if (wantAiReview) {
      const started = this.host.aiReviews.start(rec, undefined, { base: card.baseCommit });
      let review = started;
      // 评审在后台只读子会话里跑；等它结束再决定卡片去向（有 blocker 停在待评审）
      for (let i = 0; i < 400; i += 1) {
        const current = this.host.aiReviews.get(rec.id, started.id);
        if (current && current.status !== 'running') {
          review = current;
          break;
        }
        await sleep(500);
      }
      card.review = review;
      result.costUsd = rec.usage.costUsd ?? result.costUsd;
      card.updatedAt = Date.now();
      this.commit(board);
    }
    const blocker = card.review?.status === 'done' && card.review.verdict === 'blocker';
    if ((card.exec.gate ?? board.defaults.gate) || blocker) {
      this.setStatus(board, card, 'review');
      this.commit(board);
      this.notify(
        board,
        card,
        'review',
        blocker ? `「${card.title}」已完成，AI 评审发现阻塞问题，等待你处理` : `「${card.title}」已完成，等待你评审`,
      );
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

  private notify(board: Board, card: BoardCard | undefined, event: 'review' | 'failed' | 'finished' | 'proposal', text: string): void {
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
