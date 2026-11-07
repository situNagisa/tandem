import type { SplitLayout, SplitPane, SplitState } from './types'

export const MAX_SPLIT_PANES = 4

export function paneKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`
}

export function samePane(a: SplitPane, b: SplitPane): boolean {
  return a.hostId === b.hostId && a.sessionId === b.sessionId
}

export function splitCapacity(layout: SplitLayout): number {
  return layout === 'cols2' || layout === 'rows2' ? 2 : layout === 'cols3' ? 3 : 4
}

export function equalWeights(count: number): number[] {
  return Array.from({ length: Math.max(1, count) }, () => 1 / Math.max(1, count))
}

export function defaultLayoutForCount(count: number): SplitLayout {
  if (count >= 4) return 'grid2x2'
  if (count === 3) return 'cols3'
  return 'cols2'
}

/** 列数：grid2x2 有两列；cols2/cols3 分别 2/3 列；rows2 只有一列。 */
export function columnCount(layout: SplitLayout): number {
  if (layout === 'rows2') return 1
  return layout === 'cols3' ? 3 : 2
}

export function rowCount(layout: SplitLayout): number {
  return layout === 'rows2' || layout === 'grid2x2' ? 2 : 1
}

export function sanitizeWeights(input: unknown, length: number): number[] | null {
  if (!Array.isArray(input) || input.length !== length) return null
  const values = input.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0))
  if (values.some((n) => n <= 0)) return null
  const total = values.reduce((sum, n) => sum + n, 0)
  if (total <= 0) return null
  return values.map((n) => n / total)
}

export function sanitizeSplitState(input: unknown): SplitState | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Partial<SplitState>
  if (!Array.isArray(raw.panes)) return null
  const seen = new Set<string>()
  const panes: SplitPane[] = []
  for (const item of raw.panes) {
    if (!item || typeof item !== 'object') continue
    const hostId = (item as SplitPane).hostId
    const sessionId = (item as SplitPane).sessionId
    if (typeof hostId !== 'string' || typeof sessionId !== 'string') continue
    const key = paneKey(hostId, sessionId)
    if (seen.has(key)) continue
    seen.add(key)
    panes.push({ hostId, sessionId })
    if (panes.length >= MAX_SPLIT_PANES) break
  }
  if (panes.length < 2) return null
  const layout: SplitLayout =
    raw.layout === 'cols2' || raw.layout === 'cols3' || raw.layout === 'grid2x2' || raw.layout === 'rows2'
      ? raw.layout
      : defaultLayoutForCount(panes.length)
  const cols = sanitizeWeights(raw.cols, columnCount(layout)) ?? equalWeights(columnCount(layout))
  const rows = sanitizeWeights(raw.rows, rowCount(layout)) ?? equalWeights(rowCount(layout))
  return { panes, layout, cols, rows }
}
