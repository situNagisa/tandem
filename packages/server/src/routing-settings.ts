// 自动路由设置的归一化（纯函数；config 与路由共用，避免循环依赖）。
import type {
  ModelRoutingSettings,
  ModelTier,
  RouteCandidate,
  RoutePreference,
} from '@tandem/protocol';

export const MODEL_TIERS: ModelTier[] = ['fast', 'balanced', 'power'];
export const ROUTE_PREFERENCES: RoutePreference[] = ['cost', 'balanced', 'quality'];

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
  return {
    candidates,
    preference,
    ...(raw.judge === true ? { judge: true } : {}),
  };
}
