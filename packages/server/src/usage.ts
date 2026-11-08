// 用量统计：每轮模型调用后按 day/host/profile/model 累加到 ~/.tandem/usage.json。
// 单价为"参考价"（每百万 token 美元），账号上配置的 price 优先覆盖。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProviderKind, Usage, UsageStatsRow } from '@tandem/protocol';
import type { StoredProfile } from './types.js';

export interface Price {
  input: number;
  output: number;
}

/** 内置参考单价表：按前缀匹配，越具体的放在越前面。 */
const BUILTIN_PRICES: Array<{ prefix: string; price: Price }> = [
  // Anthropic Claude
  { prefix: 'claude-opus-4-1', price: { input: 15, output: 75 } },
  { prefix: 'claude-opus-4', price: { input: 15, output: 75 } },
  { prefix: 'claude-3-opus', price: { input: 15, output: 75 } },
  { prefix: 'claude-sonnet-4-5', price: { input: 3, output: 15 } },
  { prefix: 'claude-sonnet-4', price: { input: 3, output: 15 } },
  { prefix: 'claude-3-7-sonnet', price: { input: 3, output: 15 } },
  { prefix: 'claude-3-5-sonnet', price: { input: 3, output: 15 } },
  { prefix: 'claude-haiku-4-5', price: { input: 1, output: 5 } },
  { prefix: 'claude-3-5-haiku', price: { input: 0.8, output: 4 } },
  { prefix: 'claude-3-sonnet', price: { input: 3, output: 15 } },
  { prefix: 'claude-2', price: { input: 8, output: 24 } },
  { prefix: 'claude-3-haiku', price: { input: 0.25, output: 1.25 } },
  // OpenAI GPT-5 / GPT-4.1 / GPT-4o / o 系列
  { prefix: 'gpt-5-codex', price: { input: 1.25, output: 10 } },
  { prefix: 'gpt-5-mini', price: { input: 0.25, output: 2 } },
  { prefix: 'gpt-5-nano', price: { input: 0.05, output: 0.4 } },
  { prefix: 'gpt-5', price: { input: 1.25, output: 10 } },
  { prefix: 'gpt-4.1-mini', price: { input: 0.4, output: 1.6 } },
  { prefix: 'gpt-4.1-nano', price: { input: 0.1, output: 0.4 } },
  { prefix: 'gpt-4.1', price: { input: 2, output: 8 } },
  { prefix: 'gpt-4o-mini', price: { input: 0.15, output: 0.6 } },
  { prefix: 'gpt-4o', price: { input: 2.5, output: 10 } },
  { prefix: 'gpt-4-turbo', price: { input: 10, output: 30 } },
  { prefix: 'gpt-4', price: { input: 30, output: 60 } },
  { prefix: 'gpt-3.5-turbo', price: { input: 0.5, output: 1.5 } },
  { prefix: 'o1-pro', price: { input: 150, output: 600 } },
  { prefix: 'o1-mini', price: { input: 1.1, output: 4.4 } },
  { prefix: 'o1-preview', price: { input: 15, output: 60 } },
  { prefix: 'o1', price: { input: 15, output: 60 } },
  { prefix: 'o3-pro', price: { input: 20, output: 80 } },
  { prefix: 'o3-mini', price: { input: 1.1, output: 4.4 } },
  { prefix: 'o3', price: { input: 2, output: 8 } },
  { prefix: 'o4-mini', price: { input: 1.1, output: 4.4 } },
  // DeepSeek
  { prefix: 'deepseek-reasoner', price: { input: 0.55, output: 2.19 } },
  { prefix: 'deepseek-chat', price: { input: 0.27, output: 1.1 } },
  { prefix: 'deepseek-v3', price: { input: 0.27, output: 1.1 } },
  // Google Gemini
  { prefix: 'gemini-2.5-pro', price: { input: 1.25, output: 10 } },
  { prefix: 'gemini-2.5-flash', price: { input: 0.3, output: 2.5 } },
  { prefix: 'gemini-2.0-flash', price: { input: 0.1, output: 0.4 } },
  { prefix: 'gemini-1.5-pro', price: { input: 1.25, output: 5 } },
  { prefix: 'gemini-1.5-flash', price: { input: 0.075, output: 0.3 } },
  // 其他常见兼容模型
  { prefix: 'qwen-max', price: { input: 1.6, output: 6.4 } },
  { prefix: 'qwen-plus', price: { input: 0.4, output: 1.2 } },
  { prefix: 'moonshot-v1-128k', price: { input: 1.68, output: 1.68 } },
  { prefix: 'moonshot-v1-32k', price: { input: 0.84, output: 0.84 } },
  { prefix: 'moonshot-v1-8k', price: { input: 0.17, output: 0.17 } },
];

/** 去掉供应商前缀后的小写模型名，兼容 openrouter 的 "vendor/model" 写法。 */
function normalizeModel(model: string): string {
  const lower = model.trim().toLowerCase();
  const slash = lower.lastIndexOf('/');
  return slash >= 0 ? lower.slice(slash + 1) : lower;
}

/**
 * 取模型单价：账号 price 精确匹配 → 账号 price 前缀匹配 → 内置参考价。
 * 返回 undefined 表示未知模型，仍统计 token，但 cost 记 0。
 */
export function priceForModel(profile: StoredProfile | undefined, model: string): Price | undefined {
  const name = normalizeModel(model);
  if (!name) return undefined;
  const overrides = profile?.price ?? {};
  const keys = Object.keys(overrides).filter((key) => {
    const k = normalizeModel(key);
    return k === name || name.startsWith(k);
  });
  // 前缀越长越优先
  keys.sort((a, b) => b.length - a.length);
  if (keys[0]) return { ...overrides[keys[0]]! };

  // 前缀匹配同时兼容供应商前缀与版本后缀：`us.anthropic.claude-sonnet-4-5-20250929-v1:0`
  // 也能命中 `claude-sonnet-4-5`；取最长的前缀，避免 `gpt-4` 抢走 `gpt-4o`。
  let best: { prefix: string; price: Price } | undefined;
  for (const entry of BUILTIN_PRICES) {
    const index = name.indexOf(entry.prefix);
    if (index < 0) continue;
    if (index > 0 && /[a-z0-9]/.test(name[index - 1]!)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best ? { ...best.price } : undefined;
}

/** 缓存读取价相对输入价的倍率（展示与计费保持一致）。 */
export function cacheReadMultiplier(kind: ProviderKind): number {
  return kind === 'anthropic' ? 0.1 : 0.5;
}

/** 缓存写入价相对输入价的倍率；不单独计费的 provider 返回 0。 */
export function cacheWriteMultiplier(kind: ProviderKind): number {
  return kind === 'anthropic' ? 1.25 : 0;
}

/** 把单价折算成菜单展示用的每百万 token 价格（含缓存命中）。 */
export function priceInfoFor(price: Price, kind: ProviderKind): import('@tandem/protocol').ModelPriceInfo {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const write = cacheWriteMultiplier(kind);
  return {
    input: price.input,
    output: price.output,
    cacheRead: round(price.input * cacheReadMultiplier(kind)),
    ...(write > 0 ? { cacheWrite: round(price.input * write) } : {}),
  };
}

/** 计算单次调用花费（美元）。 */
export function costOf(price: Price | undefined, inputTokens: number, outputTokens: number): number {
  if (!price) return 0;
  const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  // 保留 8 位，避免浮点噪声堆积
  return Math.round(cost * 1e8) / 1e8;
}

/**
 * 按模型单价与缓存倍率计算一次调用花费。
 * Anthropic 缓存读取 0.1×输入价、写入 1.25×；OpenAI 系 cached 输入 0.5×。
 */
export function costOfUsage(
  price: Price | undefined,
  usage: Usage,
  kind: ProviderKind,
): number {
  if (!price) return 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const readMultiplier = cacheReadMultiplier(kind);
  const writeMultiplier = cacheWriteMultiplier(kind);
  const cost =
    (usage.inputTokens * price.input +
      cacheRead * price.input * readMultiplier +
      cacheWrite * price.input * writeMultiplier +
      usage.outputTokens * price.output) /
    1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}

function localDay(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

interface UsageFile {
  rows?: UsageStatsRow[];
}

export class UsageStore {
  private file: string;
  private rows = new Map<string, UsageStatsRow>();
  private timer?: NodeJS.Timeout;

  constructor(home: string) {
    this.file = path.join(home, 'usage.json');
    const data = this.load();
    for (const row of data?.rows ?? []) {
      if (!row || typeof row.day !== 'string' || typeof row.model !== 'string') continue;
      const keyId = typeof row.keyId === 'string' && row.keyId ? row.keyId : undefined;
      const groupId = typeof row.groupId === 'string' && row.groupId ? row.groupId : undefined;
      const memberId = typeof row.memberId === 'string' && row.memberId ? row.memberId : undefined;
      const memberName = memberId && typeof row.memberName === 'string' ? row.memberName : undefined;
      const key = rowKey(row.day, row.hostId, row.profileId, row.model, keyId, groupId, memberId);
      const existing = this.rows.get(key);
      if (existing) {
        existing.inputTokens += num(row.inputTokens);
        existing.outputTokens += num(row.outputTokens);
        existing.costUsd += num(row.costUsd);
        existing.turns += num(row.turns);
      } else {
        this.rows.set(key, {
          day: row.day,
          hostId: String(row.hostId ?? ''),
          profileId: String(row.profileId ?? ''),
          model: row.model,
          inputTokens: num(row.inputTokens),
          outputTokens: num(row.outputTokens),
          costUsd: num(row.costUsd),
          turns: num(row.turns),
          ...(keyId ? { keyId } : {}),
          ...(groupId ? { groupId } : {}),
          ...(memberId ? { memberId } : {}),
          ...(memberName ? { memberName } : {}),
        });
      }
    }
  }

  /** 记一次模型调用增量，返回本次花费（未知单价为 0）。 */
  record(input: {
    hostId: string;
    profileId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    day?: string;
    /** 多 Key 分组：实际使用的 Key id / 分组 id，用于按 Key/分组统计与预算。 */
    keyId?: string;
    groupId?: string;
    /** 网关转发的请求：归属成员（用量页按成员统计与成员限额）。 */
    memberId?: string;
    memberName?: string;
  }): void {
    const day = input.day ?? localDay();
    const keyId = input.keyId || undefined;
    const groupId = input.groupId || undefined;
    const memberId = input.memberId || undefined;
    const memberName = memberId ? input.memberName || undefined : undefined;
    const key = rowKey(day, input.hostId, input.profileId, input.model, keyId, groupId, memberId);
    let row = this.rows.get(key);
    if (!row) {
      row = {
        day,
        hostId: input.hostId,
        profileId: input.profileId,
        model: input.model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        turns: 0,
        ...(keyId ? { keyId } : {}),
        ...(groupId ? { groupId } : {}),
        ...(memberId ? { memberId } : {}),
        ...(memberName ? { memberName } : {}),
      };
      this.rows.set(key, row);
    }
    row.inputTokens += Math.max(0, Math.round(input.inputTokens || 0));
    row.outputTokens += Math.max(0, Math.round(input.outputTokens || 0));
    row.costUsd += Math.max(0, input.costUsd || 0);
    row.turns += 1;
    this.scheduleSave();
  }

  /** 按日期范围（含端点，YYYY-MM-DD）返回，未给范围则全量。 */
  list(from?: string, to?: string): UsageStatsRow[] {
    return [...this.rows.values()]
      .filter((row) => (!from || row.day >= from) && (!to || row.day <= to))
      .map((row) => ({ ...row }))
      .sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? -1 : 1));
  }

  private load(): UsageFile | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as UsageFile;
    } catch (err) {
      console.warn(`[tandem] 无法解析用量文件 ${this.file}:`, (err as Error).message);
      return undefined;
    }
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 500);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ rows: this.list() }, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('[tandem] 保存用量统计失败:', (err as Error).message);
    }
  }
}

function rowKey(
  day: string,
  hostId: string,
  profileId: string,
  model: string,
  keyId?: string,
  groupId?: string,
  memberId?: string,
): string {
  return `${day}\u0000${hostId}\u0000${profileId}\u0000${model}\u0000${keyId ?? ''}\u0000${groupId ?? ''}\u0000${memberId ?? ''}`;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
