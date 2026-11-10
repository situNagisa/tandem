// 分享记录的持久化：元数据写 ~/.tandem/shares.json，快照单独放 shares/<id>.json。
// token 只保存 SHA-256 哈希，明文仅在创建响应里出现一次；访问日志只留在内存。
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { PublicShare, ShareExpiry, ShareInfo } from '@tandem/protocol';
import { ensureDir, readJson, writePrivateFile } from '../config.js';
import { hashToken, tokenMatchesHash } from '../auth/token.js';

export interface ShareMeta {
  id: string;
  sessionId: string;
  sessionTitle: string;
  tokenHash: string;
  createdAt: number;
  expiresAt?: number;
  includeToolOutputs: boolean;
  hidePaths: boolean;
  snapshot: boolean;
  accessCount: number;
  lastAccessAt?: number;
}

interface SharesFile {
  version: 1;
  shares: ShareMeta[];
}

export interface AccessEntry {
  at: number;
  ip: string;
}

const EXPIRY_MS: Record<Exclude<ShareExpiry, 'never'>, number> = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

export function expiryToTime(expiry: ShareExpiry | undefined, now = Date.now()): number | undefined {
  const mode = expiry ?? '7d';
  if (mode === 'never') return undefined;
  return now + EXPIRY_MS[mode];
}

function isShareMeta(value: unknown): value is ShareMeta {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    typeof raw.sessionId === 'string' &&
    typeof raw.sessionTitle === 'string' &&
    typeof raw.tokenHash === 'string' &&
    typeof raw.createdAt === 'number' &&
    typeof raw.includeToolOutputs === 'boolean' &&
    typeof raw.hidePaths === 'boolean' &&
    typeof raw.snapshot === 'boolean' &&
    typeof raw.accessCount === 'number'
  );
}

export class ShareStore {
  private readonly file: string;
  private readonly snapshotDir: string;
  private readonly metas = new Map<string, ShareMeta>();
  private readonly accessLogs = new Map<string, AccessEntry[]>();
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly home: string) {
    this.file = path.join(home, 'shares.json');
    this.snapshotDir = path.join(home, 'shares');
    const data = readJson<SharesFile>(this.file);
    for (const meta of data?.shares ?? []) {
      if (isShareMeta(meta)) this.metas.set(meta.id, meta);
    }
  }

  create(input: {
    sessionId: string;
    sessionTitle: string;
    expiresIn?: ShareExpiry;
    includeToolOutputs: boolean;
    hidePaths: boolean;
    snapshot: boolean;
  }): { meta: ShareMeta; token: string } {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const meta: ShareMeta = {
      id: randomUUID(),
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle || '未命名会话',
      tokenHash: hashToken(token),
      createdAt: now,
      ...(input.expiresIn && input.expiresIn !== 'never'
        ? { expiresAt: expiryToTime(input.expiresIn, now) }
        : {}),
      includeToolOutputs: input.includeToolOutputs,
      hidePaths: input.hidePaths,
      snapshot: input.snapshot,
      accessCount: 0,
    };
    this.metas.set(meta.id, meta);
    this.saveNow();
    return { meta, token };
  }

  get(id: string): ShareMeta | undefined {
    return this.metas.get(id);
  }

  list(): ShareMeta[] {
    return [...this.metas.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  remove(id: string): boolean {
    if (!this.metas.delete(id)) return false;
    this.accessLogs.delete(id);
    try {
      rmSync(this.snapshotFile(id), { force: true });
    } catch {
      // 快照文件不存在或 Windows 占用时忽略；入口已 404
    }
    this.saveNow();
    return true;
  }

  /** 校验 token；countAccess=false 用于实时轮询，避免把 3 秒一次刷新算成一次访问。 */
  verify(id: string, token: string, ip: string, countAccess = true): ShareMeta | undefined {
    const meta = this.metas.get(id);
    if (!meta || !token) return undefined;
    if (!tokenMatchesHash(token, meta.tokenHash)) return undefined;
    if (this.isExpired(meta)) return undefined;
    const now = Date.now();
    if (countAccess) {
      meta.accessCount += 1;
      meta.lastAccessAt = now;
      const logs = this.accessLogs.get(id) ?? [];
      logs.push({ at: now, ip });
      if (logs.length > 20) logs.splice(0, logs.length - 20);
      this.accessLogs.set(id, logs);
      this.saveSoon();
    }
    return meta;
  }

  isExpired(meta: ShareMeta, now = Date.now()): boolean {
    return typeof meta.expiresAt === 'number' && meta.expiresAt <= now;
  }

  info(meta: ShareMeta): ShareInfo {
    return {
      id: meta.id,
      sessionId: meta.sessionId,
      sessionTitle: meta.sessionTitle,
      createdAt: meta.createdAt,
      ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}),
      expired: this.isExpired(meta),
      includeToolOutputs: meta.includeToolOutputs,
      hidePaths: meta.hidePaths,
      snapshot: meta.snapshot,
      accessCount: meta.accessCount,
      ...(meta.lastAccessAt ? { lastAccessAt: meta.lastAccessAt } : {}),
    };
  }

  readSnapshot(id: string): PublicShare | undefined {
    return readJson<PublicShare>(this.snapshotFile(id));
  }

  writeSnapshot(id: string, data: PublicShare): void {
    ensureDir(this.snapshotDir);
    writePrivateFile(this.snapshotFile(id), JSON.stringify(data));
  }

  private snapshotFile(id: string): string {
    return path.join(this.snapshotDir, `${id}.json`);
  }

  /** 访问计数不必每次轮询都落盘，攒 30 秒写一次。 */
  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, 30_000);
    this.saveTimer.unref?.();
  }

  flush(): void {
    this.saveNow();
  }

  private saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const data: SharesFile = { version: 1, shares: [...this.metas.values()] };
    writePrivateFile(this.file, JSON.stringify(data, null, 2));
  }
}

