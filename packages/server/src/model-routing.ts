// 自动模型路由：按本轮信号给难度打分，在用户候选池里选档位；规则的每一步都可解释。
import type {
  AutoRouteSavings,
  ContentBlock,
  DelegationStrategy,
  ModelRouteDecision,
  ModelRoutingSettings,
  ModelTier,
  ProviderKind,
  RouteCandidate,
  RoutePreference,
  RouteScores,
} from '@tandem/protocol';
import { builtinCapabilities, overrideFor } from './providers/capabilities.js';
import { completeText } from './providers/index.js';
import { costOfUsage, priceForModel, type Price } from './usage.js';
import { normalizeRoutingSettings } from './routing-settings.js';
import type { SessionRecord } from './types.js';
import type { Host } from './host.js';

const TIERS: ModelTier[] = ['fast', 'balanced', 'power'];

const HARD_KEYWORDS = [
  '重构', '设计', '为什么', '调试', '并发', '架构', '性能', '安全', '迁移', '分布式',
  '算法', '跨模块', '竞态', '死锁', '排查', '优化',
  'refactor', 'architect', 'debug', 'concurren', 'design', 'migrat', 'performance',
  'security', 'why', 'deadlock', 'race condition',
];
const EASY_KEYWORDS = [
  '改个名', '改名', '格式化', '翻译', '总结', '摘要', '重命名', '拼写', 'typo',
  'rename', 'format', 'translate', 'summar', 'reword',
];
const UNCERTAIN = [
  '不确定', '不太确定', '无法确定', '可能不对', '需要确认', '我不清楚', '没把握',
  "i'm not sure", 'not sure', 'uncertain', 'might be wrong',
];

const FAST_THRESHOLD: Record<RoutePreference, number> = {
  cost: 50,
  balanced: 32,
  quality: 16,
};
const BALANCED_THRESHOLD: Record<RoutePreference, number> = {
  cost: 82,
  balanced: 68,
  quality: 46,
};

export interface RouteCandidateMeta {
  candidate: RouteCandidate;
  kind: ProviderKind;
  contextWindow?: number;
  price?: Price;
  available: boolean;
  budgetBlocked: boolean;
}

export interface RouteSignals {
  messageText: string;
  hasImage: boolean;
  contextTokens: number;
  previousFailed: boolean;
  uncertain: boolean;
  toolDepth: number;
  delegation: DelegationStrategy;
  /** 子代理会话：偏好快速档。 */
  subagent: boolean;
  /** 0–1；缺省由配额预估推导。 */
  budgetPressure?: number;
  judge?: 'easy' | 'medium' | 'hard';
}

export function tierIndexOf(tier: ModelTier): number {
  return TIERS.indexOf(tier);
}

export function tierOfIndex(index: number): ModelTier {
  return TIERS[Math.max(0, Math.min(2, index))]!;
}

export function routingSettingsOf(host: Host): ModelRoutingSettings | undefined {
  return normalizeRoutingSettings(host.config.modelRouting);
}

/** 从本轮用户消息与运行态提取难度信号。 */
export function routeSignalsOf(
  host: Host,
  rec: SessionRecord,
  turnMessage: { content: ContentBlock[] } | undefined,
  toolDepth: number,
  previousFailed: boolean,
): RouteSignals {
  const content = turnMessage?.content ?? [];
  const messageText = content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const hasImage = content.some((block) => block.type === 'image');
  const uncertain = lastAssistantUncertain(rec);
  const quota = host.estimateQuota(rec);
  const budgetPercent = Math.max(
    0,
    ...host
      .budgets.status()
      .filter((status) =>
        (!status.profileId || status.profileId === rec.profileId) &&
        (!status.groupId || status.groupId === rec.groupId) &&
        (!status.model || status.model === rec.model),
      )
      .map((status) => status.percent),
  );
  const turnsLeft = quota.turnsLeft;
  let budgetPressure = 0;
  if (budgetPercent >= 80 || (turnsLeft !== undefined && turnsLeft <= 3)) budgetPressure = 1;
  else if (budgetPercent >= 60 || (turnsLeft !== undefined && turnsLeft <= 10)) budgetPressure = 0.5;
  return {
    messageText,
    hasImage,
    contextTokens: rec.context?.usedTokens ?? 0,
    previousFailed,
    uncertain,
    toolDepth,
    delegation: host.delegationFor(rec),
    subagent: (rec.depth ?? 0) > 0,
    budgetPressure,
  };
}

function lastAssistantUncertain(rec: SessionRecord): boolean {
  for (let i = rec.messages.length - 1; i >= 0; i -= 1) {
    const message = rec.messages[i]!;
    if (message.role !== 'assistant' || message.notice || message.summary) continue;
    const body = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .toLowerCase();
    return UNCERTAIN.some((word) => body.includes(word.toLowerCase()));
  }
  return false;
}

/** 模型返回的内容看起来是坏 JSON（例如本该给 JSON 却截断/加解释）。 */
export function looksLikeInvalidJson(textValue: string): boolean {
  const value = textValue.trim();
  if (!value.startsWith('{') && !value.startsWith('[')) return false;
  try {
    JSON.parse(value);
    return false;
  } catch {
    return true;
  }
}

export function scoreRoute(input: RouteSignals, preference: RoutePreference, state: SessionRecord['routeState']): RouteScores {
  const lower = input.messageText.toLowerCase();
  const hard = HARD_KEYWORDS.filter((word) => lower.includes(word));
  const easy = EASY_KEYWORDS.filter((word) => lower.includes(word));
  const chars = input.messageText.length;
  let complexity = 30;
  if (chars > 240) complexity += 25;
  else if (chars > 120) complexity += 18;
  else if (chars > 50) complexity += 10;
  else if (chars > 0 && chars < 14) complexity -= 10;
  complexity += Math.min(30, hard.length * 14);
  complexity -= Math.min(25, easy.length * 14);
  if (input.hasImage) complexity += 18;
  if (input.contextTokens > 120_000) complexity += 12;
  else if (input.contextTokens > 60_000) complexity += 6;
  if (input.previousFailed) complexity += 35;
  if (input.uncertain) complexity += 15;
  complexity += Math.min(18, input.toolDepth * 5);
  if (input.subagent) complexity -= 20;
  else if (input.delegation === 'orchestrate') complexity += 10;
  if (input.judge === 'hard') complexity += 30;
  else if (input.judge === 'easy') complexity -= 20;
  if (input.budgetPressure !== undefined && input.budgetPressure >= 0.5 && preference !== 'quality') {
    complexity -= input.budgetPressure >= 1 ? 18 : 9;
  }
  complexity = Math.max(0, Math.min(100, Math.round(complexity)));
  return {
    complexity,
    messageChars: chars,
    keywords: [...hard, ...easy].slice(0, 6),
    hasImage: input.hasImage,
    contextTokens: input.contextTokens,
    toolDepth: input.toolDepth,
    previousFailed: input.previousFailed,
    uncertain: input.uncertain,
    delegation: input.delegation,
    budgetPressure: input.budgetPressure ?? 0,
    preference,
    tierBias: state?.tierBias ?? 0,
    simpleSuccesses: state?.simpleSuccesses ?? 0,
    toolFailStreak: state?.toolFailStreak ?? 0,
    ...(input.judge ? { judge: input.judge } : {}),
  };
}

function metaPriceScore(meta: RouteCandidateMeta): number {
  if (!meta.price) return 20;
  return meta.price.input + meta.price.output;
}

function pickInTier(metas: RouteCandidateMeta[], tier: ModelTier, preference: RoutePreference): RouteCandidateMeta | undefined {
  const list = metas.filter((meta) => meta.candidate.tier === tier);
  if (list.length === 0) return undefined;
  const sorted = [...list].sort((a, b) => {
    if (preference === 'quality') return metaPriceScore(b) - metaPriceScore(a);
    return metaPriceScore(a) - metaPriceScore(b);
  });
  return sorted[0];
}

function nearestTier(metas: RouteCandidateMeta[], target: number, preference: RoutePreference): { meta?: RouteCandidateMeta; tier?: ModelTier } {
  const order = [0, 1, -1, 2, -2];
  for (const delta of order) {
    const index = target + delta;
    if (index < 0 || index > 2) continue;
    const tier = TIERS[index]!;
    const meta = pickInTier(metas, tier, preference);
    if (meta) return { meta, tier };
  }
  return {};
}

function reasonFor(input: RouteSignals, scores: RouteScores, finalTier: ModelTier, baseTier: ModelTier): string {
  if (scores.escalated) return '连续失败，升级一档';
  if (scores.downgraded) return '连续简单任务成功，回落一档';
  if (input.judge === 'hard') return '难度判断为困难';
  if (input.judge === 'easy') return '难度判断为简单';
  const hard = HARD_KEYWORDS.filter((word) => input.messageText.toLowerCase().includes(word));
  const easy = EASY_KEYWORDS.filter((word) => input.messageText.toLowerCase().includes(word));
  if (hard.length > 0) return `偏难：${hard.slice(0, 2).join('、')}`;
  if (easy.length > 0) return `简单：${easy.slice(0, 2).join('、')}`;
  if (input.uncertain) return '上轮自述不确定';
  if (input.previousFailed) return '上一轮失败，就高';
  if (input.hasImage) return '本轮含图片';
  if (input.budgetPressure !== undefined && input.budgetPressure >= 0.5) return '预算偏紧，优先省钱';
  if (input.delegation === 'orchestrate') return '编排模式偏强力';
  if (input.toolDepth >= 3) return '工具调用较深';
  if (input.messageText.length > 160) return '用户消息较长';
  if (tierIndexOf(finalTier) > tierIndexOf(baseTier)) return '提高到下一档可用模型';
  if (tierIndexOf(finalTier) < tierIndexOf(baseTier)) return '候选池缺档，使用较低档';
  return '常规任务';
}

/** 选择档位与候选；没有可用候选时返回 undefined（调用方回落到会话原有模型）。 */
export function pickRoute(input: {
  settings: ModelRoutingSettings;
  signals: RouteSignals;
  metas: RouteCandidateMeta[];
  state?: SessionRecord['routeState'];
}): ModelRouteDecision | undefined {
  const { settings, signals, state } = input;
  const scores = scoreRoute(signals, settings.preference, state);
  const baseIndex =
    scores.complexity <= FAST_THRESHOLD[settings.preference]
      ? 0
      : scores.complexity <= BALANCED_THRESHOLD[settings.preference]
        ? 1
        : 2;
  scores.tierBias = state?.tierBias ?? 0;
  const targetIndex = Math.max(
    0,
    Math.min(2, Math.max(baseIndex + scores.tierBias, state?.escalateFloor ?? -1)),
  );
  const baseTier = TIERS[baseIndex]!;
  const metaEligible = input.metas.filter((meta) => {
    if (!meta.available || meta.budgetBlocked) return false;
    if (
      signals.contextTokens > 0 &&
      meta.contextWindow !== undefined &&
      signals.contextTokens > meta.contextWindow * 0.9
    ) {
      return false;
    }
    return true;
  });
  const selected = nearestTier(metaEligible, targetIndex, settings.preference);
  if (!selected.meta || !selected.tier) return undefined;
  if (state?.lastTrigger === 'failure') scores.escalated = true;
  if (state?.lastTrigger === 'simple-success') scores.downgraded = true;
  return {
    profileId: selected.meta.candidate.profileId,
    ...(selected.meta.candidate.groupId ? { groupId: selected.meta.candidate.groupId } : {}),
    model: selected.meta.candidate.model,
    tier: selected.tier,
    reason: reasonFor(signals, scores, selected.tier, baseTier),
    scores,
    at: Date.now(),
  };
}

/** 分组 Key 的可用性（只读，不推进 round-robin 游标）。 */
function candidateAvailable(host: Host, candidate: RouteCandidate, fallbackKey: string): boolean {
  const group = host.groupFor(candidate.profileId, candidate.groupId);
  if (!group?.keys?.length) return !!fallbackKey;
  const now = Date.now();
  return group.keys.some(
    (key) => !key.disabled && !!key.apiKey && (!key.cooldownUntil || key.cooldownUntil <= now),
  );
}

/** 组装候选元数据：过滤过期候选，读取上下文窗口、单价、Key 与预算可用性。 */
export function candidateMetas(host: Host, settings: ModelRoutingSettings): RouteCandidateMeta[] {
  const metas: RouteCandidateMeta[] = [];
  for (const candidate of settings.candidates) {
    const profile = host.profileFor(candidate.profileId, candidate.groupId);
    if (!profile) continue;
    const models = profile.models.length ? profile.models : [profile.defaultModel].filter(Boolean);
    if (!models.includes(candidate.model)) continue;
    const override = overrideFor(profile.modelCapabilities, candidate.model);
    const contextWindow = override?.contextWindow ?? builtinCapabilities(profile.kind, candidate.model).contextWindow;
    const available = candidateAvailable(host, candidate, profile.apiKey);
    const blocked = !!host.budgets.blockingRule({
      profileId: candidate.profileId,
      ...(candidate.groupId ? { groupId: candidate.groupId } : {}),
      model: candidate.model,
    });
    metas.push({
      candidate,
      kind: profile.kind,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(priceForModel(profile, candidate.model) ? { price: priceForModel(profile, candidate.model)! } : {}),
      available,
      budgetBlocked: blocked,
    });
  }
  return metas;
}

export function ensureRouteState(rec: SessionRecord): NonNullable<SessionRecord['routeState']> {
  if (!rec.routeState) {
    rec.routeState = {
      tierBias: 0,
      simpleSuccesses: 0,
      toolFailStreak: 0,
      lastFailed: false,
    };
  }
  return rec.routeState;
}

/** 组装本轮决策并记到会话上；返回 undefined 表示没有可用候选。 */
export function chooseAutoRoute(host: Host, rec: SessionRecord, signals: RouteSignals): ModelRouteDecision | undefined {
  const settings = routingSettingsOf(host);
  if (!settings) return undefined;
  const state = ensureRouteState(rec);
  const decision = pickRoute({
    settings,
    signals,
    metas: candidateMetas(host, settings),
    state,
  });
  if (decision) {
    state.lastTier = decision.tier;
    state.lastModel = decision.model;
    rec.route = decision;
    delete state.escalateFloor;
  }
  if (state.lastTrigger) delete state.lastTrigger;
  return decision;
}

export function noteToolFailure(rec: SessionRecord, results: ContentBlock[]): boolean {
  const state = ensureRouteState(rec);
  let escalated = false;
  for (const block of results) {
    if (block.type !== 'tool_result') continue;
    if (block.isError) {
      state.toolFailStreak += 1;
      if (state.toolFailStreak >= 2) {
        state.tierBias = Math.min(2, state.tierBias + 1);
        state.escalateFloor = Math.min(2, tierIndexOf(state.lastTier ?? 'fast') + 1);
        state.toolFailStreak = 0;
        state.lastTrigger = 'failure';
        escalated = true;
      }
    } else {
      state.toolFailStreak = 0;
    }
  }
  return escalated;
}

export function noteInvalidOutput(rec: SessionRecord): void {
  const state = ensureRouteState(rec);
  state.tierBias = Math.min(2, state.tierBias + 1);
  state.escalateFloor = Math.min(2, tierIndexOf(state.lastTier ?? 'fast') + 1);
  state.toolFailStreak = 0;
  state.lastTrigger = 'failure';
}

export function noteTurnEnd(rec: SessionRecord, reason: 'done' | 'interrupted' | 'error', preference: RoutePreference, hadFailure: boolean): void {
  const state = ensureRouteState(rec);
  if (reason === 'error') state.lastFailed = true;
  else if (reason === 'done') state.lastFailed = false;
  const complexity = rec.route?.scores.complexity;
  const simple =
    reason === 'done' &&
    !hadFailure &&
    complexity !== undefined &&
    complexity <= FAST_THRESHOLD[preference];
  if (simple) {
    state.simpleSuccesses += 1;
    if (state.simpleSuccesses >= 3) {
      state.simpleSuccesses = 0;
      if (state.tierBias > 0) {
        state.tierBias -= 1;
        state.lastTrigger = 'simple-success';
      }
    }
  } else if (reason === 'done' || reason === 'error') {
    state.simpleSuccesses = 0;
  }
}

/** 用小模型做一次极小请求判断难度；失败或超时按无结论处理。 */
export async function judgeDifficulty(host: Host, settings: ModelRoutingSettings, messageText: string): Promise<'easy' | 'medium' | 'hard' | undefined> {
  if (!settings.judge || !messageText.trim()) return undefined;
  const preferred = ['fast', 'balanced', 'power'] as ModelTier[];
  for (const tier of preferred) {
    const candidate = settings.candidates.find((item) => item.tier === tier);
    if (!candidate) continue;
    const profile = host.profileFor(candidate.profileId, candidate.groupId);
    const keys = host.keyCandidates(candidate.profileId, candidate.groupId);
    const key = keys.candidates.find((item) => item.profile.apiKey);
    if (!profile || !key) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const raw = await completeText({
        profile: key.profile,
        model: candidate.model,
        system: '你只输出一个词：easy、medium 或 hard。不要解释。',
        prompt: `判断这个任务对编码 agent 的难度：\n${messageText.slice(0, 1200)}`,
        maxTokens: 8,
        signal: controller.signal,
      });
      const word = raw.trim().toLowerCase();
      if (word.includes('hard')) return 'hard';
      if (word.includes('easy')) return 'easy';
      if (word.includes('medium')) return 'medium';
      return undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}

/** 对比「全程使用最强候选」的估算节省；没有价格时不计入。 */
export function recordRouteSavings(
  host: Host,
  rec: SessionRecord,
  usage: NonNullable<import('@tandem/protocol').Message['usage']>,
  actualCost: number | undefined,
): void {
  if (actualCost === undefined) return;
  const settings = routingSettingsOf(host);
  if (!settings) return;
  const sorted = [...settings.candidates].sort((a, b) => tierIndexOf(b.tier) - tierIndexOf(a.tier));
  const baseline = sorted[0];
  if (!baseline) return;
  const profile = host.profileFor(baseline.profileId, baseline.groupId);
  const price = profile ? priceForModel(profile, baseline.model) : undefined;
  if (!profile || !price) return;
  const baselineCost = costOfUsage(price, usage, profile.kind);
  const saved = (rec.routeSavings?.savedUsd ?? 0) + (baselineCost - actualCost);
  rec.routeSavings = {
    savedUsd: Math.round(saved * 1e8) / 1e8,
    baselineModel: baseline.model,
    calls: (rec.routeSavings?.calls ?? 0) + 1,
  };
}
