// 会话交接的纯逻辑：默认策略、备用分组选择、等待时间与卡片文案。
import type {
  HandoffPeer,
  HandoffPolicy,
  HandoffReason,
  HandoffSettings,
  HandoffState,
  Profile,
} from '@tandem/protocol';
import type { StoredProfile, StoredProfileGroup, StoredProfileKey } from './types.js';

export const DEFAULT_HANDOFF_SETTINGS: HandoffSettings = { policy: 'ask' };
const KEY_COOLDOWN_FALLBACK_MS = 60_000;

export function normalizeHandoffSettings(value: unknown): HandoffSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<HandoffSettings>;
  const policy: HandoffPolicy = raw.policy === 'switch' || raw.policy === 'wait' ? raw.policy : 'ask';
  const targetRaw = raw.target;
  const target =
    targetRaw && typeof targetRaw === 'object' && typeof targetRaw.profileId === 'string' && targetRaw.profileId.trim()
      ? {
          profileId: targetRaw.profileId.trim(),
          ...(typeof targetRaw.groupId === 'string' && targetRaw.groupId.trim()
            ? { groupId: targetRaw.groupId.trim() }
            : {}),
          ...(typeof targetRaw.model === 'string' && targetRaw.model.trim()
            ? { model: targetRaw.model.trim() }
            : {}),
        }
      : undefined;
  return { policy, ...(target ? { target } : {}) };
}

export function handoffSettings(value: unknown): HandoffSettings {
  return normalizeHandoffSettings(value) ?? { ...DEFAULT_HANDOFF_SETTINGS };
}

function keyAvailable(key: StoredProfileKey, now: number): boolean {
  if (key.disabled) return false;
  return !key.cooldownUntil || key.cooldownUntil <= now;
}

/** 分组是否还有可用 Key（无 Key 时回落到账号 Key）。 */
export function groupUsable(group: StoredProfileGroup | undefined, now = Date.now()): boolean {
  if (!group) return false;
  const keys = group.keys ?? [];
  if (keys.length === 0) return true;
  return keys.some((key) => keyAvailable(key, now));
}

export function peerLabel(profile: Profile | StoredProfile, groupId?: string): string {
  if (!groupId) return profile.name;
  const group = profile.groups?.find((item) => item.id === groupId);
  return group ? `${profile.name} › ${group.name}` : profile.name;
}

export function peerOf(
  profile: Profile | StoredProfile,
  groupId: string | undefined,
  model?: string,
): HandoffPeer {
  return {
    profileId: profile.id,
    ...(groupId ? { groupId } : {}),
    ...(model ? { model } : {}),
    label: peerLabel(profile, groupId),
  };
}

/** 组内候选模型：优先保持当前模型，其次目标分组默认模型。 */
function modelForGroup(group: StoredProfileGroup | undefined, currentModel: string, override?: string): string {
  if (override) return override;
  if (group?.models.includes(currentModel)) return currentModel;
  return group?.defaultModel || group?.models[0] || currentModel;
}

/**
 * 按「当前分组的备用链 → 设置里的默认目标」选第一个可用分组。
 * 返回 undefined 表示没有可切换的目标。
 */
export function selectHandoffTarget(
  profiles: StoredProfile[],
  current: { profileId: string; groupId?: string; model: string },
  settings: HandoffSettings,
  now = Date.now(),
): HandoffPeer | undefined {
  const currentProfile = profiles.find((item) => item.id === current.profileId);
  const currentGroup = currentProfile?.groups?.find((item) => item.id === current.groupId);
  const seen = new Set<string>();
  const consider = (profileId: string, groupId: string | undefined, overrideModel?: string): HandoffPeer | undefined => {
    const key = `${profileId}:${groupId ?? ''}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    if (profileId === current.profileId && (groupId ?? '') === (current.groupId ?? '')) return undefined;
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return undefined;
    const group = groupId ? profile.groups?.find((item) => item.id === groupId) : undefined;
    if (groupId && !group) return undefined;
    if (group && !groupUsable(group, now)) return undefined;
    const model = modelForGroup(group, current.model, overrideModel);
    if (!model) return undefined;
    if (profileId === current.profileId && (groupId ?? '') === (current.groupId ?? '') && model === current.model) {
      return undefined;
    }
    return peerOf(profile, groupId, model);
  };

  for (const groupId of currentGroup?.fallbackGroupIds ?? []) {
    const target = consider(current.profileId, groupId);
    if (target) return target;
  }
  if (settings.target) {
    const target = consider(
      settings.target.profileId,
      settings.target.groupId,
      settings.target.model,
    );
    if (target) return target;
  }
  return undefined;
}

/** 预计恢复时间：优先 Key 的重置/冷却，其次预算周期重置；都没有时按 1 分钟。 */
export function handoffResumeAt(
  group: StoredProfileGroup | undefined,
  budgetResetAt: number | undefined,
  now = Date.now(),
): number {
  const times: number[] = [];
  for (const key of group?.keys ?? []) {
    if (key.cooldownUntil && key.cooldownUntil > now) times.push(key.cooldownUntil);
    if (key.quota?.resetRequestsAt && key.quota.resetRequestsAt > now) times.push(key.quota.resetRequestsAt);
    if (key.quota?.resetTokensAt && key.quota.resetTokensAt > now) times.push(key.quota.resetTokensAt);
  }
  if (budgetResetAt && budgetResetAt > now) times.push(budgetResetAt);
  return times.length ? Math.min(...times) : now + KEY_COOLDOWN_FALLBACK_MS;
}

export function handoffReasonText(reason: HandoffReason): string {
  switch (reason) {
    case 'ratelimit':
      return '额度将尽';
    case 'budget':
      return '预算即将到达上限';
    case 'forecast':
      return '预计 2 轮内额度耗尽';
  }
}

export function handoffMessage(from: HandoffPeer, reason: HandoffReason): string {
  return `${from.label} ${handoffReasonText(reason)}。继续方式：`;
}

export function handoffWaitText(resumeAt: number | undefined, now = Date.now()): string {
  if (!resumeAt) return '等待额度重置';
  const minutes = Math.max(1, Math.round((resumeAt - now) / 60_000));
  return `等待额度重置（约 ${minutes} 分钟后自动继续）`;
}

export function formatHandoffTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 交接完成后写入会话的提示行。 */
export function handoffNotice(state: HandoffState): string {
  const from = state.from.model ? `${state.from.label}（${state.from.model}）` : state.from.label;
  const to = state.target
    ? `${state.target.label}（${state.target.model ?? ''}）`
    : '（未选择目标）';
  return `已从 ${from} 交接到 ${to}${state.checkpointId ? ' · 已保存检查点' : ''}`;
}
