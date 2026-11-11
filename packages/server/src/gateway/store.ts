// 自建 Key 网关的数据层：设置、成员令牌（只存哈希）、请求元数据日志、临时调试正文。
// 用量不在这里重复存：网关请求直接写进 UsageStore（带 memberId），预算与用量页共用同一份数据。
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  GatewayLogEntry,
  GatewayModelRoute,
  GatewaySettings,
  GatewayToken,
  GatewayTokenInput,
  GatewayTokenUpdateInput,
} from '@tandem/protocol';
import { readJson, writePrivateFile } from '../config.js';
import { findActiveToken, hashToken } from '../auth/token.js';

/** 调试正文保留 24 小时；无论调试是否仍开启，过期都会在加载/写入时清理。 */
export const GATEWAY_DEBUG_TTL_MS = 24 * 60 * 60 * 1000;
const LOG_LIMIT = 1000;
const DEBUG_LIMIT = 200;

export interface StoredGatewayToken extends GatewayToken {
  tokenHash: string;
}

interface StoredDebugEntry {
  id: string;
  at: number;
  expiresAt: number;
  memberId: string;
  memberName: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  request: string;
  response: string;
}

interface GatewayFile {
  version: 1;
  settings: GatewaySettings;
  tokens: StoredGatewayToken[];
  logs: GatewayLogEntry[];
}

interface GatewayDebugFile {
  version: 1;
  entries: StoredDebugEntry[];
}

const DEFAULT_SETTINGS: GatewaySettings = { enabled: false, routes: [], debugBodies: false };

function publicToken(token: StoredGatewayToken): GatewayToken {
  const { tokenHash: _tokenHash, ...rest } = token;
  return { ...rest, allowedModels: [...rest.allowedModels] };
}

function normalizeRoute(raw: unknown): GatewayModelRoute | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Partial<GatewayModelRoute>;
  const profileId = typeof item.profileId === 'string' ? item.profileId.trim() : '';
  if (!profileId) return undefined;
  const models = Array.isArray(item.models)
    ? [...new Set(item.models.filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim()))]
    : [];
  if (!models.length) return undefined;
  const groupId = typeof item.groupId === 'string' && item.groupId.trim() ? item.groupId.trim() : undefined;
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : randomUUID();
  return { id, profileId, ...(groupId ? { groupId } : {}), models };
}

function normalizeSettings(raw: unknown): GatewaySettings {
  const value = raw && typeof raw === 'object' ? (raw as Partial<GatewaySettings>) : {};
  const routes = Array.isArray(value.routes)
    ? value.routes.map(normalizeRoute).filter((route): route is GatewayModelRoute => !!route)
    : [];
  return {
    enabled: value.enabled === true,
    debugBodies: value.debugBodies === true,
    routes,
  };
}

function finiteLimit(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return Math.round(num * 1e6) / 1e6;
}

function normalizeModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim()))];
}

function positiveInt(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : fallback;
}

export class GatewayStore {
  private file: string;
  private debugFile: string;
  private settings: GatewaySettings = { ...DEFAULT_SETTINGS };
  private tokens: StoredGatewayToken[] = [];
  private logs: GatewayLogEntry[] = [];
  private debugEntries: StoredDebugEntry[] = [];
  private saveTimer?: NodeJS.Timeout;
  private debugSaveTimer?: NodeJS.Timeout;
  /** 速率限制的滑动窗口（内存态，重启清空）：tokenId → 最近 60s 的时间戳。 */
  private rateBuckets = new Map<string, number[]>();

  constructor(home: string) {
    this.file = path.join(home, 'gateway.json');
    this.debugFile = path.join(home, 'gateway-debug.json');
    const data = readJson<Partial<GatewayFile>>(this.file);
    this.settings = normalizeSettings(data?.settings);
    for (const raw of data?.tokens ?? []) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.tokenHash !== 'string') continue;
      if (typeof raw.memberId !== 'string' || !raw.memberId) continue;
      const token: StoredGatewayToken = {
        id: raw.id,
        memberId: raw.memberId,
        memberName: typeof raw.memberName === 'string' ? raw.memberName : '成员',
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
        ...(typeof raw.revokedAt === 'number' ? { revokedAt: raw.revokedAt } : {}),
        ...(typeof raw.lastUsedAt === 'number' ? { lastUsedAt: raw.lastUsedAt } : {}),
        ...(finiteLimit(raw.dailyLimitUsd) ? { dailyLimitUsd: finiteLimit(raw.dailyLimitUsd) } : {}),
        ...(finiteLimit(raw.monthlyLimitUsd) ? { monthlyLimitUsd: finiteLimit(raw.monthlyLimitUsd) } : {}),
        rpm: positiveInt(raw.rpm, 60),
        allowedModels: normalizeModels(raw.allowedModels),
        tokenHash: raw.tokenHash,
      };
      this.tokens.push(token);
    }
    this.logs = Array.isArray(data?.logs) ? data.logs.slice(-LOG_LIMIT) : [];
    this.loadDebug();
  }

  settingsView(): GatewaySettings {
    return {
      enabled: this.settings.enabled,
      debugBodies: this.settings.debugBodies,
      routes: this.settings.routes.map((route) => ({ ...route, models: [...route.models] })),
    };
  }

  updateSettings(next: GatewaySettings): GatewaySettings {
    const wasDebug = this.settings.debugBodies;
    this.settings = normalizeSettings(next);
    // 关闭调试模式立即清空已捕获的正文，避免继续留在磁盘上。
    if (wasDebug && !this.settings.debugBodies) {
      this.debugEntries = [];
      this.saveDebugNow();
    }
    this.save();
    return this.settingsView();
  }

  listTokens(): GatewayToken[] {
    return [...this.tokens]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicToken);
  }

  issueToken(input: Omit<GatewayTokenInput, 'name'> & { memberId: string; memberName: string }): { token: string; grant: GatewayToken } {
    // 同一持有者重新签发等同轮换：旧令牌立即失效。
    for (const old of this.tokens) {
      if (old.memberId === input.memberId && !old.revokedAt) {
        old.revokedAt = Date.now();
        this.rateBuckets.delete(old.id);
      }
    }
    const token = `tgw_${randomBytes(32).toString('hex')}`;
    const grant: StoredGatewayToken = {
      id: randomUUID(),
      memberId: input.memberId,
      memberName: input.memberName,
      createdAt: Date.now(),
      rpm: positiveInt(input.rpm, 60),
      allowedModels: normalizeModels(input.allowedModels),
      tokenHash: hashToken(token),
      ...(finiteLimit(input.dailyLimitUsd) ? { dailyLimitUsd: finiteLimit(input.dailyLimitUsd) } : {}),
      ...(finiteLimit(input.monthlyLimitUsd) ? { monthlyLimitUsd: finiteLimit(input.monthlyLimitUsd) } : {}),
    };
    this.tokens.push(grant);
    this.save();
    return { token, grant: publicToken(grant) };
  }

  updateToken(id: string, patch: GatewayTokenUpdateInput): GatewayToken | undefined {
    const token = this.tokens.find((item) => item.id === id);
    if (!token) return undefined;
    if (patch.dailyLimitUsd !== undefined) {
      const limit = finiteLimit(patch.dailyLimitUsd);
      if (limit) token.dailyLimitUsd = limit;
      else delete token.dailyLimitUsd;
    }
    if (patch.monthlyLimitUsd !== undefined) {
      const limit = finiteLimit(patch.monthlyLimitUsd);
      if (limit) token.monthlyLimitUsd = limit;
      else delete token.monthlyLimitUsd;
    }
    if (patch.rpm !== undefined) token.rpm = positiveInt(patch.rpm, token.rpm);
    if (patch.allowedModels !== undefined) token.allowedModels = normalizeModels(patch.allowedModels);
    this.save();
    return publicToken(token);
  }

  revokeToken(id: string): boolean {
    const token = this.tokens.find((item) => item.id === id);
    if (!token || token.revokedAt) return false;
    token.revokedAt = Date.now();
    this.rateBuckets.delete(token.id);
    this.save();
    return true;
  }

  /** 校验网关令牌；成功返回令牌记录与成员 id，并记录 lastUsedAt。 */
  authenticate(token: string): StoredGatewayToken | undefined {
    if (!token) return undefined;
    const grant = findActiveToken(this.tokens, token, (item) => item.tokenHash);
    if (!grant) return undefined;
    grant.lastUsedAt = Date.now();
    this.scheduleSave();
    return grant;
  }

  /** 滑动窗口限流：返回 0 表示放行，否则返回建议的 Retry-After 秒数。 */
  checkRate(token: StoredGatewayToken, now = Date.now()): number {
    const bucket = (this.rateBuckets.get(token.id) ?? []).filter((at) => now - at < 60_000);
    if (bucket.length >= token.rpm) {
      this.rateBuckets.set(token.id, bucket);
      const retry = bucket.length ? Math.max(1, Math.ceil((bucket[0]! + 60_000 - now) / 1000)) : 1;
      return retry;
    }
    bucket.push(now);
    this.rateBuckets.set(token.id, bucket);
    return 0;
  }

  recordRequest(entry: GatewayLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.scheduleSave();
  }

  logsView(limit = 100): GatewayLogEntry[] {
    const size = Math.max(1, Math.min(Math.round(limit) || 100, LOG_LIMIT));
    return this.logs.slice(-size).reverse();
  }

  /** 调试正文只在调试模式开启时写入；内容已由调用方脱敏并截断。 */
  recordDebug(input: {
    memberId: string;
    memberName: string;
    model: string;
    protocol: 'openai' | 'anthropic';
    request: string;
    response: string;
  }): void {
    if (!this.settings.debugBodies) return;
    const now = Date.now();
    this.debugEntries.push({
      id: randomUUID(),
      at: now,
      expiresAt: now + GATEWAY_DEBUG_TTL_MS,
      ...input,
    });
    if (this.debugEntries.length > DEBUG_LIMIT) {
      this.debugEntries.splice(0, this.debugEntries.length - DEBUG_LIMIT);
    }
    this.scheduleDebugSave();
  }

  /** 仅用于测试与排查：返回未过期的调试条目数量（正文不通过 REST 暴露）。 */
  debugCount(now = Date.now()): number {
    return this.debugEntries.filter((entry) => entry.expiresAt > now).length;
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.debugSaveTimer) {
      clearTimeout(this.debugSaveTimer);
      this.debugSaveTimer = undefined;
    }
    this.saveNow();
    this.saveDebugNow();
  }

  private loadDebug(): void {
    const data = readJson<Partial<GatewayDebugFile>>(this.debugFile);
    const now = Date.now();
    this.debugEntries = (data?.entries ?? []).filter(
      (entry) => entry && typeof entry.id === 'string' && typeof entry.expiresAt === 'number' && entry.expiresAt > now,
    );
    if (this.debugEntries.length !== (data?.entries ?? []).length) this.saveDebugNow();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, 800);
  }

  private scheduleDebugSave(): void {
    if (this.debugSaveTimer) return;
    this.debugSaveTimer = setTimeout(() => {
      this.debugSaveTimer = undefined;
      this.saveDebugNow();
    }, 800);
  }

  private save(): void {
    this.scheduleSave();
  }

  private saveNow(): void {
    const now = Date.now();
    this.debugEntries = this.settings.debugBodies
      ? this.debugEntries.filter((entry) => entry.expiresAt > now)
      : [];
    writePrivateFile(
      this.file,
      JSON.stringify(
        {
          version: 1,
          settings: this.settings,
          tokens: this.tokens,
          logs: this.logs,
        } satisfies GatewayFile,
        null,
        2,
      ),
    );
  }

  private saveDebugNow(): void {
    const now = Date.now();
    this.debugEntries = this.debugEntries.filter((entry) => entry.expiresAt > now);
    writePrivateFile(
      this.debugFile,
      JSON.stringify({ version: 1, entries: this.debugEntries } satisfies GatewayDebugFile, null, 2),
    );
  }
}
