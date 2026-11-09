import type { Profile } from '@tandem/protocol'
import { profileModelGroups } from './profileModels'
import { readJson, writeJson } from './storage'
import { modelPickKey, type ModelPick } from '../components/ui/ModelCascade'

/** 最近/常用模型：记录选择与发送，按使用次数 + 最近时间排序（反馈 #7-04）。 */
export interface RecentModelUse extends ModelPick {
  count: number
  lastUsedAt: number
}

const KEY = 'tandem.recentModels.v1'
const MAX_ENTRIES = 60

function read(): RecentModelUse[] {
  const parsed = readJson<unknown>(KEY, [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is RecentModelUse => {
    if (!item || typeof item !== 'object') return false
    const entry = item as Partial<RecentModelUse>
    return (
      typeof entry.profileId === 'string' &&
      typeof entry.model === 'string' &&
      typeof entry.count === 'number' &&
      typeof entry.lastUsedAt === 'number' &&
      (entry.groupId === undefined || typeof entry.groupId === 'string')
    )
  })
}

function write(entries: RecentModelUse[]): void {
  writeJson(KEY, entries)
}

/** 记录一次使用；同一账号/分组/模型累加次数并刷新时间。 */
export function recordModelUse(pick: ModelPick, at = Date.now()): void {
  if (!pick.profileId || !pick.model) return
  const key = modelPickKey(pick)
  const entries = read()
  const existing = entries.find((entry) => modelPickKey(entry) === key)
  if (existing) {
    existing.count += 1
    existing.lastUsedAt = at
  } else {
    entries.push({
      profileId: pick.profileId,
      ...(pick.groupId ? { groupId: pick.groupId } : {}),
      model: pick.model,
      count: 1,
      lastUsedAt: at,
    })
  }
  entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  write(entries.slice(0, MAX_ENTRIES))
}

function score(entry: RecentModelUse, now: number): number {
  const ageDays = Math.max(0, (now - entry.lastUsedAt) / 86_400_000)
  return entry.count + Math.max(0, 2 - ageDays / 7)
}

/**
 * 已经不可用（账号/分组/模型被删除）的记录会被过滤；
 * 跨账号分组一起排序，最多返回 limit 个。
 */
export function rankRecentModels(profiles: Profile[], limit = 6): RecentModelUse[] {
  const byKey = new Map<string, RecentModelUse>()
  for (const profile of profiles) {
    for (const group of profileModelGroups(profile)) {
      for (const model of group.models) {
        const pick: ModelPick = {
          profileId: profile.id,
          ...(group.groupId ? { groupId: group.groupId } : {}),
          model,
        }
        byKey.set(modelPickKey(pick), {
          ...pick,
          count: 0,
          lastUsedAt: 0,
        })
      }
    }
  }
  const now = Date.now()
  const available = read()
    .map((entry) => {
      const base = byKey.get(modelPickKey(entry))
      return base ? { ...base, count: entry.count, lastUsedAt: entry.lastUsedAt } : null
    })
    .filter((entry): entry is RecentModelUse => !!entry)
  available.sort((a, b) => {
    const diff = score(b, now) - score(a, now)
    return diff !== 0 ? diff : b.lastUsedAt - a.lastUsedAt
  })
  return available.slice(0, limit)
}
