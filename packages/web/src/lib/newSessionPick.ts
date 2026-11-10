import type { Profile, ReasoningEffort } from '@tandem/protocol'
import { EFFORTS } from './effort'
import { profileModelGroups } from './profileModels'
import { readJson, writeJson } from './storage'

/** 新会话页上次选的账号、分组、模型与思考强度，按主机记住。 */
export interface NewSessionPick {
  profileId?: string
  groupId?: string
  model?: string
  effort?: ReasoningEffort
}

const KEY = 'tandem.newSessionPick.v1'

function readAll(): Record<string, NewSessionPick> {
  const parsed = readJson<unknown>(KEY, {})
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, NewSessionPick>)
    : {}
}

export function loadNewSessionPick(hostId: string): NewSessionPick | undefined {
  const entry = readAll()[hostId]
  if (!entry || typeof entry !== 'object') return undefined
  return {
    ...(typeof entry.profileId === 'string' ? { profileId: entry.profileId } : {}),
    ...(typeof entry.groupId === 'string' ? { groupId: entry.groupId } : {}),
    ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
    ...(EFFORTS.includes(entry.effort as ReasoningEffort) ? { effort: entry.effort } : {}),
  }
}

export function rememberNewSessionPick(hostId: string, patch: NewSessionPick): void {
  const all = readAll()
  all[hostId] = { ...all[hostId], ...patch }
  writeJson(KEY, all)
}

/** 记住的账号、分组或模型已不存在时返回 null，由调用方回落到默认选择。 */
export function resolveNewSessionPick(
  profiles: Profile[],
  saved: NewSessionPick | undefined,
): { profileId: string; groupId?: string; model: string } | null {
  if (!saved?.profileId || !saved.model) return null
  const profile = profiles.find((item) => item.id === saved.profileId)
  if (!profile) return null
  const group = profileModelGroups(profile).find(
    (item) => (item.groupId ?? '') === (saved.groupId ?? ''),
  )
  if (!group) return null
  if (saved.model !== 'auto' && !group.models.includes(saved.model)) return null
  return {
    profileId: profile.id,
    ...(group.groupId ? { groupId: group.groupId } : {}),
    model: saved.model,
  }
}
