// 检查点：每轮开始时创建，Write/Edit 前把文件原内容快照到 ~/.tandem/checkpoints/<session>/<cp>/。
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { Checkpoint } from '@tandem/protocol';
import { isSubPath, toPosix } from './util/path.js';

/** 检查点保留时长：30 天。 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const META_FILE = 'meta.json';

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class CheckpointStore {
  private dir: string;
  /** 每会话的检查点元数据缓存（按 createdAt 升序）。 */
  private cache = new Map<string, Checkpoint[]>();

  constructor(home: string) {
    this.dir = path.join(home, 'checkpoints');
    mkdirSync(this.dir, { recursive: true });
    this.cleanup();
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.dir, safeId(sessionId));
  }

  private checkpointDir(sessionId: string, checkpointId: string): string {
    return path.join(this.sessionDir(sessionId), safeId(checkpointId));
  }

  private filesDir(sessionId: string, checkpointId: string): string {
    return path.join(this.checkpointDir(sessionId, checkpointId), 'files');
  }

  /** 读取某会话的检查点（从磁盘按需加载，按创建时间升序）。 */
  list(sessionId: string): Checkpoint[] {
    let list = this.cache.get(sessionId);
    if (!list) {
      list = this.loadSession(sessionId);
      this.cache.set(sessionId, list);
    }
    return list.map((cp) => ({ ...cp, files: cp.files.map((f) => ({ ...f })) }));
  }

  get(sessionId: string, checkpointId: string): Checkpoint | undefined {
    return this.list(sessionId).find((cp) => cp.id === checkpointId);
  }

  private loadSession(sessionId: string): Checkpoint[] {
    const dir = this.sessionDir(sessionId);
    let names: string[] = [];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const list: Checkpoint[] = [];
    for (const name of names) {
      const cp = readMeta(path.join(dir, name, META_FILE));
      if (cp && cp.sessionId === sessionId) list.push(cp);
    }
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 每轮开始创建一个空检查点；之后的 Write/Edit 再往里追加文件快照。 */
  create(sessionId: string, messageId: string): Checkpoint {
    const checkpoint: Checkpoint = {
      id: randomUUID(),
      sessionId,
      messageId,
      createdAt: Date.now(),
      files: [],
    };
    mkdirSync(this.filesDir(sessionId, checkpoint.id), { recursive: true });
    this.writeMeta(checkpoint);
    const list = this.cache.get(sessionId) ?? this.loadSession(sessionId);
    list.push(checkpoint);
    this.cache.set(sessionId, list);
    // 返回同一对象：本轮后续 snapshotFile 直接追加到缓存与落盘
    return checkpoint;
  }

  /** 记录文件在当前检查点中的原始内容（before 为 undefined 表示原本不存在）；同一检查点内同一文件只快照一次。 */
  snapshotFile(
    checkpoint: Checkpoint,
    cwd: string,
    absPath: string,
    before: Buffer | undefined,
  ): boolean {
    const rel = path.relative(cwd, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const relPosix = toPosix(rel);
    if (checkpoint.files.some((file) => file.path === relPosix)) return false;

    const existed = before !== undefined;
    if (before !== undefined) {
      const target = path.join(this.filesDir(checkpoint.sessionId, checkpoint.id), relPosix);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, before);
    }
    checkpoint.files.push({ path: relPosix, existed });
    this.writeMeta(checkpoint);
    return true;
  }

  /** 把某个文件快照恢复到原路径（existed=false 表示原本不存在，需要删除）。 */
  restoreFile(checkpoint: Checkpoint, cwd: string, file: { path: string; existed: boolean }): void {
    const abs = path.resolve(cwd, file.path);
    if (!isSubPath(cwd, abs)) return; // 防御：只恢复 cwd 内的文件
    if (!file.existed) {
      rmSync(abs, { force: true, recursive: true });
      return;
    }
    const source = path.join(this.filesDir(checkpoint.sessionId, checkpoint.id), file.path);
    if (!existsSync(source)) return;
    mkdirSync(path.dirname(abs), { recursive: true });
    copyFileSync(source, abs);
  }

  /** 删除该检查点及之后创建的所有检查点（回退后这些快照已被消耗）。 */
  removeFrom(sessionId: string, checkpointId: string): void {
    const list = this.cache.get(sessionId) ?? this.loadSession(sessionId);
    const target = list.find((cp) => cp.id === checkpointId);
    if (!target) return;
    const kept: Checkpoint[] = [];
    for (const cp of list) {
      if (cp.id === target.id || cp.createdAt > target.createdAt) {
        try {
          rmSync(this.checkpointDir(sessionId, cp.id), { recursive: true, force: true });
        } catch {
          // 删除失败不影响回退本身
        }
      } else {
        kept.push(cp);
      }
    }
    this.cache.set(sessionId, kept);
  }

  /** 清理超过保留期的检查点与会话目录。 */
  cleanup(now = Date.now()): void {
    let sessions: string[] = [];
    try {
      sessions = readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return;
    }
    for (const session of sessions) {
      const sessionDir = path.join(this.dir, session);
      let checkpoints: string[] = [];
      try {
        checkpoints = readdirSync(sessionDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      let remaining = 0;
      for (const name of checkpoints) {
        const cp = readMeta(path.join(sessionDir, name, META_FILE));
        const createdAt = cp?.createdAt ?? mtimeOf(path.join(sessionDir, name));
        if (now - createdAt > RETENTION_MS) {
          try {
            rmSync(path.join(sessionDir, name), { recursive: true, force: true });
          } catch {
            remaining++;
          }
        } else {
          remaining++;
        }
      }
      if (remaining === 0) {
        try {
          rmSync(sessionDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  private writeMeta(checkpoint: Checkpoint): void {
    const file = path.join(this.checkpointDir(checkpoint.sessionId, checkpoint.id), META_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(checkpoint, null, 2), 'utf8');
    renameSync(tmp, file);
  }
}

function readMeta(file: string): Checkpoint | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Checkpoint;
    if (!raw || typeof raw.id !== 'string' || typeof raw.sessionId !== 'string') return undefined;
    return {
      id: raw.id,
      sessionId: raw.sessionId,
      messageId: typeof raw.messageId === 'string' ? raw.messageId : '',
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      files: Array.isArray(raw.files)
        ? raw.files
            .filter((f) => f && typeof f.path === 'string')
            .map((f) => ({ path: f.path, existed: f.existed === true }))
        : [],
    };
  } catch {
    return undefined;
  }
}

function mtimeOf(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return Date.now();
  }
}
