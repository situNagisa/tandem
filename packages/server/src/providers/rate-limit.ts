// 从 provider 响应头解析限流额度与重置时间（OpenAI / Anthropic），没有时返回 undefined。
import type { ProviderRateLimit } from './types.js';

type HeaderBag = { get(name: string): string | null };

function numberHeader(headers: HeaderBag, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

function parseDuration(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const iso = Date.parse(text);
  if (Number.isFinite(iso)) return iso;
  // OpenAI 风格：1s / 6m0s / 100ms / 1h2m3s
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?(?:(\d+)ms)?$/.exec(text);
  if (match && match.slice(1).some(Boolean)) {
    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2] ?? 0);
    const seconds = Number(match[3] ?? 0);
    const millis = Number(match[4] ?? 0);
    return Date.now() + hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis;
  }
  // 纯数字：可能是秒、毫秒或 epoch
  const value = Number(text);
  if (Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return Date.now() + value * 1000;
  }
  return undefined;
}

function resetAt(headers: HeaderBag, name: string): number | undefined {
  const raw = headers.get(name);
  return raw ? parseDuration(raw) : undefined;
}

/** retry-after 支持秒数与 HTTP 日期。 */
export function retryAfterMs(headers: HeaderBag): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** OpenAI: x-ratelimit-*；Anthropic: anthropic-ratelimit-*（含 unified）。 */
export function parseRateLimitHeaders(
  kind: 'openai' | 'anthropic',
  headers: HeaderBag,
): ProviderRateLimit | undefined {
  const info: ProviderRateLimit = {};
  if (kind === 'anthropic') {
    info.remainingRequests = numberHeader(headers, 'anthropic-ratelimit-requests-remaining');
    info.limitRequests = numberHeader(headers, 'anthropic-ratelimit-requests-limit');
    info.remainingTokens = numberHeader(headers, 'anthropic-ratelimit-tokens-remaining');
    info.limitTokens = numberHeader(headers, 'anthropic-ratelimit-tokens-limit');
    info.resetRequestsAt = resetAt(headers, 'anthropic-ratelimit-requests-reset');
    info.resetTokensAt = resetAt(headers, 'anthropic-ratelimit-tokens-reset');
    const status = headers.get('anthropic-ratelimit-unified-status');
    if (status) info.unifiedStatus = status;
    const unifiedReset = resetAt(headers, 'anthropic-ratelimit-unified-reset');
    if (unifiedReset !== undefined) info.unifiedResetAt = unifiedReset;
  } else {
    info.remainingRequests = numberHeader(headers, 'x-ratelimit-remaining-requests');
    info.limitRequests = numberHeader(headers, 'x-ratelimit-limit-requests');
    info.remainingTokens = numberHeader(headers, 'x-ratelimit-remaining-tokens');
    info.limitTokens = numberHeader(headers, 'x-ratelimit-limit-tokens');
    info.resetRequestsAt = resetAt(headers, 'x-ratelimit-reset-requests');
    info.resetTokensAt = resetAt(headers, 'x-ratelimit-reset-tokens');
  }
  return Object.values(info).some((value) => value !== undefined) ? info : undefined;
}
