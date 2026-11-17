// 2026-11 一次性迁移：旧表对没收录的 Claude 新代际按同家族最近一代借价（estimatedFrom），
// 这批金额与官方价不符。启动时按逐型号官方价重算一次，usage.json 的 version 2 标记后不再执行。
// 旧借价逻辑只在这里留作识别「哪些记录当初是估算的」，不做新的计费分支。
import type { Host } from './host.js';
import { costOfUsage, resolvePriceForModel } from './usage.js';
import { parseClaudeModel } from './providers/capabilities.js';
import type { StoredProfile } from './types.js';

/** 旧版 CLAUDE_PRICES（冻结快照）。 */
const LEGACY_CLAUDE_PRICES: Array<{ family: string; major: number; minor: number }> = [
  { family: 'opus', major: 3, minor: 0 },
  { family: 'opus', major: 4, minor: 0 },
  { family: 'opus', major: 4, minor: 1 },
  { family: 'opus', major: 4, minor: 5 },
  { family: 'sonnet', major: 3, minor: 0 },
  { family: 'sonnet', major: 3, minor: 5 },
  { family: 'sonnet', major: 3, minor: 7 },
  { family: 'sonnet', major: 4, minor: 0 },
  { family: 'sonnet', major: 4, minor: 5 },
  { family: 'haiku', major: 3, minor: 0 },
  { family: 'haiku', major: 3, minor: 5 },
  { family: 'haiku', major: 4, minor: 5 },
];

/** 旧版前缀表里能精确命中的模型：这些记录本来就不是估算。 */
const LEGACY_PREFIXES = [
  'claude-2',
  'gpt-6-mini',
  'gpt-6-nano',
  'gpt-6',
  'gpt-5-pro',
  'gpt-5-codex',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4.1',
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
  'o1-pro',
  'o1-mini',
  'o1-preview',
  'o1',
  'o3-pro',
  'o3-mini',
  'o3',
  'o4-mini',
  'deepseek-reasoner',
  'deepseek-r1',
  'deepseek-chat',
  'deepseek-coder',
  'deepseek-v3',
  'gemini-3-pro',
  'gemini-3-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'kimi-k2',
  'kimi-latest',
  'moonshot-v1-128k',
  'moonshot-v1-32k',
  'moonshot-v1-8k',
  'qwen3-max',
  'qwen3-coder',
  'qwen-max',
  'qwen-plus',
  'qwen-turbo',
  'qwen-long',
  'glm-4.6',
  'glm-4.5',
  'glm-4-plus',
  'glm-4',
];

function normalizeModel(model: string): string {
  const lower = model.trim().toLowerCase();
  const slash = lower.lastIndexOf('/');
  return slash >= 0 ? lower.slice(slash + 1) : lower;
}

function atMost(major: number, minor: number, limitMajor: number, limitMinor: number): boolean {
  return major < limitMajor || (major === limitMajor && minor <= limitMinor);
}

/** 旧逻辑里这条记录是不是按同家族借价记的；是则返回被借用的型号。 */
export function legacyEstimatedFrom(model: string): string | undefined {
  const name = normalizeModel(model);
  if (!name) return undefined;
  const exact = LEGACY_PREFIXES.some((prefix) => {
    const index = name.indexOf(prefix);
    if (index < 0) return false;
    return index === 0 || !/[a-z0-9]/.test(name[index - 1]!);
  });
  if (exact) return undefined;

  const claude = parseClaudeModel(name);
  if (claude) {
    let nearest: (typeof LEGACY_CLAUDE_PRICES)[number] | undefined;
    for (const entry of LEGACY_CLAUDE_PRICES) {
      if (entry.family !== claude.family) continue;
      if (atMost(entry.major, entry.minor, claude.major, claude.minor)) nearest = entry;
    }
    if (!nearest) return undefined;
    if (nearest.major === claude.major && nearest.minor === claude.minor) return undefined;
    return `claude-${nearest.family}-${nearest.major}.${nearest.minor}`;
  }

  const gpt = name.match(/(?:^|[^a-z0-9])gpt-(\d+)(?:\.(\d+))?(?=[-.]|$)/);
  if (!gpt) return undefined;
  const major = Number(gpt[1]);
  const minor = Number(gpt[2] ?? 0);
  const bases = LEGACY_PREFIXES.filter((prefix) => /^gpt-\d+(?:\.\d+)?$/.test(prefix));
  let nearest: string | undefined;
  let nearestVersion: [number, number] = [-1, 0];
  for (const prefix of bases) {
    const base = prefix.match(/^gpt-(\d+)(?:\.(\d+))?$/)!;
    const version: [number, number] = [Number(base[1]), Number(base[2] ?? 0)];
    if (!atMost(version[0], version[1], major, minor)) continue;
    if (version[0] > nearestVersion[0] || (version[0] === nearestVersion[0] && version[1] > nearestVersion[1])) {
      nearest = prefix;
      nearestVersion = version;
    }
  }
  return nearest;
}

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function pricingProfile(profile: StoredProfile | undefined): StoredProfile | undefined {
  // 只用倍率，不用账号当前的自定义单价：当初是内置表借价，重算也按内置官方价。
  return profile ? { ...profile, price: {} } : undefined;
}

/**
 * 对估算价记过的账按官方价重算一次：
 * - 会话消息上的 usage.costUsd（含会话总量）与用量日统计行；
 * - 完成后写 usage.json version 2，之后不再执行。
 */
export function migrateEstimatedUsage(host: Host): void {
  if (host.usage.schemaVersion >= 2) return;
  let sessions = 0;
  let messages = 0;
  for (const rec of host.store.list()) {
    let delta = 0;
    let touched = 0;
    const profile = pricingProfile(rec.profileId ? host.profileFor(rec.profileId, rec.groupId) : undefined);
    const kind = profile?.kind ?? 'anthropic';
    for (const message of rec.messages) {
      const usage = message.usage;
      if (!usage) continue;
      const model = message.model || rec.model;
      if (!legacyEstimatedFrom(model)) continue;
      const price = resolvePriceForModel(profile, model);
      if (!price) continue;
      const next = costOfUsage(price.price, usage, kind);
      // 会话总量只累计 assistant 用量；用户消息上的金额仅用于输入框那条的展示。
      if (message.role === 'assistant') delta += next - (usage.costUsd ?? 0);
      usage.costUsd = next;
      touched += 1;
    }
    if (!touched) continue;
    rec.usage.costUsd = Math.max(0, round((rec.usage.costUsd ?? 0) + delta));
    host.store.forceRewrite(rec.id);
    sessions += 1;
    messages += touched;
  }
  const rows = host.usage.reprice((row) => {
    if (!legacyEstimatedFrom(row.model)) return undefined;
    const profile = pricingProfile(host.profileFor(row.profileId, row.groupId));
    const price = resolvePriceForModel(profile, row.model);
    if (!price) return undefined;
    // 旧日统计行只保存了输入/输出合计（输入含缓存读写），按官方输入/输出价重算。
    return round(
      (row.inputTokens * price.price.input + row.outputTokens * price.price.output) / 1_000_000,
    );
  });
  host.usage.markPricingMigrated();
  if (sessions || rows) {
    console.log(`[tandem] 价格迁移：按官方单价重算 ${messages} 条消息（${sessions} 个会话）、${rows} 行日统计`);
  }
}
