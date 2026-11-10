// 同组多 Key 调度：可用性过滤、failover / round-robin 排序、失败分类与可读错误。
import type { KeyStrategy } from '@tandem/protocol';
import type { StoredProfile, StoredProfileGroup, StoredProfileKey } from './types.js';
import { errorMessage } from './util/text.js';

/** 冷却指数退避：60s、120s、240s… 最长 30 分钟。 */
export const KEY_COOLDOWN_BASE_MS = 60_000;
export const KEY_COOLDOWN_MAX_MS = 30 * 60_000;

export type KeyFailureKind = 'disable' | 'cooldown' | 'none';

/** 分组内已无可用 Key（全部 429/冷却）：交给会话交接处理，不再按网络错误重试。 */
export class KeysExhaustedError extends Error {
  readonly keysExhausted = true;
  constructor(message: string) {
    super(message);
    this.name = 'KeysExhaustedError';
  }
}

export interface KeyFailure {
  kind: KeyFailureKind;
  status?: number;
  message: string;
}

/** 从 provider 错误里判定该 Key 的处理方式：401/403 停用，429/额度不足/5xx 冷却。 */
export function classifyKeyFailure(err: unknown): KeyFailure {
  const rawStatus = (err as { status?: unknown } | undefined)?.status;
  const status = typeof rawStatus === 'number' ? rawStatus : undefined;
  const message = errorMessage(err);
  const quota = /额度|配额|quota|insufficient|billing|rate.?limit|too many requests|exceeded/i.test(message);
  // 403 也可能是额度耗尽（部分中转/OpenAI 兼容服务），此时按冷却而不是永久停用处理
  if ((status === 401 || status === 403) && !quota) return { kind: 'disable', status, message };
  if (status === 429 || (typeof status === 'number' && status >= 500) || quota) {
    return { kind: 'cooldown', status, message };
  }
  if (/\b401\b|unauthorized|invalid.*(api.?)?key/i.test(message)) return { kind: 'disable', message };
  if (/\b403\b|forbidden/i.test(message)) return { kind: 'disable', message };
  return { kind: 'none', message };
}

export function cooldownMsFor(failures: number): number {
  const exponent = Math.max(0, Math.floor(failures) - 1);
  return Math.min(KEY_COOLDOWN_BASE_MS * 2 ** exponent, KEY_COOLDOWN_MAX_MS);
}

export function isKeyAvailable(key: StoredProfileKey, now = Date.now()): boolean {
  if (key.disabled) return false;
  return !key.cooldownUntil || key.cooldownUntil <= now;
}

/** 可用 Key 按策略排序：failover 保持顺序，round-robin 从 rotate 位置起轮转。 */
export function orderedAvailableKeys(
  keys: StoredProfileKey[],
  strategy: KeyStrategy | undefined,
  rotate = 0,
  now = Date.now(),
): StoredProfileKey[] {
  const available = keys.filter((key) => isKeyAvailable(key, now));
  if (available.length <= 1 || strategy !== 'round_robin') return available;
  const start = ((rotate % available.length) + available.length) % available.length;
  return [...available.slice(start), ...available.slice(0, start)];
}

/**
 * 取本次请求的可用 Key 顺序；round-robin 时把游标推进一格（游标由调用方持有）。
 * 网关（host.keyRotation）与工作站代理共用同一轮换规则。
 */
export function rotateKeyCandidates(
  keys: StoredProfileKey[],
  strategy: KeyStrategy | undefined,
  rotation: Map<string, number> | undefined,
  rotationKey: string,
  now = Date.now(),
): StoredProfileKey[] {
  const rotate = rotation?.get(rotationKey) ?? 0;
  const available = orderedAvailableKeys(keys, strategy, rotate, now);
  if (strategy === 'round_robin' && available.length > 0) rotation?.set(rotationKey, rotate + 1);
  return available;
}

export function keyDisplayName(key: StoredProfileKey, index: number): string {
  return key.label?.trim() || `Key ${index + 1}`;
}

/** 所有 Key 都不可用时的可读错误（停用/冷却原因 + 每个 Key 最近一次错误）。 */
export function groupUnavailableError(
  group: StoredProfileGroup,
  errors: Map<string, string> = new Map(),
  now = Date.now(),
): string {
  const keys = group.keys ?? [];
  const parts = keys.map((key, index) => {
    const name = keyDisplayName(key, index);
    const attempted = errors.get(key.id);
    if (attempted) return `${name}（${attempted}）`;
    if (key.disabled) return `${name}（已停用${key.lastError ? `：${key.lastError}` : ''}）`;
    if (key.cooldownUntil && key.cooldownUntil > now) {
      return `${name}（冷却中，${formatTime(key.cooldownUntil)} 后重试）`;
    }
    return `${name}（${key.lastError || '不可用'}）`;
  });
  return `分组「${group.name}」的所有 Key 都不可用：${parts.join('；')}`;
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 生成使用某个 Key 的有效账号配置（key 明文只在这里进入内存）。 */
export function profileWithKey(
  effective: StoredProfile,
  key: StoredProfileKey,
): StoredProfile {
  return { ...effective, apiKey: key.apiKey };
}
