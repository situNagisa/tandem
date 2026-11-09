// 账号余额查询：工作站用该账号的 Key 查上游余额，5 分钟缓存；主机只拿到结果。
// 已知平台：OpenRouter / DeepSeek / Moonshot / New API(One API) / OpenAI Billing；其余可自定义 URL + JSON 路径。
import type { BalancePlatform, BalanceQueryConfig, Profile, ProfileBalance } from '@tandem/protocol';
import type { StoredProfile } from '../types.js';

const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

export interface BalanceRequest {
  url: string;
  platform: BalancePlatform | 'custom';
}

function originOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl.trim()).origin;
  } catch {
    return undefined;
  }
}

/** 去掉 /v1、/v1beta/openai、/chat/completions 等 API 后缀，用于拼接余额接口。 */
function apiRoot(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname
      .replace(/\/(?:v1beta\/openai|v1beta|v1|api\/v1)$/i, '')
      .replace(/\/(?:v1\/)?(?:messages|chat\/completions|models)$/i, '')
      .replace(/\/api$/i, '');
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/** 自动识别平台：只认已知域名/路径，识别不了返回 none（用户可显式选择或自定义）。 */
export function detectBalancePlatform(profile: StoredProfile): BalancePlatform {
  const explicit = profile.balanceQuery?.platform;
  if (explicit && explicit !== 'auto') return explicit;
  const base = (profile.baseUrl ?? '').toLowerCase();
  const host = (() => {
    try {
      return new URL(profile.baseUrl ?? '').hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (host.includes('openrouter.ai')) return 'openrouter';
  if (host.includes('deepseek')) return 'deepseek';
  if (host.includes('moonshot')) return 'moonshot';
  if (host.includes('new-api') || host.includes('one-api') || /\/api\/user\/self/.test(base)) return 'new-api';
  if (profile.kind === 'openai' && host.endsWith('api.openai.com')) return 'openai-billing';
  return 'none';
}

export function balanceRequest(
  profile: StoredProfile,
  config: BalanceQueryConfig | undefined = profile.balanceQuery,
): BalanceRequest | undefined {
  const platform = detectBalancePlatform(profile);
  if (platform === 'none') return undefined;
  if (platform === 'custom') {
    if (!config?.url) return undefined;
    return { platform, url: config.url };
  }
  const root = apiRoot(profile.baseUrl) ?? originOf(profile.baseUrl);
  if (!root) return undefined;
  switch (platform) {
    case 'openrouter':
      return { platform, url: `${originOf(profile.baseUrl) ?? root}/api/v1/credits` };
    case 'deepseek':
      return { platform, url: `${originOf(profile.baseUrl) ?? root}/user/balance` };
    case 'moonshot':
      return { platform, url: `${originOf(profile.baseUrl) ?? root}/v1/users/me/balance` };
    case 'new-api':
      return { platform, url: `${originOf(profile.baseUrl) ?? root}/api/user/self` };
    case 'openai-credit-grants':
      return { platform, url: `${root}/dashboard/billing/credit_grants` };
    case 'openai-billing':
      return { platform, url: `${root}/dashboard/billing/subscription` };
    default:
      return undefined;
  }
}

function valueAt(value: unknown, path?: string): unknown {
  let current: unknown = value;
  if (!path) return current;
  for (const key of path.split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function numberAt(value: unknown, path?: string): number | undefined {
  const current = valueAt(value, path);
  const parsed = typeof current === 'string' ? Number(current) : current;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumber(value: unknown, paths: string[]): number | undefined {
  for (const path of paths) {
    const found = numberAt(value, path);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** 解析各平台响应（纯函数，单测覆盖）。 */
export function parseBalanceResponse(
  platform: BalancePlatform | 'custom',
  body: unknown,
  config: BalanceQueryConfig = {},
): { amount?: number; currency: string; error?: string } {
  const currency = config.currency || 'USD';
  switch (platform) {
    case 'openrouter': {
      const total = numberAt(body, 'data.total_credits');
      const used = numberAt(body, 'data.total_usage') ?? 0;
      if (total === undefined) return { currency, error: '响应里没有 data.total_credits' };
      return { amount: Math.max(0, total - used), currency };
    }
    case 'deepseek': {
      const items = (body as { balance_infos?: Array<Record<string, unknown>> })?.balance_infos;
      const first = Array.isArray(items) ? items[0] : undefined;
      const amount = first ? numberAt(first, 'total_balance') : undefined;
      if (amount === undefined) return { currency, error: '响应里没有 balance_infos[0].total_balance' };
      return { amount, currency: typeof first?.currency === 'string' ? first.currency : currency };
    }
    case 'moonshot': {
      const amount = firstNumber(body, ['data.available_balance', 'data.balance', 'available_balance']);
      if (amount === undefined) return { currency, error: '响应里没有 data.available_balance' };
      return { amount, currency: config.currency || 'CNY' };
    }
    case 'new-api': {
      const quota = numberAt(body, 'data.quota') ?? numberAt(body, 'quota');
      if (quota === undefined) return { currency, error: '响应里没有 data.quota' };
      // New API / One API：1 USD = 500000 quota。
      return { amount: Math.round((quota / 500000) * 1e6) / 1e6, currency };
    }
    case 'openai-credit-grants': {
      const amount = firstNumber(body, ['total_available', 'total_granted']);
      if (amount === undefined) return { currency, error: '响应里没有 total_available' };
      return { amount, currency };
    }
    case 'openai-billing': {
      const amount = firstNumber(body, ['hard_limit_usd', 'soft_limit_usd']);
      if (amount === undefined) return { currency, error: '响应里没有 hard_limit_usd' };
      return { amount, currency };
    }
    case 'custom': {
      const amount = numberAt(body, config.path);
      if (amount === undefined) return { currency, error: `响应里没有 ${config.path || '金额字段'}` };
      const fromBody = (body as { currency?: unknown })?.currency;
      const parent = config.path?.split('.').slice(0, -1).join('.');
      const nested = parent ? (valueAt(body, `${parent}.currency`) as unknown) : undefined;
      return {
        amount,
        currency:
          config.currency || (typeof nested === 'string' ? nested : typeof fromBody === 'string' ? fromBody : currency),
      };
    }
    default:
      return { currency, error: '未配置余额查询' };
  }
}

function authHeaders(profile: StoredProfile): Record<string, string> {
  const key = profile.apiKey;
  if (profile.kind === 'anthropic') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  return { authorization: `Bearer ${key}` };
}

export class BalanceService {
  private cache = new Map<string, { at: number; key: string; balance: ProfileBalance }>();

  async check(
    accountId: string,
    profile: StoredProfile,
    options: { force?: boolean; fetchImpl?: typeof fetch } = {},
  ): Promise<ProfileBalance | undefined> {
    const request = balanceRequest(profile);
    if (!request) return undefined;
    const cacheKey = `${accountId}:${profile.id}`;
    const configKey = JSON.stringify([request.url, profile.apiKey, profile.balanceQuery ?? {}]);
    const cached = this.cache.get(cacheKey);
    if (!options.force && cached && cached.key === configKey && Date.now() - cached.at < CACHE_MS) {
      return cached.balance;
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let balance: ProfileBalance;
    try {
      const res = await fetchImpl(request.url, {
        method: 'GET',
        headers: { accept: 'application/json', ...authHeaders(profile) },
        signal: controller.signal,
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        balance = {
          platform: request.platform,
          currency: profile.balanceQuery?.currency ?? 'USD',
          checkedAt: Date.now(),
          error: `HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}`,
        };
      } else {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
        const parsed = parseBalanceResponse(request.platform, body, profile.balanceQuery ?? {});
        balance = {
          platform: request.platform,
          currency: parsed.currency,
          checkedAt: Date.now(),
          ...(parsed.amount !== undefined ? { amount: parsed.amount } : {}),
          ...(parsed.error ? { error: parsed.error } : {}),
        };
      }
    } catch (err) {
      balance = {
        platform: request.platform,
        currency: profile.balanceQuery?.currency ?? 'USD',
        checkedAt: Date.now(),
        error: err instanceof Error ? err.message : '查询失败',
      };
    } finally {
      clearTimeout(timer);
    }
    this.cache.set(cacheKey, { at: Date.now(), key: configKey, balance });
    return balance;
  }

  /** 给公开 profile 列表附上余额（用对应的存储账号里的 Key 查询；缓存命中直接用）。 */
  async attach(
    accountId: string,
    stored: StoredProfile[],
    profiles: Profile[],
    force = false,
  ): Promise<Profile[]> {
    const byId = new Map(stored.map((profile) => [profile.id, profile]));
    const results = await Promise.all(
      profiles.map(async (profile) => {
        const source = byId.get(profile.id);
        if (!source || !source.apiKey) return [profile.id, undefined] as const;
        const balance = await this.check(accountId, source, { force });
        return [profile.id, balance] as const;
      }),
    );
    const map = new Map(results);
    return profiles.map((profile) => {
      const balance = map.get(profile.id);
      return balance ? { ...profile, balance } : profile;
    });
  }
}
