// 用量统计：每轮模型调用后按 day/host/profile/model 累加到 ~/.tandem/usage.json。
// 单价只有两个来源：账号自定义单价，或下面逐型号收录的官方价；未收录的型号视为未知单价。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProviderKind, Usage, UsageStatsRow } from '@tandem/protocol';
import type { StoredProfile } from './types.js';

/** 一组每百万 token 单价（美元）。缓存价缺省时按协议倍率折算（仅账号自定义单价会走到）。 */
export interface PriceRates {
  input: number;
  output: number;
  /** 缓存读（命中）单价。 */
  cacheRead?: number;
  /** 缓存写 5 分钟 TTL 单价。 */
  cacheWrite5m?: number;
  /** 缓存写 1 小时 TTL 单价。 */
  cacheWrite1h?: number;
}

export interface Price extends PriceRates {
  /** 单次请求提示 token 超过 threshold 时整条请求改用这份单价（Haiku 5.5 100K 分段）。 */
  longPrompt?: { threshold: number; rates: PriceRates };
}

/**
 * 内置官方单价表（美元 / 百万 token）。
 * 来源与核对日期见每段注释；只收官方定价页上逐型号列出的价格，没有就不收，
 * 不在型号之间借价或按家族估算。按模型名前缀匹配（取最长命中），版本后缀与供应商前缀不影响。
 */
export const BUILTIN_PRICES: Array<{ prefix: string; price: Price }> = [
  // Anthropic: https://platform.claude.com/docs/en/about-claude/pricing （2026-11-17 核对）
  { prefix: 'claude-2', price: { input: 8, output: 24 } },
  { prefix: 'claude-3-opus', price: { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 } },
  { prefix: 'claude-3-sonnet', price: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
  { prefix: 'claude-3-5-sonnet', price: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
  { prefix: 'claude-3.5-sonnet', price: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
  { prefix: 'claude-3-7-sonnet', price: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
  { prefix: 'claude-3.7-sonnet', price: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
  { prefix: 'claude-3-5-haiku', price: { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 } },
  { prefix: 'claude-3.5-haiku', price: { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 } },
  { prefix: 'claude-3-haiku', price: { input: 0.25, output: 1.25, cacheWrite5m: 0.3, cacheRead: 0.03 } },
  { prefix: 'claude-opus-4-1', price: { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 } },
  { prefix: 'claude-opus-4', price: { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 } },
  { prefix: 'claude-opus-4-5', price: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } },
  { prefix: 'claude-opus-4-6', price: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } },
  { prefix: 'claude-opus-4-7', price: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } },
  { prefix: 'claude-opus-4-8', price: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } },
  { prefix: 'claude-opus-5-5', price: { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 } },
  { prefix: 'claude-opus-5', price: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } },
  { prefix: 'claude-sonnet-4', price: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
  { prefix: 'claude-sonnet-4-5', price: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
  { prefix: 'claude-sonnet-4-6', price: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 } },
  { prefix: 'claude-sonnet-5-5', price: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 } },
  { prefix: 'claude-sonnet-5', price: { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 } },
  { prefix: 'claude-haiku-4-5', price: { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 } },
  {
    prefix: 'claude-haiku-5-5',
    price: {
      input: 0.1,
      output: 0.5,
      cacheWrite5m: 0.125,
      cacheWrite1h: 0.2,
      cacheRead: 0.01,
      longPrompt: {
        threshold: 100_000,
        rates: { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 },
      },
    },
  },
  { prefix: 'claude-fable-5-2', price: { input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2 } },
  { prefix: 'claude-fable-5-1', price: { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 } },
  { prefix: 'claude-fable-5', price: { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 } },
  { prefix: 'claude-mythos-5-2', price: { input: 8, output: 40, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.2 } },
  { prefix: 'claude-mythos-5-1', price: { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 } },
  { prefix: 'claude-mythos-5', price: { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 } },
  // OpenAI: https://developers.openai.com/api/docs/pricing （2026-11-17 核对；Standard 档）
  { prefix: 'gpt-6.1-sol', price: { input: 2, output: 10, cacheRead: 0.1 } },
  { prefix: 'gpt-6.1-terra', price: { input: 1, output: 5, cacheRead: 0.05 } },
  { prefix: 'gpt-6-astra-law', price: { input: 10, output: 50, cacheRead: 1 } },
  { prefix: 'gpt-6-astra', price: { input: 10, output: 50, cacheRead: 1 } },
  { prefix: 'gpt-6-cyber', price: { input: 20, output: 100, cacheRead: 2 } },
  { prefix: 'gpt-6-rosalind', price: { input: 15, output: 75, cacheRead: 1.5 } },
  { prefix: 'gpt-6-luna', price: { input: 0.1, output: 0.5, cacheRead: 0.01 } },
  { prefix: 'chat-latest', price: { input: 5, output: 30, cacheRead: 0.5 } },
  // 旧代际（官方当前定价页不再单列，保留已知历史官方价，不跨型号借价）
  { prefix: 'gpt-5.1-codex', price: { input: 1.25, output: 10 } },
  { prefix: 'gpt-5-pro', price: { input: 15, output: 120 } },
  { prefix: 'gpt-5-codex', price: { input: 1.25, output: 10 } },
  { prefix: 'gpt-5-mini', price: { input: 0.25, output: 2 } },
  { prefix: 'gpt-5-nano', price: { input: 0.05, output: 0.4 } },
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
  // DeepSeek: https://api-docs.deepseek.com/quick_start/pricing （2026-11-17 核对；高峰档）
  { prefix: 'deepseek-v4-pro', price: { input: 1.32, output: 3.96, cacheRead: 0.044 } },
  { prefix: 'deepseek-flash', price: { input: 0.3, output: 1.2, cacheRead: 0.006 } },
  // 官方说明 legacy 名 deepseek-v4-flash 仍按 Flash 计费
  { prefix: 'deepseek-v4-flash', price: { input: 0.3, output: 1.2, cacheRead: 0.006 } },
  // 旧代际（官方当前页不再单列，保留已知历史官方价）
  { prefix: 'deepseek-reasoner', price: { input: 0.55, output: 2.19 } },
  { prefix: 'deepseek-r1', price: { input: 0.55, output: 2.19 } },
  { prefix: 'deepseek-chat', price: { input: 0.27, output: 1.1 } },
  { prefix: 'deepseek-coder', price: { input: 0.27, output: 1.1 } },
  { prefix: 'deepseek-v3', price: { input: 0.27, output: 1.1 } },
  // Google Gemini: https://ai.google.dev/gemini-api/docs/pricing （2026-11-17 核对）
  {
    prefix: 'gemini-3.1-pro',
    price: {
      input: 2,
      output: 12,
      longPrompt: { threshold: 200_000, rates: { input: 4, output: 18 } },
    },
  },
  { prefix: 'gemini-3-flash', price: { input: 0.5, output: 3 } },
  {
    prefix: 'gemini-2.5-pro',
    price: {
      input: 1.25,
      output: 10,
      longPrompt: { threshold: 200_000, rates: { input: 2.5, output: 15 } },
    },
  },
  { prefix: 'gemini-2.5-flash-lite', price: { input: 0.1, output: 0.4 } },
  { prefix: 'gemini-2.5-flash', price: { input: 0.3, output: 2.5 } },
  { prefix: 'gemini-2.0-flash-lite', price: { input: 0.075, output: 0.3 } },
  { prefix: 'gemini-2.0-flash', price: { input: 0.1, output: 0.4 } },
  { prefix: 'gemini-1.5-pro', price: { input: 1.25, output: 5 } },
  { prefix: 'gemini-1.5-flash', price: { input: 0.075, output: 0.3 } },
  // Kimi / Moonshot（官方页未给出可解析的单价表，沿用已知价）
  { prefix: 'kimi-k2', price: { input: 0.6, output: 2.5 } },
  { prefix: 'kimi-latest', price: { input: 2, output: 8 } },
  { prefix: 'moonshot-v1-128k', price: { input: 1.68, output: 1.68 } },
  { prefix: 'moonshot-v1-32k', price: { input: 0.84, output: 0.84 } },
  { prefix: 'moonshot-v1-8k', price: { input: 0.17, output: 0.17 } },
  // Qwen（Alibaba Cloud 官方页只列出 qwen-max / qwen-plus 的当前价）
  { prefix: 'qwen3-max', price: { input: 1.2, output: 6 } },
  { prefix: 'qwen3-coder', price: { input: 0.3, output: 1.2 } },
  { prefix: 'qwen-max', price: { input: 1.6, output: 6.4 } },
  { prefix: 'qwen-plus', price: { input: 0.4, output: 1.2 } },
  { prefix: 'qwen-turbo', price: { input: 0.05, output: 0.2 } },
  { prefix: 'qwen-long', price: { input: 0.07, output: 0.28 } },
  // GLM（智谱）: https://docs.z.ai/guides/overview/pricing （2026-11-17 核对）
  { prefix: 'glm-5.3-flashx-legal', price: { input: 0.37, output: 1.25, cacheRead: 0.075 } },
  { prefix: 'glm-5.3-flashx', price: { input: 0.37, output: 1.25, cacheRead: 0.075 } },
  { prefix: 'glm-5.3-flash', price: { input: 0.15, output: 0.5, cacheRead: 0.03 } },
  { prefix: 'glm-5.3', price: { input: 1.4, output: 4.4, cacheRead: 0.26 } },
  { prefix: 'glm-5.2', price: { input: 1.4, output: 4.4, cacheRead: 0.26 } },
  { prefix: 'glm-5.1', price: { input: 1.4, output: 4.4, cacheRead: 0.26 } },
  { prefix: 'glm-5', price: { input: 1, output: 3.2, cacheRead: 0.2 } },
  { prefix: 'glm-4.7-flashx', price: { input: 0.07, output: 0.4, cacheRead: 0.01 } },
  { prefix: 'glm-4.7', price: { input: 0.6, output: 2.2, cacheRead: 0.11 } },
  { prefix: 'glm-4.6v-flashx', price: { input: 0.04, output: 0.4, cacheRead: 0.004 } },
  { prefix: 'glm-4.6v', price: { input: 0.3, output: 0.9, cacheRead: 0.05 } },
  { prefix: 'glm-4.6', price: { input: 0.6, output: 2.2, cacheRead: 0.11 } },
  { prefix: 'glm-4.5-x', price: { input: 2.2, output: 8.9, cacheRead: 0.45 } },
  { prefix: 'glm-4.5-airx', price: { input: 1.1, output: 4.5, cacheRead: 0.22 } },
  { prefix: 'glm-4.5-air', price: { input: 0.2, output: 1.1, cacheRead: 0.03 } },
  { prefix: 'glm-4.5v', price: { input: 0.6, output: 1.8, cacheRead: 0.11 } },
  { prefix: 'glm-4.5', price: { input: 0.6, output: 2.2, cacheRead: 0.11 } },
  { prefix: 'glm-4-32b-0414-128k', price: { input: 0.1, output: 0.1 } },
  { prefix: 'glm-ocr', price: { input: 0.03, output: 0.03 } },
  { prefix: 'glm-4-plus', price: { input: 0.7, output: 0.7 } },
  { prefix: 'glm-4', price: { input: 0.6, output: 0.6 } },
];

/** 去掉供应商前缀后的小写模型名，兼容 openrouter 的 "vendor/model" 写法。 */
function normalizeModel(model: string): string {
  const lower = model.trim().toLowerCase();
  const slash = lower.lastIndexOf('/');
  return slash >= 0 ? lower.slice(slash + 1) : lower;
}

/**
 * 取模型单价：账号 price 精确匹配 → 账号 price 前缀匹配 → 内置官方价。
 * 返回 undefined 表示未收录官方价，仍统计 token，花费显示为「未知单价」。
 */
export interface ResolvedPrice {
  /** 实际生效单价（已乘倍率；账号覆盖时就是覆盖价）。 */
  price: Price;
  source: 'account' | 'builtin';
  /** 内置官方价（未乘倍率）。 */
  official?: PriceRates;
  /** 实际生效的账号/分组倍率；为 1 时不返回。 */
  accountMultiplier?: number;
  groupMultiplier?: number;
}

/**
 * 取模型的实际单价：
 * - 账号 `price` 覆盖（精确/前缀）优先，覆盖后不再乘倍率；
 * - 否则内置官方价 × 账号倍率 × 分组倍率（缺省 1）。
 */
export function resolvePriceForModel(
  profile: StoredProfile | undefined,
  model: string,
): ResolvedPrice | undefined {
  const name = normalizeModel(model);
  if (!name) return undefined;
  const overrides = profile?.price ?? {};
  const keys = Object.keys(overrides).filter((key) => {
    const k = normalizeModel(key);
    return k === name || name.startsWith(k);
  });
  // 前缀越长越优先
  keys.sort((a, b) => b.length - a.length);
  if (keys[0]) return { price: { ...overrides[keys[0]]! }, source: 'account' };

  // 前缀匹配同时兼容供应商前缀与版本后缀：`us.anthropic.claude-sonnet-4-5-20250929-v1:0`
  // 也能命中 `claude-sonnet-4-5`；取最长的前缀，避免 `gpt-4` 抢走 `gpt-4o`。
  const builtin = builtinPriceFor(name);
  if (!builtin) return undefined;
  const accountMultiplier = multiplierOf(profile?.multiplier);
  const groupMultiplier = multiplierOf(profile?.groupMultiplier);
  const multiplied = accountMultiplier !== 1 || groupMultiplier !== 1;
  const factor = accountMultiplier * groupMultiplier;
  return {
    price: scalePrice(builtin.price, factor),
    source: 'builtin',
    ...(multiplied ? { official: { ...builtin.price } } : {}),
    ...(accountMultiplier !== 1 ? { accountMultiplier } : {}),
    ...(groupMultiplier !== 1 ? { groupMultiplier } : {}),
  };
}

/** 内置官方价：只按前缀表命中，不跨型号借价。 */
function builtinPriceFor(name: string): { price: Price } | undefined {
  const exact = matchPrefix(name);
  // 版本点号写法（claude-opus-5.5 / claude-3.5-sonnet）归一成连字符后可能命中更具体的条目。
  const dashed = name.includes('.') ? matchPrefix(name.replace(/\./g, '-')) : undefined;
  const best = dashed && (!exact || dashed.prefix.length > exact.prefix.length) ? dashed : exact;
  return best ? { price: best.price } : undefined;
}

function matchPrefix(name: string): { prefix: string; price: Price } | undefined {
  let best: { prefix: string; price: Price } | undefined;
  for (const entry of BUILTIN_PRICES) {
    const index = name.indexOf(entry.prefix);
    if (index < 0) continue;
    if (index > 0 && /[a-z0-9]/.test(name[index - 1]!)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best;
}

function scaleRates(rates: PriceRates, factor: number): PriceRates {
  return {
    input: roundPrice(rates.input * factor),
    output: roundPrice(rates.output * factor),
    ...(rates.cacheRead !== undefined ? { cacheRead: roundPrice(rates.cacheRead * factor) } : {}),
    ...(rates.cacheWrite5m !== undefined ? { cacheWrite5m: roundPrice(rates.cacheWrite5m * factor) } : {}),
    ...(rates.cacheWrite1h !== undefined ? { cacheWrite1h: roundPrice(rates.cacheWrite1h * factor) } : {}),
  };
}

function scalePrice(price: Price, factor: number): Price {
  const scaled: Price = scaleRates(price, factor);
  if (price.longPrompt) {
    scaled.longPrompt = {
      threshold: price.longPrompt.threshold,
      rates: scaleRates(price.longPrompt.rates, factor),
    };
  }
  return scaled;
}

function multiplierOf(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 1;
}

function roundPrice(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function priceForModel(profile: StoredProfile | undefined, model: string): Price | undefined {
  return resolvePriceForModel(profile, model)?.price;
}

/** 缓存读取价相对输入价的倍率（仅账号自定义单价缺缓存价时使用）。 */
export function cacheReadMultiplier(kind: ProviderKind): number {
  return kind === 'anthropic' ? 0.1 : 0.5;
}

/** 缓存写入价相对输入价的倍率（仅账号自定义单价缺缓存价时使用）。 */
export function cacheWriteMultiplier(kind: ProviderKind): number {
  return kind === 'anthropic' ? 1.25 : 0;
}

/** 取某档单价里各 token 种类的实际单价（缓存价缺省时按协议倍率折算）。 */
function effectiveRates(price: PriceRates, kind: ProviderKind): Required<PriceRates> {
  const write = cacheWriteMultiplier(kind);
  const w5 = price.cacheWrite5m ?? price.input * write;
  return {
    input: price.input,
    output: price.output,
    cacheRead: price.cacheRead ?? price.input * cacheReadMultiplier(kind),
    cacheWrite5m: w5,
    cacheWrite1h: price.cacheWrite1h ?? w5,
  };
}

/** 把单价折算成菜单展示用的每百万 token 价格（含缓存命中）。 */
export function priceInfoFor(price: Price, kind: ProviderKind): import('@tandem/protocol').ModelPriceInfo {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const rates = effectiveRates(price, kind);
  return {
    input: rates.input,
    output: rates.output,
    cacheRead: round(rates.cacheRead),
    ...(rates.cacheWrite5m > 0 ? { cacheWrite: round(rates.cacheWrite5m) } : {}),
    ...(price.cacheWrite1h !== undefined ? { cacheWrite1h: round(rates.cacheWrite1h) } : {}),
  };
}

/** 计算单次调用花费（美元）；未知单价为 0（界面按价格缺失显示「未知单价」）。 */
export function costOf(price: Price | undefined, inputTokens: number, outputTokens: number): number {
  if (!price) return 0;
  const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  // 保留 8 位，避免浮点噪声堆积
  return Math.round(cost * 1e8) / 1e8;
}

/**
 * 按模型单价与缓存价计算一次调用花费。
 * 优先用表里逐型号的缓存读写价；账号自定义单价没有缓存价时按协议倍率折算。
 * 上游只给缓存写总数（没有 5m/1h 拆分）时按 5 分钟价计。
 */
export function costOfUsage(
  price: Price | undefined,
  usage: Usage,
  kind: ProviderKind,
): number {
  if (!price) return 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const split5m = usage.cacheWrite5mTokens ?? 0;
  const split1h = usage.cacheWrite1hTokens ?? 0;
  const write5m = split5m + split1h > 0 ? split5m : cacheWrite;
  const write1h = split5m + split1h > 0 ? split1h : 0;
  const promptTokens = usage.inputTokens + cacheRead + cacheWrite;
  const rates = effectiveRates(
    price.longPrompt && promptTokens > price.longPrompt.threshold ? price.longPrompt.rates : price,
    kind,
  );
  const cost =
    (usage.inputTokens * rates.input +
      cacheRead * rates.cacheRead +
      write5m * rates.cacheWrite5m +
      write1h * rates.cacheWrite1h +
      usage.outputTokens * rates.output) /
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
  version?: number;
  rows?: UsageStatsRow[];
}

export class UsageStore {
  private file: string;
  private version: number;
  private rows = new Map<string, UsageStatsRow>();
  private timer?: NodeJS.Timeout;

  constructor(home: string) {
    this.file = path.join(home, 'usage.json');
    const data = this.load();
    this.version = typeof data?.version === 'number' ? data.version : 1;
    for (const row of data?.rows ?? []) {
      if (!row || typeof row.day !== 'string' || typeof row.model !== 'string') continue;
      const keyId = typeof row.keyId === 'string' && row.keyId ? row.keyId : undefined;
      const groupId = typeof row.groupId === 'string' && row.groupId ? row.groupId : undefined;
      const memberId = typeof row.memberId === 'string' && row.memberId ? row.memberId : undefined;
      const memberName = memberId && typeof row.memberName === 'string' ? row.memberName : undefined;
      const role = row.role;
      const key = rowKey(row.day, row.hostId, row.profileId, row.model, keyId, groupId, memberId, role);
      const existing = this.rows.get(key);
      if (existing) {
        existing.inputTokens += num(row.inputTokens);
        existing.outputTokens += num(row.outputTokens);
        existing.costUsd += num(row.costUsd);
        existing.turns += num(row.turns);
        if (row.routeSavedUsd) existing.routeSavedUsd = (existing.routeSavedUsd ?? 0) + num(row.routeSavedUsd);
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
          ...(role ? { role } : {}),
          ...(row.routeSavedUsd ? { routeSavedUsd: num(row.routeSavedUsd) } : {}),
        });
      }
    }
  }

  /** 价格表 schema 版本；2 表示已做过估算价重算。 */
  get schemaVersion(): number {
    return this.version;
  }

  /** 一次性价格迁移跑完后标记，之后不再重算历史。 */
  markPricingMigrated(): void {
    this.version = 2;
    this.flush();
  }

  /** 一次性迁移用：按给定函数改写行金额，返回改写行数。 */
  reprice(matcher: (row: UsageStatsRow) => number | undefined): number {
    let changed = 0;
    for (const row of this.rows.values()) {
      const next = matcher(row);
      if (next === undefined || next === row.costUsd) continue;
      row.costUsd = next;
      changed += 1;
    }
    if (changed) this.scheduleSave();
    return changed;
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
    /** 分工路由角色。 */
    role?: import('@tandem/protocol').RouteRole;
    /** 对比最强档的估算节省。 */
    routeSavedUsd?: number;
  }): void {
    const day = input.day ?? localDay();
    const keyId = input.keyId || undefined;
    const groupId = input.groupId || undefined;
    const memberId = input.memberId || undefined;
    const memberName = memberId ? input.memberName || undefined : undefined;
    const role = input.role || undefined;
    const key = rowKey(day, input.hostId, input.profileId, input.model, keyId, groupId, memberId, role);
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
        ...(role ? { role } : {}),
      };
      this.rows.set(key, row);
    }
    row.inputTokens += Math.max(0, Math.round(input.inputTokens || 0));
    row.outputTokens += Math.max(0, Math.round(input.outputTokens || 0));
    row.costUsd += Math.max(0, input.costUsd || 0);
    if (input.routeSavedUsd) row.routeSavedUsd = (row.routeSavedUsd ?? 0) + input.routeSavedUsd;
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
      writeFileSync(tmp, JSON.stringify({ version: this.version, rows: this.list() }, null, 2), 'utf8');
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
  role?: string,
): string {
  return `${day}\u0000${hostId}\u0000${profileId}\u0000${model}\u0000${keyId ?? ''}\u0000${groupId ?? ''}\u0000${memberId ?? ''}\u0000${role ?? ''}`;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
