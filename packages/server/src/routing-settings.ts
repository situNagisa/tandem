// 自动路由设置的归一化（纯函数；config 与路由共用，避免循环依赖）。
import type {
  DelegationStrategy,
  DivisionRoutingSettings,
  DomainRoute,
  ModelRoutingSettings,
  ModelTier,
  RouteAssignment,
  RouteCandidate,
  RouteDomain,
  RoutePreference,
  TurnRouteOverride,
} from '@tandem/protocol';

export const MODEL_TIERS: ModelTier[] = ['fast', 'balanced', 'power'];
export const ROUTE_PREFERENCES: RoutePreference[] = ['cost', 'balanced', 'quality'];
export const DELEGATIONS: DelegationStrategy[] = ['more', 'less', 'none'];

/** 分工取值；已移除的「仅规划」(orchestrate) 旧数据并入「积极」。 */
export function normalizeDelegation(value: unknown): DelegationStrategy | undefined {
  if (value === 'orchestrate') return 'more';
  return DELEGATIONS.includes(value as DelegationStrategy) ? (value as DelegationStrategy) : undefined;
}

export function normalizeRouteBias(value: unknown): RoutePreference | undefined {
  return ROUTE_PREFERENCES.includes(value as RoutePreference) ? (value as RoutePreference) : undefined;
}

/** 一次性覆盖（发送消息时附带）：只保留合法字段，全空返回 undefined。 */
export function normalizeRouteOverride(value: unknown): TurnRouteOverride | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const delegation = normalizeDelegation(raw.delegation);
  const routeBias = normalizeRouteBias(raw.routeBias);
  if (!delegation && !routeBias) return undefined;
  return {
    ...(delegation ? { delegation } : {}),
    ...(routeBias ? { routeBias } : {}),
  };
}

export const ROUTE_DOMAINS: RouteDomain[] = [
  'ui',
  'backend',
  'test',
  'docs',
  'data',
  'ops',
  'general',
];

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberIn(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function assignmentOf(value: unknown): RouteAssignment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const profileId = text(row.profileId);
  const model = text(row.model);
  if (!profileId || !model) return undefined;
  const groupId = text(row.groupId);
  const tier = text(row.tier) as ModelTier | undefined;
  return {
    profileId,
    ...(groupId ? { groupId } : {}),
    model,
    ...(tier && MODEL_TIERS.includes(tier) ? { tier } : {}),
  };
}

function normalizeDivision(value: unknown): DivisionRoutingSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const planner = assignmentOf(raw.planner);
  const executor = assignmentOf(raw.executor);
  const reviewer = assignmentOf(raw.reviewer);
  const domains: DomainRoute[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.domains)) {
    for (const item of raw.domains) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const domain = text(row.domain) as RouteDomain | undefined;
      if (!domain || !ROUTE_DOMAINS.includes(domain) || seen.has(domain)) continue;
      const assignment = assignmentOf(row);
      if (!assignment) continue;
      seen.add(domain);
      const note = text(row.note);
      domains.push({
        ...assignment,
        domain,
        minComplexity: numberIn(row.minComplexity, 0, 100) ?? 55,
        ...(note ? { note } : {}),
      });
    }
  }
  const planThreshold = numberIn(raw.planThreshold, 0, 100);
  const reviewThreshold = numberIn(raw.reviewThreshold, 0, 100);
  const costCap =
    typeof raw.costCapUsdPerTurn === 'number' &&
    Number.isFinite(raw.costCapUsdPerTurn) &&
    raw.costCapUsdPerTurn > 0
      ? raw.costCapUsdPerTurn
      : undefined;
  const confirm =
    raw.confirm === 'never' || raw.confirm === 'always' || raw.confirm === 'expensive'
      ? raw.confirm
      : undefined;
  const confirmOverUsd =
    typeof raw.confirmOverUsd === 'number' && Number.isFinite(raw.confirmOverUsd) && raw.confirmOverUsd >= 0
      ? raw.confirmOverUsd
      : undefined;
  const learned: import('@tandem/protocol').LearnedRoutePreference[] = [];
  if (Array.isArray(raw.learned)) {
    for (const item of raw.learned) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const key = text(row.key);
      const domain = text(row.domain) as RouteDomain | undefined;
      const mode = text(row.mode) as import('@tandem/protocol').TurnRouteMode | undefined;
      const count = numberIn(row.count, 1, 999);
      if (!key || !domain || !ROUTE_DOMAINS.includes(domain) || !count) continue;
      if (mode !== 'direct' && mode !== 'cheap' && mode !== 'division') continue;
      learned.push({
        key,
        domain,
        mode,
        count,
        updatedAt:
          typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)
            ? row.updatedAt
            : Date.now(),
      });
    }
  }
  if (
    !planner &&
    !executor &&
    !reviewer &&
    domains.length === 0 &&
    planThreshold === undefined &&
    costCap === undefined &&
    confirm === undefined &&
    learned.length === 0
  ) {
    return undefined;
  }
  return {
    ...(planner ? { planner } : {}),
    ...(executor ? { executor } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(domains.length ? { domains } : {}),
    ...(planThreshold !== undefined ? { planThreshold } : {}),
    ...(reviewThreshold !== undefined ? { reviewThreshold } : {}),
    ...(costCap !== undefined ? { costCapUsdPerTurn: costCap } : {}),
    ...(confirm ? { confirm } : {}),
    ...(confirmOverUsd !== undefined ? { confirmOverUsd } : {}),
    ...(learned.length ? { learned } : {}),
  };
}

/** 去掉无效候选、去重；候选为空但仍保留非默认偏好/分工设置时同样保存。 */
export function normalizeRoutingSettings(value: unknown): ModelRoutingSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const candidates: RouteCandidate[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.candidates)) {
    for (const item of raw.candidates) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const profileId = text(row.profileId);
      const model = text(row.model);
      const tier = text(row.tier) as ModelTier | undefined;
      if (!profileId || !model || !tier || !MODEL_TIERS.includes(tier)) continue;
      const groupId = text(row.groupId);
      const key = `${profileId}\u0000${groupId ?? ''}\u0000${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ profileId, ...(groupId ? { groupId } : {}), model, tier });
    }
  }
  const preference = ROUTE_PREFERENCES.includes(raw.preference as RoutePreference)
    ? (raw.preference as RoutePreference)
    : 'balanced';
  const division = normalizeDivision(raw.division);
  const native = raw.native === true;
  // 没有候选池时，只有默认（均衡、不判断难度、非原生、无分工）才算「未配置」；
  // 用户单独调整的偏好必须保存，否则设置保存后会被判为未启用并回写旧值（R17）。
  if (candidates.length === 0 && preference === 'balanced' && raw.judge !== true && !native && !division) {
    return undefined;
  }
  return {
    candidates,
    preference,
    ...(raw.judge === true ? { judge: true } : {}),
    ...(native ? { native: true } : {}),
    ...(division ? { division } : {}),
  };
}
