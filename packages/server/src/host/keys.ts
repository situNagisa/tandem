// 账号/分组解析与分组 Key 的轮询、失败冷却。
import { effectiveProfile } from '../config.js';
import {
  classifyKeyFailure,
  cooldownMsFor,
  groupUnavailableError,
  profileWithKey,
  rotateKeyCandidates,
} from '../key-rotation.js';
import { truncateEnd } from '../util/text.js';
import type { KeyQuota } from '@tandem/protocol';
import type { ProviderRateLimit } from '../providers/types.js';
import type { StoredProfile, StoredProfileGroup } from '../types.js';
import type { Host } from '../host.js';

export function profileFor(host: Host, profileId: string, groupId?: string): StoredProfile | undefined {
  const profile = host.profiles.get(profileId);
  return profile ? effectiveProfile(profile, groupId) : undefined;
}

export function groupFor(host: Host, profileId: string, groupId?: string): StoredProfileGroup | undefined {
  return groupId ? host.profiles.get(profileId)?.groups?.find((g) => g.id === groupId) : undefined;
}

export function findModelForAlias(host: Host, alias: string,
    preferredProfileId: string,
    preferredGroupId?: string): { profileId: string; groupId?: string; model: string } | undefined {
  const profiles = host.profiles
    .list()
    .slice()
    .sort((a, b) => (a.id === preferredProfileId ? -1 : b.id === preferredProfileId ? 1 : 0));
  for (const profile of profiles) {
    const groups = profile.groups?.length
      ? profile.groups
          .slice()
          .sort((a, b) =>
            profile.id === preferredProfileId && a.id === preferredGroupId
              ? -1
              : profile.id === preferredProfileId && b.id === preferredGroupId
                ? 1
                : 0,
          )
      : [undefined];
    for (const group of groups) {
      const effective = effectiveProfile(profile, group?.id);
      const models = effective.models?.length ? effective.models : [effective.defaultModel];
      const model = models.find((item) => item.toLowerCase().includes(alias));
      if (model) {
        return {
          profileId: profile.id,
          ...(group?.id && group.id !== preferredGroupId ? { groupId: group.id } : group?.id ? { groupId: group.id } : {}),
          model,
        };
      }
    }
  }
  return undefined;
}

export function keyCandidates(host: Host, profileId: string,
    groupId?: string,
    options: { includeCooling?: boolean } = {}): { group?: StoredProfileGroup; effective?: StoredProfile; candidates: Array<{ keyId?: string; label?: string; profile: StoredProfile }>; } {
  const profile = host.profiles.get(profileId);
  if (!profile) return { candidates: [] };
  const effective = effectiveProfile(profile, groupId);
  // 账号级模型账号：主机没有 Key，Key 轮询/冷却在工作站完成，这里固定一个候选。
  if (profile.proxied) return { effective, candidates: [{ profile: effective }] };
  const group = host.groupFor(profileId, groupId);
  const keys = group?.keys ?? [];
  if (!group || keys.length === 0) {
    return { effective, candidates: [{ profile: effective }] };
  }
  const rotationKey = `${profileId}:${groupId}`;
  // 用户选过「继续使用当前分组」或关闭了交接：冷却中的 Key 也拿来试一次，
  // 让回合真正打到上游，而不是在本机直接被冷却拦住。
  const available = options.includeCooling
    ? keys.filter((key) => !key.disabled)
    : rotateKeyCandidates(keys, group.keyStrategy, host.keyRotation, rotationKey);
  return {
    group,
    effective,
    candidates: available.map((key) => ({
      keyId: key.id,
      ...(key.label ? { label: key.label } : {}),
      profile: profileWithKey(effective, key),
    })),
  };
}

export function markKeySuccess(host: Host, profileId: string, groupId: string | undefined, keyId?: string): void {
  if (!keyId || !groupId) return;
  const key = host.groupFor(profileId, groupId)?.keys?.find((k) => k.id === keyId);
  if (!key) return;
  if (!key.failures && !key.cooldownUntil && !key.lastError) return;
  host.profiles.updateKeyState(profileId, groupId, keyId, {
    failures: undefined,
    cooldownUntil: undefined,
    lastError: undefined,
    lastErrorAt: undefined,
  });
}

export function markKeyFailure(host: Host, profileId: string,
    groupId: string | undefined,
    keyId: string | undefined,
    err: unknown): boolean {
  if (!keyId || !groupId) return false;
  const key = host.groupFor(profileId, groupId)?.keys?.find((k) => k.id === keyId);
  if (!key) return false;
  const failure = classifyKeyFailure(err);
  if (failure.kind === 'none') return false;
  const message = truncateEnd(failure.message, 300);
  const now = Date.now();
  const rateLimit = (err as { rateLimit?: ProviderRateLimit } | undefined)?.rateLimit;
  const retryAfter = (err as { retryAfterMs?: number } | undefined)?.retryAfterMs;
  const quotaPatch = rateLimit ? mergeQuota(key.quota, rateLimit) : undefined;
  const rateLimitHits =
    failure.status === 429 || rateLimit
      ? (key.rateLimitHits ?? 0) + 1
      : key.rateLimitHits;
  if (failure.kind === 'disable') {
    host.profiles.updateKeyState(profileId, groupId, keyId, {
      disabled: true,
      cooldownUntil: undefined,
      lastError: message,
      lastErrorAt: now,
      ...(quotaPatch ? { quota: quotaPatch } : {}),
      ...(rateLimitHits ? { rateLimitHits } : {}),
    });
  } else {
    const failures = (key.failures ?? 0) + 1;
    // 429 带了重置时间就等到额度真正恢复，而不是指数退避后再次撞墙
    const resetCandidates = [
      rateLimit?.resetRequestsAt,
      rateLimit?.resetTokensAt,
      rateLimit?.unifiedResetAt,
      retryAfter !== undefined ? now + retryAfter : undefined,
    ].filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > now,
    );
    const cooldownUntil = resetCandidates.length
      ? Math.max(now + 1000, Math.min(...resetCandidates))
      : now + cooldownMsFor(failures);
    host.profiles.updateKeyState(profileId, groupId, keyId, {
      failures,
      cooldownUntil,
      lastError: message,
      lastErrorAt: now,
      ...(quotaPatch ? { quota: quotaPatch } : {}),
      ...(rateLimitHits ? { rateLimitHits } : {}),
    });
  }
  return true;
}

/** 合并响应头额度，保留之前已知但本次没返回的字段。 */
function mergeQuota(previous: KeyQuota | undefined, info: ProviderRateLimit): KeyQuota {
  return {
    ...(previous ?? {}),
    ...(info.remainingRequests !== undefined ? { remainingRequests: info.remainingRequests } : {}),
    ...(info.limitRequests !== undefined ? { limitRequests: info.limitRequests } : {}),
    ...(info.remainingTokens !== undefined ? { remainingTokens: info.remainingTokens } : {}),
    ...(info.limitTokens !== undefined ? { limitTokens: info.limitTokens } : {}),
    ...(info.resetRequestsAt !== undefined ? { resetRequestsAt: info.resetRequestsAt } : {}),
    ...(info.resetTokensAt !== undefined ? { resetTokensAt: info.resetTokensAt } : {}),
    updatedAt: Date.now(),
  };
}

export function keysUnavailableMessage(host: Host, profileId: string,
    groupId?: string,
    errors: Map<string, string> = new Map()): string | undefined {
  const group = host.groupFor(profileId, groupId);
  if (!group?.keys?.length) return undefined;
  return groupUnavailableError(group, errors);
}
