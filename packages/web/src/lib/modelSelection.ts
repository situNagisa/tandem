/**
 * 拉取模型后的默认勾选规则（反馈10#04）。
 *
 * 服务商返回的模型里，同一系列往往同时给出多代（claude-opus-4-6 / claude-opus-4-5-20251101）
 * 与同版本别名/日期快照（claude-sonnet-5-5 / claude-sonnet-5-5-20250929）。默认只勾选
 * 每个系列最新的一代；同版本有别名时取别名（不带日期快照）；判断不出系列或版本的不勾选。
 *
 * 已手动勾选/取消过的用户，再次拉取只对新出现的模型应用规则，保留原来的选择。
 */

export interface ModelIdentity {
  /** 系列键：去掉版本数字与日期后的字母部分，如 `claude-opus`、`gpt-o`。 */
  series: string
  /** 版本号依次比较，如 `4-6` → [4, 6]。 */
  version: number[]
  /** 日期快照（YYYYMMDD）；别名模型没有。 */
  snapshot?: number
}

const DATE_DASH = /(?:^|[-_./])(\d{4}-\d{2}-\d{2})$/
const DATE_COMPACT = /(?:^|[-_./])(\d{8})$/

/** 解析模型 ID；没有版本号（如 deepseek-chat）时返回 null，表示无法判断。 */
export function identifyModel(id: string): ModelIdentity | null {
  const lower = id.trim().toLowerCase()
  if (!lower) return null
  let rest = lower
  let snapshot: number | undefined
  const dashed = rest.match(DATE_DASH)
  if (dashed) {
    snapshot = Number(dashed[1].replace(/-/g, ''))
    rest = rest.slice(0, dashed.index)
  } else {
    const compact = rest.match(DATE_COMPACT)
    if (compact) {
      snapshot = Number(compact[1])
      rest = rest.slice(0, compact.index)
    }
  }
  const parts = rest.split(/[^a-z0-9]+/).filter(Boolean)
  const series: string[] = []
  const version: number[] = []
  for (const part of parts) {
    const mixed = part.match(/^([a-z]*)(\d+)([a-z]*)$/)
    if (mixed) {
      if (mixed[1]) series.push(mixed[1])
      version.push(Number(mixed[2]))
      if (mixed[3]) series.push(mixed[3])
    } else if (/^\d+$/.test(part)) {
      version.push(Number(part))
    } else {
      series.push(part)
    }
  }
  if (version.length === 0 || series.length === 0) return null
  return {
    series: series.join('-'),
    version,
    ...(snapshot !== undefined ? { snapshot } : {}),
  }
}

/** a 是否比 b 新：版本号逐位比较；同版本优先别名，其次日期更新的快照。 */
export function isNewerModel(a: ModelIdentity, b: ModelIdentity): boolean {
  const length = Math.max(a.version.length, b.version.length)
  for (let i = 0; i < length; i += 1) {
    const av = a.version[i]
    const bv = b.version[i]
    if (av === undefined) return false
    if (bv === undefined) return true
    if (av !== bv) return av > bv
  }
  if (a.snapshot === undefined && b.snapshot !== undefined) return true
  if (a.snapshot !== undefined && b.snapshot === undefined) return false
  if (a.snapshot !== undefined && b.snapshot !== undefined) return a.snapshot > b.snapshot
  return false
}

/** 每个系列选最新一代；无法判断的模型不选。保持传入顺序。 */
export function selectLatestModels(ids: readonly string[]): string[] {
  const best = new Map<string, { id: string; identity: ModelIdentity }>()
  for (const id of ids) {
    const identity = identifyModel(id)
    if (!identity) continue
    const current = best.get(identity.series)
    if (!current || isNewerModel(identity, current.identity)) {
      best.set(identity.series, { id, identity })
    }
  }
  const picked = new Set([...best.values()].map((entry) => entry.id))
  return ids.filter((id) => picked.has(id))
}

/**
 * 再次拉取模型时的合并：
 * - `touched` 为 false（用户没手动改过勾选）：按最新一代规则整体重选。
 * - `touched` 为 true：保留已选（仍存在的），只对本次新出现的模型应用规则。
 */
export function mergeFetchedSelection(input: {
  selected: readonly string[]
  previousAvailable: readonly string[]
  fetched: readonly string[]
  touched: boolean
}): string[] {
  const fetchedSet = new Set(input.fetched)
  if (!input.touched) return selectLatestModels(input.fetched)
  const kept = new Set(input.selected.filter((id) => fetchedSet.has(id)))
  const previous = new Set(input.previousAvailable)
  const fresh = input.fetched.filter((id) => !previous.has(id))
  for (const id of selectLatestModels(fresh)) kept.add(id)
  return input.fetched.filter((id) => kept.has(id))
}
