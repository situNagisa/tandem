// 会话持久化：sessions/<id>.json，写盘节流。
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
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
  if (raw.pinnedInProject === true) rec.pinnedInProject = true;
  else delete rec.pinnedInProject;
  if (Array.isArray(raw.pinnedTurns)) {
    const ids = [...new Set(
      raw.pinnedTurns.filter((id): id is string => typeof id === 'string' && id.length > 0),
    )].slice(0, 200);
    if (ids.length) rec.pinnedTurns = ids;
    else delete rec.pinnedTurns;
  } else {
    delete rec.pinnedTurns;
  }
  if (raw.aiReviewUsage && typeof raw.aiReviewUsage === 'object') {
    const review = raw.aiReviewUsage as unknown as Record<string, unknown>;
    rec.aiReviewUsage = {
      inputTokens: num(review.inputTokens),
      outputTokens: num(review.outputTokens),
      ...(typeof review.cacheReadTokens === 'number' ? { cacheReadTokens: num(review.cacheReadTokens) } : {}),
      ...(typeof review.cacheWriteTokens === 'number' ? { cacheWriteTokens: num(review.cacheWriteTokens) } : {}),
      ...(typeof review.reasoningTokens === 'number' ? { reasoningTokens: num(review.reasoningTokens) } : {}),
      ...(typeof review.costUsd === 'number' ? { costUsd: review.costUsd } : {}),
    };
  } else {
    delete rec.aiReviewUsage;
  }
  if (raw.archived === true) rec.archived = true;
  else delete rec.archived;
  if (raw.unread === true) rec.unread = true;
  else delete rec.unread;
  const env = normalizeEnv(raw.env);
  if (env) rec.env = env;
  else delete rec.env;
  if (typeof raw.groupId === 'string' && raw.groupId) rec.groupId = raw.groupId;
  else delete rec.groupId;
  if (
    raw.delegation === 'orchestrate' ||
    raw.delegation === 'more' ||
    raw.delegation === 'less' ||
    raw.delegation === 'none'
  ) {
    rec.delegation = raw.delegation;
  } else {
    delete rec.delegation;
  }
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

interface PersistState {
  /** 已写入消息日志的条数（按消息 id 幂等重放）。 */
  count: number;
  /** 最后一条已写入消息的 JSON，用于检测原地更新。 */
  lastJson: string;
  snapshotBytes: number;
  appendedBytes: number;
}

export class SessionStore {
  private dir: string;
  private records = new Map<string, SessionRecord>();
  private timers = new Map<string, NodeJS.Timeout>();
  private saving = new Set<string>();
  /** 每次变更递增：异步写盘在 rename 前发现版本变化会重写最新内容，避免旧快照覆盖。 */
  private versions = new Map<string, number>();
  /** 消息分段日志的落盘进度：已写入条数、最后一条的内容、是否已迁移。 */
  private persistState = new Map<string, PersistState>();
  /** Host 注入：会话写入后增量更新全文索引。 */
  onDirty?: (rec: SessionRecord) => void;
  /** Host 注入：会话删除后清理全文索引。 */
  onDelete?: (id: string) => void;

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
        const raw = JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')) as SessionRecord & {
          messagesFormat?: string;
        };
        if (!raw || typeof raw.id !== 'string') continue;
        if (raw.messagesFormat === 'jsonl') {
          const messages = this.readMessageLog(raw.id);
          // 分段日志缺失/损坏时回退到 JSON 里可能残留的消息
          raw.messages = messages ?? (Array.isArray(raw.messages) ? raw.messages : []);
        }
        const rec = normalizeRecord(raw);
        this.records.set(rec.id, rec);
        if (raw.messagesFormat === 'jsonl') {
          this.persistState.set(rec.id, this.stateOf(rec, true));
        }
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
    for (const file of [this.fileOf(id), this.logFileOf(id)]) {
      try {
        rmSync(file, { force: true });
      } catch {
        // ignore
      }
    }
    this.onDelete?.(id);
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
    this.onDirty?.(rec);
  }

  /**
   * 立即落盘并 fsync：模型响应完成、工具结果落账、运行意图变化时调用。
   * 消息写入 <id>.jsonl 追加日志，元数据单独写小 JSON，避免每次整份重写。
   */
  saveNow(id: string): void {
    const rec = this.records.get(id);
    if (!rec) return;
    this.onDirty?.(rec);
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    try {
      const state = this.persistState.get(id);
      if (!state) this.persistFullSync(id, rec);
      else this.persistIncrementalSync(id, rec, state);
    } catch (err) {
      console.error(`[tandem] 立即保存会话 ${id} 失败:`, (err as Error).message);
    }
  }

  async write(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) return;
    if (this.saving.has(id)) {
      // 正在写，稍后再写一次，保证最后一次状态落盘
      this.markDirty(id, false);
      return;
    }
    this.saving.add(id);
    try {
      const state = this.persistState.get(id);
      if (!state) await this.persistFull(id, rec);
      else await this.persistIncremental(id, rec, state);
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
      try {
        const state = this.persistState.get(id);
        if (!state) this.persistFullSync(id, rec);
        else this.persistIncrementalSync(id, rec, state);
      } catch (err) {
        console.error(`[tandem] 退出时保存会话 ${id} 失败:`, (err as Error).message);
      }
    }
  }

  // ---------- 分段消息日志（<id>.jsonl，每行一批消息；同 id 后者覆盖前者） ----------

  private readMessageLog(id: string): SessionRecord['messages'] | undefined {
    let text: string;
    try {
      text = readFileSync(this.logFileOf(id), 'utf8');
    } catch {
      return undefined;
    }
    const messages: SessionRecord['messages'] = [];
    const index = new Map<string, number>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: { messages?: unknown } & Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as { messages?: unknown } & Record<string, unknown>;
      } catch {
        continue; // 容忍崩溃导致的最后半行
      }
      // 快照行直接是一条消息，增量行是 { messages: [...] }
      const batch = Array.isArray(parsed.messages)
        ? parsed.messages
        : typeof parsed.id === 'string' && typeof parsed.role === 'string'
          ? [parsed]
          : [];
      for (const message of batch) {
        if (!message || typeof message !== 'object') continue;
        const item = message as SessionRecord['messages'][number];
        if (typeof item.id !== 'string') continue;
        const at = index.get(item.id);
        if (at === undefined) {
          index.set(item.id, messages.length);
          messages.push(item);
        } else {
          messages[at] = item;
        }
      }
    }
    return messages;
  }

  /** 元数据文件：不含消息正文，只有会话摘要/运行意图等小字段。 */
  private metaJson(rec: SessionRecord): string {
    return JSON.stringify({ ...rec, messages: [], messagesFormat: 'jsonl' }, null, 2);
  }

  private persistFullSync(id: string, rec: SessionRecord): void {
    const logFile = this.logFileOf(id);
    const logTmp = `${logFile}.${process.pid}.save.tmp`;
    const messages = rec.messages;
    let bytes = 0;
    let payload = '';
    for (const message of messages) {
      const line = `${JSON.stringify(message)}\n`;
      payload += line;
      bytes += Buffer.byteLength(line);
    }
    writeFileSyncFully(logTmp, payload);
    renameSync(logTmp, logFile);
    this.writeMetaSync(id, rec);
    this.persistState.set(id, {
      count: messages.length,
      lastJson: messages.length ? JSON.stringify(messages[messages.length - 1]) : '',
      snapshotBytes: bytes,
      appendedBytes: 0,
    });
    fsyncDir(path.dirname(logFile));
  }

  private persistIncrementalSync(id: string, rec: SessionRecord, state: PersistState): void {
    if (rec.messages.length < state.count) {
      this.persistFullSync(id, rec);
      return;
    }
    const changedLast =
      state.count > 0 &&
      JSON.stringify(rec.messages[state.count - 1] ?? null) !== state.lastJson;
    const start = changedLast ? state.count - 1 : state.count;
    const chunk = rec.messages.slice(start);
    if (chunk.length) {
      const line = `${JSON.stringify({ messages: chunk })}\n`;
      appendSyncFully(this.logFileOf(id), line);
      state.appendedBytes += Buffer.byteLength(line);
    }
    state.count = rec.messages.length;
    state.lastJson = rec.messages.length
      ? JSON.stringify(rec.messages[rec.messages.length - 1])
      : '';
    this.writeMetaSync(id, rec);
    this.maybeCompactSync(id, rec, state);
  }

  private async persistFull(id: string, rec: SessionRecord): Promise<void> {
    const logFile = this.logFileOf(id);
    const logTmp = `${logFile}.${process.pid}.tmp`;
    const messages = rec.messages;
    let bytes = 0;
    const lines = messages.map((message) => {
      const line = `${JSON.stringify(message)}\n`;
      bytes += Buffer.byteLength(line);
      return line;
    });
    await writeFile(logTmp, lines.join(''), { encoding: 'utf8', mode: 0o600 });
    renameSync(logTmp, logFile);
    await this.writeMeta(id, rec);
    this.persistState.set(id, {
      count: messages.length,
      lastJson: messages.length ? JSON.stringify(messages[messages.length - 1]) : '',
      snapshotBytes: bytes,
      appendedBytes: 0,
    });
  }

  private async persistIncremental(id: string, rec: SessionRecord, state: PersistState): Promise<void> {
    if (rec.messages.length < state.count) {
      await this.persistFull(id, rec);
      return;
    }
    const changedLast =
      state.count > 0 &&
      JSON.stringify(rec.messages[state.count - 1] ?? null) !== state.lastJson;
    const start = changedLast ? state.count - 1 : state.count;
    const chunk = rec.messages.slice(start);
    if (chunk.length) {
      const line = `${JSON.stringify({ messages: chunk })}\n`;
      await appendFile(this.logFileOf(id), line, { encoding: 'utf8', mode: 0o600 });
      state.appendedBytes += Buffer.byteLength(line);
    }
    state.count = rec.messages.length;
    state.lastJson = rec.messages.length
      ? JSON.stringify(rec.messages[rec.messages.length - 1])
      : '';
    await this.writeMeta(id, rec);
    if (this.shouldCompact(state)) await this.persistFull(id, rec);
  }

  private maybeCompactSync(id: string, rec: SessionRecord, state: PersistState): void {
    if (this.shouldCompact(state)) this.persistFullSync(id, rec);
  }

  /** 追加日志超过快照 1.5 倍且至少 8MB 时压实，避免日志无限增长。 */
  private shouldCompact(state: PersistState): boolean {
    return state.appendedBytes > Math.max(8 * 1024 * 1024, state.snapshotBytes * 1.5);
  }

  private writeMetaSync(id: string, rec: SessionRecord): void {
    const file = this.fileOf(id);
    const tmp = `${file}.${process.pid}.save.tmp`;
    writeFileSyncFully(tmp, this.metaJson(rec));
    renameSync(tmp, file);
  }

  private async writeMeta(id: string, rec: SessionRecord): Promise<void> {
    const file = this.fileOf(id);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, this.metaJson(rec), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  }

  private stateOf(rec: SessionRecord, migrated: boolean): PersistState {
    let snapshotBytes = 0;
    try {
      snapshotBytes = statSync(this.logFileOf(rec.id)).size;
    } catch {
      // ignore
    }
    return {
      count: rec.messages.length,
      lastJson: rec.messages.length ? JSON.stringify(rec.messages[rec.messages.length - 1]) : '',
      snapshotBytes,
      appendedBytes: 0,
    };
  }

  private logFileOf(id: string): string {
    return this.fileOf(id).replace(/\.json$/, '.jsonl');
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

/** 追加一小段并 fsync。 */
function appendSyncFully(file: string, data: string): void {
  const fd = openSync(file, 'a', 0o600);
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
