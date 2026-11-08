// 自动路由设置的归一化（纯函数；config 与路由共用，避免循环依赖）。
import type {
  DivisionRoutingSettings,
  DomainRoute,
  ModelRoutingSettings,
  ModelTier,
  RouteAssignment,
  RouteCandidate,
  RouteDomain,
  RoutePreference,
} from '@tandem/protocol';

export const MODEL_TIERS: ModelTier[] = ['fast', 'balanced', 'power'];
export const ROUTE_PREFERENCES: RoutePreference[] = ['cost', 'balanced', 'quality'];

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

/** 去掉无效候选、去重；没有任何候选时视为未启用。 */
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
  if (candidates.length === 0) return undefined;
  const preference = ROUTE_PREFERENCES.includes(raw.preference as RoutePreference)
    ? (raw.preference as RoutePreference)
    : 'balanced';
  const division = normalizeDivision(raw.division);
  return {
    candidates,
    preference,
    ...(raw.judge === true ? { judge: true } : {}),
    ...(division ? { division } : {}),
  };
}
