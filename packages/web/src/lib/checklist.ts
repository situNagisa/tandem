/** 体验清单：进度持久化、排序与测试报告。 */
import { CHANGELOG } from './changelog'
import {
  FEATURE_BY_ID,
  FEATURE_GROUPS,
  PRODUCT_FEATURES,
  type FeatureGroupId,
  type ProductFeature,
} from './features'
import { readJson, writeJson } from './storage'
import { TEST_POINTS, type TestPoint } from './testPoints'

export type ChecklistStatus = 'pass' | 'fail' | 'skip'

export interface ChecklistProgressEntry {
  status: ChecklistStatus
  at: number
}

export type ChecklistProgress = Record<string, ChecklistProgressEntry>

const STORAGE_KEY = 'tandem.checklist.v1'

export const STATUS_LABELS: Record<ChecklistStatus, string> = {
  pass: '通过',
  fail: '有问题',
  skip: '跳过',
}

export function loadChecklistProgress(): ChecklistProgress {
  const parsed = readJson<ChecklistProgress | null>(STORAGE_KEY, null)
  if (!parsed) return {}
  const out: ChecklistProgress = {}
  for (const [id, entry] of Object.entries(parsed)) {
    if (entry && (entry.status === 'pass' || entry.status === 'fail' || entry.status === 'skip')) {
      out[id] = { status: entry.status, at: typeof entry.at === 'number' ? entry.at : 0 }
    }
  }
  return out
}

export function saveChecklistProgress(progress: ChecklistProgress): void {
  writeJson(STORAGE_KEY, progress)
}

export function setChecklistPoint(
  progress: ChecklistProgress,
  pointId: string,
  status: ChecklistStatus | null,
): ChecklistProgress {
  const next = { ...progress }
  if (status) next[pointId] = { status, at: Date.now() }
  else delete next[pointId]
  saveChecklistProgress(next)
  return next
}

/** 最新版本 changelog 里的条目对应功能标「新」。 */
const LATEST_ITEMS = new Set(CHANGELOG[0]?.items.map((item) => item.id) ?? [])

export function featureIsNew(feature: ProductFeature): boolean {
  return (feature.changelogIds ?? []).some((id) => LATEST_ITEMS.has(id))
}

export interface ChecklistFeatureGroup {
  feature: ProductFeature
  isNew: boolean
  points: Array<TestPoint & { status?: ChecklistStatus }>
  counts: { total: number; pass: number; fail: number; skip: number; untested: number }
}

export interface ChecklistGroup {
  id: FeatureGroupId
  title: string
  features: ChecklistFeatureGroup[]
  counts: { total: number; pass: number; fail: number; skip: number; untested: number }
}

function emptyCounts() {
  return { total: 0, pass: 0, fail: 0, skip: 0, untested: 0 }
}

const STATUS_ORDER: Record<ChecklistStatus, number> = { fail: 0, skip: 1, pass: 2 }

export function buildChecklist(progress: ChecklistProgress): ChecklistGroup[] {
  return FEATURE_GROUPS.map((group) => {
    const features: ChecklistFeatureGroup[] = PRODUCT_FEATURES.filter(
      (feature) => feature.group === group.id,
    ).map((feature) => {
      const points = TEST_POINTS.filter((point) => point.feature === feature.id).map((point) => ({
        ...point,
        status: progress[point.id]?.status,
      }))
      // 未测的排前面；同状态按数据文件顺序。
      points.sort((a, b) => {
        const rank = (status?: ChecklistStatus) => (status ? STATUS_ORDER[status] : -1)
        return rank(a.status) - rank(b.status)
      })
      const counts = emptyCounts()
      for (const point of points) {
        counts.total += 1
        if (!point.status) counts.untested += 1
        else counts[point.status] += 1
      }
      return { feature, isNew: featureIsNew(feature), points, counts }
    })
    // 有未测项的 feature 排在前面，保持同一分组内的原有顺序。
    features.sort((a, b) => (b.counts.untested > 0 ? 1 : 0) - (a.counts.untested > 0 ? 1 : 0))
    const counts = emptyCounts()
    for (const feature of features) {
      counts.total += feature.counts.total
      counts.pass += feature.counts.pass
      counts.fail += feature.counts.fail
      counts.skip += feature.counts.skip
      counts.untested += feature.counts.untested
    }
    return { id: group.id, title: group.title, features, counts }
  }).filter((group) => group.features.length > 0)
}

export function checklistSummary(progress: ChecklistProgress) {
  const groups = buildChecklist(progress)
  const totals = emptyCounts()
  for (const group of groups) {
    totals.total += group.counts.total
    totals.pass += group.counts.pass
    totals.fail += group.counts.fail
    totals.skip += group.counts.skip
    totals.untested += group.counts.untested
  }
  return { groups, totals }
}

export function checklistMarkdown(progress = loadChecklistProgress()): string {
  const { groups, totals } = checklistSummary(progress)
  const lines: string[] = [
    '# Tandem 体验清单报告',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 进度：通过 ${totals.pass} · 有问题 ${totals.fail} · 跳过 ${totals.skip} · 未测 ${totals.untested} / 共 ${totals.total} 条`,
    '',
  ]
  for (const group of groups) {
    lines.push(`## ${group.title}`, '')
    for (const feature of group.features) {
      if (feature.points.length === 0) continue
      lines.push(`### ${feature.feature.title}${feature.isNew ? '（新）' : ''}`, '')
      for (const point of feature.points) {
        const status = point.status ? STATUS_LABELS[point.status] : '未测'
        lines.push(`- [${status}] ${point.text}${point.demo ? ` · 演示场景：${point.demo}` : ''}`)
      }
      lines.push('')
    }
  }
  lines.push('> 由 Tandem 体验清单生成；未测项排在每组前面，便于增量测试。')
  return `${lines.join('\n')}\n`
}

export function pointById(id: string): TestPoint | undefined {
  return TEST_POINTS.find((point) => point.id === id)
}

export function featureOfPoint(point: TestPoint): ProductFeature | undefined {
  return FEATURE_BY_ID.get(point.feature)
}
