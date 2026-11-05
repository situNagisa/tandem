// 会话持久化：sessions/<id>.json，写盘节流。
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PermissionMode, SessionEnv } from '@tandem/protocol';
import type { SessionRecord } from './types.js';

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
      ...(typeof usage.costUsd === 'number' ? { costUsd: usage.costUsd } : {}),
    },
    allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools : [],
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  };
  if (raw.pinned === true) rec.pinned = true;
  else delete rec.pinned;
  if (raw.archived === true) rec.archived = true;
  else delete rec.archived;
  const env = normalizeEnv(raw.env);
  if (env) rec.env = env;
  else delete rec.env;
  return rec;
}

function normalizeEnv(value: unknown): SessionEnv | undefined {
  if (!value || typeof value !== 'object') return undefined;
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
      const data = JSON.stringify(rec, null, 2);
      await writeFileAtomic(tmp, file, data);
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

async function writeFileAtomic(tmp: string, file: string, data: string): Promise<void> {
  const { writeFile, rename } = await import('node:fs/promises');
  await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}
