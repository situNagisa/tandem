import type { Profile } from '@tandem/protocol'

export interface ProfileModelGroup {
  /** 无分组账号为 undefined。 */
  groupId?: string
  name: string
  models: string[]
}

/** 账号可选的模型：有分组时按分组展开，老账号仍返回单一组。 */
export function profileModelGroups(profile: Profile | undefined | null): ProfileModelGroup[] {
  if (!profile) return []
  if (profile.groups?.length) {
    return profile.groups
      .map((g) => ({
        groupId: g.id,
        name: g.name,
        models: (g.models ?? []).length ? g.models : [g.defaultModel].filter(Boolean),
      }))
      .filter((g) => g.models.length > 0)
  }
  const models = (profile.models ?? []).length
    ? profile.models
    : [profile.defaultModel].filter(Boolean)
  return models.length ? [{ name: '默认', models }] : []
}

/** 账号（或其第一个分组）的默认选择。 */
export function defaultChoiceFor(
  profile: Profile | undefined,
): { groupId?: string; model: string } | null {
  if (!profile) return null
  if (profile.groups?.length) {
    const g = profile.groups[0]
    return { groupId: g.id, model: g.defaultModel || g.models[0] || '' }
  }
  return { model: profile.defaultModel || profile.models[0] || '' }
}

export function groupName(profile: Profile | undefined, groupId: string | undefined): string {
  if (!profile || !groupId) return ''
  return profile.groups?.find((g) => g.id === groupId)?.name ?? ''
}
