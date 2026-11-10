// 自动模型路由：按本轮信号给难度打分，在用户候选池里选档位；规则的每一步都可解释。
import type {
  AutoRouteSavings,
  ContentBlock,
  DelegationStrategy,
  DivisionRoutingSettings,
  DomainRoute,
  ModelRouteDecision,
  ModelRoutingSettings,
  ModelTier,
  ProviderKind,
  RouteAssignment,
  RouteCandidate,
  RouteDomain,
  RoutePreference,
  RouteRole,
  RoutePlan,
  RouteScores,
  TurnRouteMode,
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

// ---------- 分工路由：规则分类、角色解析与领域推断（零额外模型调用） ----------

export const DOMAIN_LABELS: Record<RouteDomain, string> = {
  ui: '前端 UI',
  backend: '后端',
  test: '测试',
  docs: '文档',
  data: '数据',
  ops: '运维脚本',
  general: '通用',
};

export const ROLE_LABELS: Record<RouteRole, string> = {
  planner: '规划',
  executor: '执行',
  specialist: '专长执行',
  reviewer: '审查',
};

const MECH_RULES: Array<{ label: string; re: RegExp }> = [
  {
    label: '装依赖',
    re: /安装|装一下|装好|装个|添加依赖|npm\s+(i|install)|pnpm\s+(i|install|add)|yarn\s+(add|install)|pip\s+install|cargo\s+add|go\s+get/i,
  },
  {
    label: '跑命令',
    re: /跑一下|运行|执行|跑通|跑一遍|npm\s+(run\s+)?(test|build|lint)|pnpm\s+(test|build|lint)|yarn\s+(test|build|lint)|pytest|vitest|jest|playwright|eslint|tsc\b|构建|编译|打包/i,
  },
  {
    label: '机械改写',
    re: /格式化|format|重命名|rename|批量替换|替换所有|批量修改|改所有|逐个改|生成测试|生成样板|scaffold|加注释|补注释/i,
  },
];
const MULTI_STEP_RE = /批量|所有文件|全项目|逐个|多步|一次改完|然后|接着|再(?!次)|并且|同时|顺便/;
const QUESTION_RE =
  /为什么|怎么|如何|解释|分析一下|看看|审查|评审|评估|比较|区别|是什么|能不能|是否|哪里|why|how|what|explain|review|compare/i;
const DIRECT_RE = /直接做|不要派|别派|不用子代理|不用分工|你自己做|你来改/i;
const ACTION_RE = /修改|改一下|改成|新增|添加|实现|修复|修好|调整|更新|替换|删掉|删除|优化|补上|加上|样式|布局|组件/i;
const CONTEXT_HEAVY_RE =
  /重构|架构|迁移|并发|竞态|死锁|跨模块|分布式|性能|安全|排查|设计|权衡|方案|原理|源码|深入|分析原因|debug|refactor|architect|migrat|concurren|deadlock|race|performance|security/i;

const DOMAIN_RULES: Array<{ domain: RouteDomain; ext?: RegExp; path?: RegExp; keyword?: RegExp }> = [
  {
    domain: 'ui',
    ext: /\.(tsx|jsx|css|scss|sass|less|vue|svelte|html)$/i,
    path: /(^|\/)(components?|pages?|styles?|app|ui|frontend|web)\//i,
    keyword: /前端|样式|界面|组件|按钮|布局|颜色|间距|主题|暗色|响应式|交互|动画|tailwind|react|vue|css|ui\b/i,
  },
  {
    domain: 'test',
    ext: /\.(test|spec)\.[a-z]+$/i,
    path: /(^|\/)(test|tests|__tests__|e2e|spec)\//i,
    keyword: /测试|单测|回归|用例|lint|eslint|vitest|jest|pytest|playwright|覆盖率/i,
  },
  {
    domain: 'docs',
    ext: /\.(md|mdx|txt|rst)$/i,
    path: /(^|\/)(docs?|readme|changelog)\b/i,
    keyword: /文档|说明|注释|readme|changelog|写作|润色/i,
  },
  {
    domain: 'data',
    ext: /\.(sql|csv|parquet|ipynb|jsonl?)$/i,
    path: /(^|\/)(data|db|migrations?|queries)\//i,
    keyword: /数据|数据表|查询|etl|统计|报表|字段|csv|sql/i,
  },
  {
    domain: 'ops',
    ext: /(dockerfile|docker-compose|\.ya?ml|\.sh|makefile)$/i,
    path: /(^|\/)(scripts?|deploy|ops|infra|ci|\.github)\//i,
    keyword: /安装|依赖|构建|部署|启动|运行|编译|打包|环境|docker|ci\b/i,
  },
  {
    domain: 'backend',
    ext: /\.(go|py|java|rs|rb|php|cs)$/i,
    path: /(^|\/)(server|api|routes?|services?|backend|db)\//i,
    keyword: /后端|接口|服务端|数据库|路由|api\b|fastify|express/i,
  },
];

/** 从消息文本与最近工具输入推断领域；最近工具权重更高。 */
export function inferRouteDomain(text: string, toolInputs: string[] = []): RouteDomain {
  const scores = new Map<RouteDomain, number>();
  const add = (domain: RouteDomain, value: number) => {
    scores.set(domain, (scores.get(domain) ?? 0) + value);
  };
  for (const rule of DOMAIN_RULES) {
    if (rule.keyword?.test(text)) add(rule.domain, 2);
  }
  for (const input of toolInputs.slice(-8)) {
    for (const rule of DOMAIN_RULES) {
      if (rule.ext?.test(input) || rule.path?.test(input)) add(rule.domain, 3);
      if (rule.keyword?.test(input)) add(rule.domain, 1);
    }
  }
  let best: RouteDomain = 'general';
  let bestScore = 1;
  for (const [domain, score] of scores) {
    if (score > bestScore) {
      best = domain;
      bestScore = score;
    }
  }
  return best;
}

/** 最近几轮工具调用里的文件路径与命令，用于领域推断。 */
export function recentToolInputs(rec: SessionRecord, limit = 12): string[] {
  const out: string[] = [];
  for (let i = rec.messages.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const message = rec.messages[i]!;
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const input = block.input as Record<string, unknown> | undefined;
      if (!input) continue;
      const parts = ['file_path', 'path', 'command', 'pattern', 'description']
        .map((key) => (typeof input[key] === 'string' ? String(input[key]) : ''))
        .filter(Boolean);
      if (parts.length) out.push(parts.join(' '));
      if (out.length >= limit) break;
    }
  }
  return out;
}

function priceScoreOf(price: Price | undefined): number {
  return price ? price.input + price.output : 20;
}

function inferTierFor(settings: ModelRoutingSettings, assignment: RouteAssignment): ModelTier {
  const candidate = settings.candidates.find(
    (item) =>
      item.profileId === assignment.profileId &&
      (item.groupId ?? '') === (assignment.groupId ?? '') &&
      item.model === assignment.model,
  );
  if (candidate) return candidate.tier;
  if (assignment.tier) return assignment.tier;
  const name = assignment.model.toLowerCase();
  if (/opus|sonnet|gpt-5(?!.*mini)|o3(?!.*mini)|reasoner|ultra|max|pro\b/.test(name)) return 'power';
  if (/haiku|mini|nano|flash|lite|turbo|small|deepseek-chat/.test(name)) return 'fast';
  return 'balanced';
}

function metaForAssignment(
  host: Host,
  settings: ModelRoutingSettings,
  assignment: RouteAssignment,
): RouteCandidateMeta | undefined {
  const profile = host.profileFor(assignment.profileId, assignment.groupId);
  if (!profile) return undefined;
  const models = profile.models.length ? profile.models : [profile.defaultModel].filter(Boolean);
  if (!models.includes(assignment.model)) return undefined;
  const override = overrideFor(profile.modelCapabilities, assignment.model);
  const contextWindow =
    override?.contextWindow ?? builtinCapabilities(profile.kind, assignment.model).contextWindow;
  const price = priceForModel(profile, assignment.model);
  const candidate: RouteCandidate = {
    ...assignment,
    tier: inferTierFor(settings, assignment),
  };
  return {
    candidate,
    kind: profile.kind,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(price ? { price } : {}),
    available: candidateAvailable(host, candidate, profile.apiKey),
    budgetBlocked: !!host.budgets.blockingRule({
      profileId: assignment.profileId,
      ...(assignment.groupId ? { groupId: assignment.groupId } : {}),
      model: assignment.model,
    }),
  };
}

function usableMeta(meta: RouteCandidateMeta | undefined, contextTokens: number): RouteCandidateMeta | undefined {
  if (!meta || !meta.available || meta.budgetBlocked) return undefined;
  if (
    contextTokens > 0 &&
    meta.contextWindow !== undefined &&
    contextTokens > meta.contextWindow * 0.9
  ) {
    return undefined;
  }
  return meta;
}

function strongestMeta(metas: RouteCandidateMeta[], contextTokens: number): RouteCandidateMeta | undefined {
  const usable = metas.filter((meta) => usableMeta(meta, contextTokens));
  return (
    usable
      .filter((meta) => meta.candidate.tier === 'power')
      .sort((a, b) => priceScoreOf(b.price) - priceScoreOf(a.price))[0] ??
    usable.sort((a, b) => tierIndexOf(b.candidate.tier) - tierIndexOf(a.candidate.tier))[0]
  );
}

/** 每个取向对应的子代理/执行者档位（未绑定时使用；绑定优先）。 */
const BIAS_TIER: Record<RoutePreference, ModelTier> = {
  cost: 'fast',
  balanced: 'balanced',
  quality: 'power',
};

/** 取向决定未绑定的执行者/专长用哪一档：省钱=快速档，均衡=均衡档，质量优先=强力档。 */
function tierMeta(metas: RouteCandidateMeta[], bias: RoutePreference, contextTokens: number): RouteCandidateMeta | undefined {
  const usable = metas.filter((meta) => usableMeta(meta, contextTokens));
  return nearestTier(usable, tierIndexOf(BIAS_TIER[bias]), bias).meta;
}

/** 解析角色绑定的实际模型：绑定不可用时按取向选档（执行者/专长）或回落到最强候选（规划者/审查者）。 */
export function resolveDivisionAssignment(
  host: Host,
  settings: ModelRoutingSettings,
  role: RouteRole,
  domain?: RouteDomain,
  bias: RoutePreference = settings.preference,
): RouteCandidateMeta | undefined {
  const division = settings.division ?? {};
  const metas = candidateMetas(host, settings);
  const contextTokens = 0;
  if (role === 'specialist') {
    const route = division.domains?.find((item) => item.domain === domain);
    if (route) {
      const meta = usableMeta(metaForAssignment(host, settings, route), contextTokens);
      if (meta) return meta;
    }
    return tierMeta(metas, bias, contextTokens);
  }
  const assignment =
    role === 'executor' ? division.executor : role === 'reviewer' ? division.reviewer : division.planner;
  if (assignment) {
    const meta = usableMeta(metaForAssignment(host, settings, assignment), contextTokens);
    if (meta) return meta;
  }
  return role === 'executor' ? tierMeta(metas, bias, contextTokens) : strongestMeta(metas, contextTokens);
}


export function departmentAssignmentOf(
  host: Host,
  domain: RouteDomain,
): RouteAssignment | undefined {
  const settings = routingSettingsOf(host);
  const route = settings?.division?.domains?.find((item) => item.domain === domain);
  if (!settings || !route) return undefined;
  const meta = usableMeta(metaForAssignment(host, settings, route), 0);
  return meta?.candidate;
}

export function domainRouteOf(
  host: Host,
  domain: RouteDomain,
): DomainRoute | undefined {
  return routingSettingsOf(host)?.division?.domains?.find((item) => item.domain === domain);
}

export interface TurnPlanContext {
  text: string;
}

function mechanicalLabelsOf(text: string): string[] {
  return MECH_RULES.filter((rule) => rule.re.test(text)).map((rule) => rule.label);
}

/** 用户覆盖偏好的聚合键：领域 + 机械动作。 */
export function learnedKeyFor(text: string, domain: RouteDomain): string {
  return `${domain}:${mechanicalLabelsOf(text).join(',') || 'general'}`;
}

/** 记录一次人工覆盖；同类任务累计后默认采用用户的选择。 */
export function noteLearnedPreference(
  host: Host,
  text: string,
  plan: RoutePlan,
  mode: TurnRouteMode,
): void {
  const settings = routingSettingsOf(host);
  if (!settings) return;
  const key = learnedKeyFor(text, plan.domain);
  const learned = [...(settings.division?.learned ?? [])];
  const index = learned.findIndex((item) => item.key === key && item.mode === mode);
  if (index >= 0) {
    learned[index] = { ...learned[index]!, count: learned[index]!.count + 1, updatedAt: Date.now() };
  } else {
    learned.push({ key, domain: plan.domain, mode, count: 1, updatedAt: Date.now() });
  }
  host.updateSettings({
    modelRouting: {
      ...settings,
      division: { ...(settings.division ?? {}), learned: learned.slice(-40) },
    },
  });
}

/**
 * 规则分类（零模型调用）：本轮是单代理、整单交执行者，还是多代理协作。
 * 分工关闭时不规划（主会话不提供 Task，也不交给执行者）。
 *
 * | 分工 \ 取向 | 省钱 | 均衡 | 质量优先 |
 * |---|---|---|---|
 * | 关闭 | 单代理 | 单代理 | 单代理 |
 * | 适度 | 机械任务整单交执行者；明显独立的多步任务多代理协作 | 明显独立的多步任务多代理协作 | 同均衡，子代理用强力档 |
 * | 积极 | 同省钱；行动类任务尽量拆分，多代理协作 | 行动类任务尽量拆分 | 同均衡，子代理用强力档 |
 */
export function planTurnRoute(
  host: Host,
  rec: SessionRecord,
  input: TurnPlanContext,
): RoutePlan | undefined {
  const settings: ModelRoutingSettings = routingSettingsOf(host) ?? { candidates: [], preference: 'balanced' };
  const delegation = host.delegationFor(rec);
  if (delegation === 'none') return undefined;
  const text = input.text.trim();
  if (!text) return undefined;
  const bias = host.routeBiasFor(rec);
  const signals = routeSignalsOf(host, rec, { content: [{ type: 'text', text }] }, 0, rec.routeState?.lastFailed === true);
  const complexity = scoreRoute(signals, bias, rec.routeState).complexity;
  const division = settings.division;
  const domain = inferRouteDomain(text, recentToolInputs(rec));
  const executorMeta = resolveDivisionAssignment(host, settings, 'executor', domain, bias);
  const specialistMeta = resolveDivisionAssignment(host, settings, 'specialist', domain, bias);
  const domainRoute = division?.domains?.find((item) => item.domain === domain);
  const specialist =
    !!domainRoute &&
    !!specialistMeta &&
    specialistMeta.candidate.profileId === domainRoute.profileId &&
    specialistMeta.candidate.model === domainRoute.model;
  const mechanical = mechanicalLabelsOf(text);
  const base: Omit<RoutePlan, 'mode' | 'reason'> = {
    domain,
    specialist,
    ...(executorMeta ? { executorModel: executorMeta.candidate.model } : {}),
    ...(specialist && specialistMeta ? { specialistModel: specialistMeta.candidate.model } : {}),
  };
  const direct = (reason: string): RoutePlan => ({ ...base, mode: 'direct', reason });

  if (DIRECT_RE.test(text)) return direct('用户要求自己处理');
  const learned = division?.learned?.find(
    (item) => item.key === learnedKeyFor(text, domain) && item.count >= 2,
  );
  if (learned?.mode === 'direct') {
    return direct(`按你此前对同类任务的选择：单代理（${learned.count} 次）`);
  }
  const question = QUESTION_RE.test(text);
  const contextHeavy = CONTEXT_HEAVY_RE.test(text);
  const multiStep = MULTI_STEP_RE.test(text);
  const actionable = ACTION_RE.test(text);
  const planThreshold = division?.planThreshold ?? 55;
  const specialistMin = domainRoute?.minComplexity ?? 55;
  const budgetTight = (signals.budgetPressure ?? 0) >= 0.5;

  if (question && !mechanical.length) return direct('问答/解释，单代理');
  if (contextHeavy && !(mechanical.length >= 2 && multiStep)) {
    return direct('需要大量上下文判断，留在主会话');
  }
  const wholeMessage =
    mechanical.length > 0 &&
    !question &&
    complexity < 50 &&
    text.length <= 240 &&
    !(mechanical.length >= 2 && multiStep);
  if (bias === 'cost' && wholeMessage) {
    return executorMeta
      ? { ...base, mode: 'cheap', reason: `省钱：${mechanical.join('、')}，整单交给执行者` }
      : direct('没有可用的执行模型');
  }
  if (budgetTight) return direct('预算偏紧，单代理');

  const wantsDivision =
    delegation === 'more'
      ? !question && (actionable || mechanical.length > 0 || multiStep) && complexity >= 35
      : (mechanical.length >= 2 && multiStep && complexity >= Math.min(planThreshold, 45)) ||
        (specialist && actionable && complexity >= specialistMin) ||
        (complexity >= 90 && multiStep);
  if (wantsDivision) {
    const reason =
      delegation === 'more'
        ? `多代理协作：积极分工，复杂度 ${complexity}`
        : mechanical.length >= 2 && multiStep && complexity >= Math.min(planThreshold, 45)
          ? `多代理协作：${mechanical.join('、')}，可拆成独立子任务`
          : specialist && actionable && complexity >= specialistMin
            ? `多代理协作：${DOMAIN_LABELS[domain]}专长匹配，复杂度 ${complexity} ≥ ${specialistMin}`
            : `多代理协作：复杂度 ${complexity}，多步任务`;
    return { ...base, mode: 'division', reason };
  }
  return direct(question ? '问答/解释，单代理' : actionable ? '小改动/单步任务，单代理' : '单代理');
}


/** 分工时注入规划者系统提示：只在这一轮生效。 */
export function routePlanPrompt(plan: RoutePlan): string {
  if (plan.mode !== 'division') return '';
  const lines = [
    '[多代理协作 · 本轮]',
    `分类理由：${plan.reason}。`,
    '你是规划者，主会话模型和上下文保持不变。先用只读工具定位，写出 2–5 步计划；只把可独立执行的机械子任务派发出去，不要为了派发而派发。',
    '用 Task 派发时，prompt 必须自包含：目标、相关文件路径、明确步骤、验收命令、不要修改的范围；不要把整段对话粘贴进去。子代理只回传最后一段摘要。',
    plan.executorModel ? `- 执行者：role="executor"（${plan.executorModel}），跑命令、装依赖、批量机械修改、生成/运行测试。` : '',
    plan.specialistModel
      ? `- 专长执行者：role="specialist" domain="${plan.domain}"（${plan.specialistModel}），领域相关的修改优先交给它。`
      : '',
    '收到摘要后由你判断：继续派发、自己只读补查、或收尾。执行失败两次就自己接管或换模型，不要反复重试同一子任务。',
  ];
  return lines.filter(Boolean).join('\n');
}

/** 粗估分工计划花费：执行模型单价 × (prompt 估算 + 800 输出)。 */
export function estimateDivisionPlanCost(host: Host, plan: RoutePlan, prompts: string[], bias: RoutePreference): number {
  const settings = routingSettingsOf(host);
  if (!settings) return 0;
  const role: RouteRole = plan.specialist ? 'specialist' : 'executor';
  const meta = resolveDivisionAssignment(host, settings, role, plan.domain, bias);
  const price = meta?.price;
  if (!price) return 0;
  const inputTokens = prompts.reduce((sum, prompt) => sum + Math.ceil(prompt.length / 3), 0);
  const outputTokens = 800 * Math.max(1, prompts.length);
  return Math.round(((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * 1e6) / 1e6;
}

export function routePlanText(plan: RoutePlan): string {
  const mode =
    plan.mode === 'direct' ? '单代理' : plan.mode === 'cheap' ? '整单交执行者' : '多代理协作';
  const detail =
    plan.mode === 'cheap' && plan.executorModel
      ? ` · ${plan.executorModel}`
      : plan.mode === 'division' && (plan.specialistModel ?? plan.executorModel)
        ? ` · ${plan.specialist ? DOMAIN_LABELS[plan.domain] : '执行'} ${plan.specialistModel ?? plan.executorModel}`
        : '';
  return `${mode}${detail}（理由：${plan.reason}）`;
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
    settings: { ...settings, preference: host.routeBiasFor(rec) },
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
  role?: RouteRole,
): number | undefined {
  if (actualCost === undefined) return undefined;
  const settings = routingSettingsOf(host);
  if (!settings) return undefined;
  const sorted = [...settings.candidates].sort((a, b) => tierIndexOf(b.tier) - tierIndexOf(a.tier));
  const baseline = sorted[0];
  if (!baseline) return undefined;
  const profile = host.profileFor(baseline.profileId, baseline.groupId);
  const price = profile ? priceForModel(profile, baseline.model) : undefined;
  if (!profile || !price) return undefined;
  const baselineCost = costOfUsage(price, usage, profile.kind);
  const saved = baselineCost - actualCost;
  const byRole = { ...(rec.routeSavings?.byRole ?? {}) };
  if (role) {
    const current = byRole[role] ?? { calls: 0, costUsd: 0, savedUsd: 0 };
    byRole[role] = {
      calls: current.calls + 1,
      costUsd: Math.round((current.costUsd + actualCost) * 1e8) / 1e8,
      savedUsd: Math.round((current.savedUsd + saved) * 1e8) / 1e8,
    };
  }
  rec.routeSavings = {
    savedUsd: Math.round(((rec.routeSavings?.savedUsd ?? 0) + saved) * 1e8) / 1e8,
    baselineModel: baseline.model,
    calls: (rec.routeSavings?.calls ?? 0) + 1,
    ...(Object.keys(byRole).length ? { byRole } : {}),
  };
  return saved;
}
