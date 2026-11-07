// 会话持久化：sessions/<id>.json，写盘节流。
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type { PermissionMode, SessionEnv } from '@tandem/protocol';
import type { RunState, SessionRecord } from './types.js';
import { isInjectedTitle, titleFromMessages } from './external.js';

const SAVE_DELAY_MS = 300;
const PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);

/** 兼容老版本 json：缺失/异常的 SessionSummary 字段回落到默认值。 */
function normalizeRecord(raw: SessionRecord): SessionRecord {
  const usage = (raw.usage ?? {}) as unknown as Record<string, unknown>;
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const rec: SessionRecord = {
    ...raw,
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : '新会话',
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    profileId: typeof raw.profileId === 'string' ? raw.profileId : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    permissionMode: PERMISSION_MODES.has(raw.permissionMode) ? raw.permissionMode : 'default',
    status: 'idle',
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    todos: Array.isArray(raw.todos) ? raw.todos : [],
    usage: {
      inputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      ...(typeof usage.cacheReadTokens === 'number'
        ? { cacheReadTokens: num(usage.cacheReadTokens) }
        : {}),
      ...(typeof usage.cacheWriteTokens === 'number'
        ? { cacheWriteTokens: num(usage.cacheWriteTokens) }
        : {}),
      ...(typeof usage.reasoningTokens === 'number'
        ? { reasoningTokens: num(usage.reasoningTokens) }
        : {}),
      ...(typeof usage.costUsd === 'number' ? { costUsd: usage.costUsd } : {}),
    },
    allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools : [],
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
  if (raw.pinned === true) rec.pinned = true;
  else delete rec.pinned;
  if (Array.isArray(raw.pinnedTurns)) {
    const ids = [...new Set(
      raw.pinnedTurns.filter((id): id is string => typeof id === 'string' && id.length > 0),
    )].slice(0, 200);
    if (ids.length) rec.pinnedTurns = ids;
    else delete rec.pinnedTurns;
  } else {
    delete rec.pinnedTurns;
  }
  if (raw.archived === true) rec.archived = true;
  else delete rec.archived;
  const env = normalizeEnv(raw.env);
  if (env) rec.env = env;
  else delete rec.env;
  if (typeof raw.groupId === 'string' && raw.groupId) rec.groupId = raw.groupId;
  else delete rec.groupId;
  if (typeof raw.parentId === 'string' && raw.parentId) rec.parentId = raw.parentId;
  else delete rec.parentId;
  if (typeof raw.depth === 'number' && Number.isInteger(raw.depth) && raw.depth >= 0) {
    rec.depth = raw.depth;
  } else {
    delete rec.depth;
  }
  const worktree = normalizeWorktree(raw.worktree);
  if (worktree) rec.worktree = worktree;
  else delete rec.worktree;
  if (typeof raw.systemPromptExtra === 'string' && raw.systemPromptExtra) {
    rec.systemPromptExtra = raw.systemPromptExtra;
  } else {
    delete rec.systemPromptExtra;
  }
  if (Array.isArray(raw.toolWhitelist)) {
    const tools = raw.toolWhitelist.filter((item): item is string => typeof item === 'string' && !!item);
    if (tools.length) rec.toolWhitelist = tools;
    else delete rec.toolWhitelist;
  } else {
    delete rec.toolWhitelist;
  }
  if (typeof raw.worktreeRepoRoot === 'string' && raw.worktreeRepoRoot) {
    rec.worktreeRepoRoot = raw.worktreeRepoRoot;
  } else {
    delete rec.worktreeRepoRoot;
  }
  // worktree 会话的环境应指向原仓库：否则侧栏/顶栏会把 worktree 目录 basename
  // 当成项目名（例如 "cache"），与同一仓库的普通会话分成两组。
  if (rec.worktree && rec.worktreeRepoRoot) {
    rec.env = {
      repoRoot: rec.worktreeRepoRoot,
      repoName: path.basename(rec.worktreeRepoRoot),
      branch: rec.worktree.branch,
    };
  }
  const plan = normalizePlan(raw.plan);
  if (plan) rec.plan = plan;
  else delete rec.plan;
  const fork = raw.forkedFrom as
    | { sessionId?: unknown; messageId?: unknown; title?: unknown }
    | undefined;
  if (fork && typeof fork.sessionId === 'string' && fork.sessionId) {
    rec.forkedFrom = {
      sessionId: fork.sessionId,
      ...(typeof fork.messageId === 'string' && fork.messageId
        ? { messageId: fork.messageId }
        : {}),
      ...(typeof fork.title === 'string' && fork.title ? { title: fork.title } : {}),
    };
  } else {
    delete rec.forkedFrom;
  }
  const from = raw.importedFrom as { source?: unknown; id?: unknown } | undefined;
  if (from && (from.source === 'claude-code' || from.source === 'codex') && typeof from.id === 'string' && from.id) {
    rec.importedFrom = { source: from.source, id: from.id };
  } else {
    delete rec.importedFrom;
  }
  const runState = normalizeRunState(raw.runState);
  if (runState) rec.runState = runState;
  else delete rec.runState;
  if (raw.resumePaused === true) rec.resumePaused = true;
  else delete rec.resumePaused;
  return rec;
}

/** 兼容老版本/损坏数据：runState 字段逐一校验，非法条目丢弃。 */
function normalizeRunState(value: unknown): RunState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return undefined;
  const permissions = Array.isArray(raw.pendingPermissions)
    ? raw.pendingPermissions.filter(
        (item): item is RunState['pendingPermissions'][number] =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as { id?: unknown }).id === 'string' &&
          typeof (item as { toolUseId?: unknown }).toolUseId === 'string' &&
          typeof (item as { toolName?: unknown }).toolName === 'string',
      )
    : [];
  const queue = Array.isArray(raw.queue)
    ? raw.queue.filter((item): item is RunState['queue'][number] => Array.isArray(item))
    : [];
  const inFlightTools = Array.isArray(raw.inFlightTools)
    ? raw.inFlightTools.filter(
        (item): item is RunState['inFlightTools'][number] =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as { id?: unknown }).id === 'string' &&
          typeof (item as { name?: unknown }).name === 'string',
      )
    : [];
  return {
    version: 1,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    ...(typeof raw.turnMessageId === 'string' && raw.turnMessageId
      ? { turnMessageId: raw.turnMessageId }
      : {}),
    completedMessages: Array.isArray(raw.completedMessages)
      ? raw.completedMessages.filter((id): id is string => typeof id === 'string').slice(-100)
      : [],
    queue,
    inFlightTools,
    pendingPermissions: permissions,
    phase: raw.phase === 'tools' ? 'tools' : 'model',
    permissionMode: PERMISSION_MODES.has(raw.permissionMode as PermissionMode)
      ? (raw.permissionMode as PermissionMode)
      : 'default',
    ...(typeof raw.assistantMessageId === 'string' && raw.assistantMessageId
      ? { assistantMessageId: raw.assistantMessageId }
      : {}),
  };
}

function normalizePlan(value: unknown): SessionRecord['plan'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.content !== 'string' || !raw.content.trim()) return undefined;
  const status =
    raw.status === 'approved' || raw.status === 'rejected' || raw.status === 'pending'
      ? raw.status
      : 'pending';
  const approvalMode =
    raw.approvalMode === 'acceptEdits' || raw.approvalMode === 'default'
      ? raw.approvalMode
      : undefined;
  return {
    content: raw.content,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    status,
    ...(approvalMode ? { approvalMode } : {}),
  };
}

function normalizeWorktree(
  value: unknown,
): { path: string; branch: string; baseBranch: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.path !== 'string' ||
    !raw.path ||
    typeof raw.branch !== 'string' ||
    !raw.branch ||
    typeof raw.baseBranch !== 'string' ||
    !raw.baseBranch
  ) {
    return undefined;
  }
  return { path: raw.path, branch: raw.branch, baseBranch: raw.baseBranch };
}

function normalizeEnv(value: unknown): SessionEnv | undefined {  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const env: SessionEnv = {};
  if (typeof raw.repoRoot === 'string' && raw.repoRoot) env.repoRoot = raw.repoRoot;
  if (typeof raw.repoName === 'string' && raw.repoName) env.repoName = raw.repoName;
  if (typeof raw.branch === 'string' && raw.branch) env.branch = raw.branch;
  return env.repoRoot || env.repoName || env.branch ? env : undefined;
}

export class SessionStore {
  private dir: string;
  private records = new Map<string, SessionRecord>();
  private timers = new Map<string, NodeJS.Timeout>();
  private saving = new Set<string>();
  /** 每次变更递增：异步写盘在 rename 前发现版本变化会重写最新内容，避免旧快照覆盖。 */
  private versions = new Map<string, number>();

  constructor(home: string) {
    this.dir = path.join(home, 'sessions');
    mkdirSync(this.dir, { recursive: true });
    this.loadAll();
  }

  private loadAll(): void {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')) as SessionRecord;
        if (!raw || typeof raw.id !== 'string') continue;
        const rec = normalizeRecord(raw);
        this.records.set(rec.id, rec);
      } catch (err) {
        console.warn(`[tandem] 跳过损坏的会话文件 ${file}:`, (err as Error).message);
      }
    }
    this.inferDepths();
    this.repairInjectedTitles();
  }

  /**
   * 旧版本导入外部会话时可能把注入文本（AGENTS.md、CODEGRAPH 等）存成标题；
   * 启动时只修一次：按已有消息重新生成，找不到真实用户文本则退回项目名 + 日期。
   */
  private repairInjectedTitles(): void {
    for (const rec of this.records.values()) {
      if (!isInjectedTitle(rec.title)) continue;
      rec.title = titleFromMessages(rec.messages, rec.cwd, rec.createdAt);
      this.markDirty(rec.id, false);
    }
  }

  /** 旧数据没有 depth：沿 parentId 链推算（主会话为 0）。 */
  private inferDepths(): void {
    for (const rec of this.records.values()) {
      if (rec.depth !== undefined) continue;
      let depth = 0;
      let cursor: SessionRecord | undefined = rec;
      const seen = new Set<string>([rec.id]);
      while (cursor?.parentId && !seen.has(cursor.parentId)) {
        seen.add(cursor.parentId);
        depth++;
        cursor = this.records.get(cursor.parentId);
      }
      rec.depth = depth;
      this.markDirty(rec.id, false);
    }
  }

  list(): SessionRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  add(rec: SessionRecord): void {
    this.records.set(rec.id, rec);
    this.markDirty(rec.id, false);
  }

  delete(id: string): void {
    this.records.delete(id);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    try {
      rmSync(this.fileOf(id), { force: true });
    } catch {
      // ignore
    }
  }

  /** 标记需要写盘；bump 为 true 时更新 updatedAt（用户/助手消息、元数据变更）。 */
  markDirty(id: string, bump: boolean): void {
    const rec = this.records.get(id);
    if (!rec) return;
    if (bump) rec.updatedAt = Date.now();
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.write(id);
      }, SAVE_DELAY_MS),
    );
  }

  /**
   * 立即原子落盘并 fsync：模型响应完成、工具结果落账、运行意图变化时调用。
   * 同步写保证在继续执行下一步之前数据已到磁盘（进程被 kill -9 也不丢）。
   */
  saveNow(id: string): void {
    const rec = this.records.get(id);
    if (!rec) return;
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const file = this.fileOf(id);
    const tmp = `${file}.${process.pid}.save.tmp`;
    try {
      writeFileSyncFully(tmp, JSON.stringify(rec, null, 2));
      renameSync(tmp, file);
      fsyncDir(path.dirname(file));
    } catch (err) {
      console.error(`[tandem] 立即保存会话 ${id} 失败:`, (err as Error).message);
    }
  }

  async write(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec || this.saving.has(id)) {
      if (rec && this.saving.has(id)) {
        // 正在写，稍后再写一次，保证最后一次状态落盘
        this.markDirty(id, false);
      }
      return;
    }
    this.saving.add(id);
    const file = this.fileOf(id);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      let data = JSON.stringify(rec, null, 2);
      // 写临时文件期间可能有 saveNow 落地：rename 前核对版本，避免旧快照覆盖新状态
      for (let attempt = 0; attempt < 3; attempt++) {
        const version = this.versions.get(id) ?? 0;
        await writeFileAtomic(tmp, data);
        if (version === (this.versions.get(id) ?? 0)) break;
        const latest = this.records.get(id);
        if (latest) data = JSON.stringify(latest, null, 2);
      }
      renameSync(tmp, file);
    } catch (err) {
      console.error(`[tandem] 保存会话 ${id} 失败:`, (err as Error).message);
    } finally {
      this.saving.delete(id);
    }
  }

  /** 进程退出时同步落盘所有待写会话。 */
  flush(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(id);
      const rec = this.records.get(id);
      if (!rec) continue;
      const file = this.fileOf(id);
      try {
        writeFileSync(`${file}.${process.pid}.flush.tmp`, JSON.stringify(rec, null, 2), { mode: 0o600 });
        renameSync(`${file}.${process.pid}.flush.tmp`, file);
      } catch (err) {
        console.error(`[tandem] 退出时保存会话 ${id} 失败:`, (err as Error).message);
      }
    }
  }

  private fileOf(id: string): string {
    // id 由服务端生成（uuid），这里再兜底防路径穿越
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }
}

async function writeFileAtomic(tmp: string, data: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
}

/** 同步写临时文件并 fsync，保证内容真正落盘（rename 前调用）。 */
function writeFileSyncFully(file: string, data: string): void {
  const fd = openSync(file, 'w', 0o600);
  try {
    writeSync(fd, data, 0, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 目录 fsync：让 rename 本身也持久化；部分平台（Windows）不支持，忽略错误。 */
function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Windows / 特殊文件系统不支持目录 fsync
  }
}
