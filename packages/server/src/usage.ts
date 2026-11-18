// 用量统计：每轮模型调用后按 day/host/profile/model 累加到 ~/.tandem/usage.json。
// 单价只有两个来源：分组/账号自定义单价，或价格表里的官方价（唯一实现在 model-prices.ts）；
// 未收录的型号视为未知单价。倍率只属于分组。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProviderKind, Usage, UsageStatsRow } from '@tandem/protocol';
import type { StoredProfile } from './types.js';
import { normalizeModel, officialPriceFor, type Price, type PriceRates } from './model-prices.js';

export type { Price, PriceRates };

/**
 * 取模型单价：自定义 price 精确匹配 → 前缀匹配 → 官方价格表。
 * 返回 undefined 表示未收录官方价，仍统计 token，花费显示为「未知单价」。
 */
export interface ResolvedPrice {
  /** 实际生效单价（官方价已乘分组倍率；自定义单价原样使用）。 */
  price: Price;
  /** 自定义单价（account）或价格表官方价（builtin）。 */
  source: 'account' | 'builtin';
  /** 官方价（未乘倍率），仅在分组倍率不为 1 时返回，供界面展示说明。 */
  official?: PriceRates;
  /** 实际生效的分组倍率；为 1 时不返回。 */
  groupMultiplier?: number;
}

/**
 * 取模型的实际单价：
 * - 自定义 `price` 覆盖（分组优先于账号，精确/前缀匹配）优先，覆盖后不再乘倍率；
 * - 否则官方价格表 × 分组倍率（缺省 1）；倍率只属于分组（MODEL-3）。
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
  const builtin = officialPriceFor(name);
  if (!builtin) return undefined;
  const groupMultiplier = multiplierOf(profile?.groupMultiplier);
  if (groupMultiplier === 1) return { price: { ...builtin.price }, source: 'builtin' };
  return {
    price: scalePrice(builtin.price, groupMultiplier),
    source: 'builtin',
    official: { ...builtin.price },
    groupMultiplier,
  };
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
