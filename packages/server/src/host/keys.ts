// 账号/分组解析与分组 Key 的轮询、失败冷却。
import { effectiveProfile } from '../config.js';
import {
  classifyKeyFailure,
  cooldownMsFor,
  groupUnavailableError,
  orderedAvailableKeys,
  profileWithKey,
} from '../key-rotation.js';
import { truncateEnd } from '../util/text.js';
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
    groupId?: string): { group?: StoredProfileGroup; effective?: StoredProfile; candidates: Array<{ keyId?: string; label?: string; profile: StoredProfile }>; } {
  const profile = host.profiles.get(profileId);
  if (!profile) return { candidates: [] };
  const effective = effectiveProfile(profile, groupId);
  const group = host.groupFor(profileId, groupId);
  const keys = group?.keys ?? [];
  if (!group || keys.length === 0) {
    return { effective, candidates: [{ profile: effective }] };
  }
  const rotationKey = `${profileId}:${groupId}`;
  const rotate = host.keyRotation.get(rotationKey) ?? 0;
  const available = orderedAvailableKeys(keys, group.keyStrategy, rotate);
  if (group.keyStrategy === 'round_robin' && available.length > 0) {
    host.keyRotation.set(rotationKey, rotate + 1);
  }
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
  if (failure.kind === 'disable') {
    host.profiles.updateKeyState(profileId, groupId, keyId, {
      disabled: true,
      cooldownUntil: undefined,
      lastError: message,
      lastErrorAt: Date.now(),
    });
  } else {
    const failures = (key.failures ?? 0) + 1;
    host.profiles.updateKeyState(profileId, groupId, keyId, {
      failures,
      cooldownUntil: Date.now() + cooldownMsFor(failures),
      lastError: message,
      lastErrorAt: Date.now(),
    });
  }
  return true;
}

export function keysUnavailableMessage(host: Host, profileId: string,
    groupId?: string,
    errors: Map<string, string> = new Map()): string | undefined {
  const group = host.groupFor(profileId, groupId);
  if (!group?.keys?.length) return undefined;
  return groupUnavailableError(group, errors);
}
