import { create } from 'zustand'
import type { PreviewSelection, PreviewState } from '@tandem/protocol'
import { readJson, writeJson } from '../lib/storage'

export interface PreviewPrefs {
  /** 上次打开的地址。 */
  address?: string
  device?: 'desktop' | 'tablet' | 'phone' | 'custom'
  width?: number
  height?: number
}

interface PreviewStore {
  /** key = sessionId：最近一次 preview_state。 */
  states: Record<string, PreviewState>
  /** key = sessionId：面板里点选后待附加给 agent 的元素。 */
  selections: Record<string, PreviewSelection[]>
  /** key = sessionId：关闭后重新打开时恢复的地址与设备尺寸。 */
  prefs: Record<string, PreviewPrefs>
  apply: (state: PreviewState) => void
  addSelection: (sessionId: string, selection: PreviewSelection) => void
  removeSelection: (sessionId: string, selectionId: string) => void
  clearSelections: (sessionId: string) => void
  setPrefs: (sessionId: string, patch: PreviewPrefs) => void
  forget: (sessionId: string) => void
}

const MAX_SELECTIONS = 8
const PREFS_KEY = 'tandem.preview.prefs.v1'

function loadPrefs(): Record<string, PreviewPrefs> {
  const parsed = readJson<unknown>(PREFS_KEY, {})
  if (!parsed || typeof parsed !== 'object') return {}
  return parsed as Record<string, PreviewPrefs>
}

function savePrefs(prefs: Record<string, PreviewPrefs>): void {
  writeJson(PREFS_KEY, prefs)
}

export const usePreviewStore = create<PreviewStore>((set) => ({
  states: {},
  selections: {},
  prefs: loadPrefs(),
  apply: (state) =>
    set((prev) => {
      const existing = prev.states[state.sessionId]
      // 旧快照可能晚到：按 updatedAt 丢弃更旧的状态
      if (existing && existing.updatedAt > state.updatedAt) return prev
      return { states: { ...prev.states, [state.sessionId]: state } }
    }),
  addSelection: (sessionId, selection) =>
    set((prev) => {
      const list = prev.selections[sessionId] ?? []
      // 同一元素连续点两次只保留最新一次
      const next = [...list.filter((item) => item.selector !== selection.selector), selection].slice(
        -MAX_SELECTIONS,
      )
      return { selections: { ...prev.selections, [sessionId]: next } }
    }),
  removeSelection: (sessionId, selectionId) =>
    set((prev) => {
      const list = prev.selections[sessionId]
      if (!list) return prev
      const next = list.filter((item) => item.id !== selectionId)
      return { selections: { ...prev.selections, [sessionId]: next } }
    }),
  clearSelections: (sessionId) =>
    set((prev) => {
      if (!prev.selections[sessionId]) return prev
      const next = { ...prev.selections }
      delete next[sessionId]
      return { selections: next }
    }),
  setPrefs: (sessionId, patch) =>
    set((prev) => {
      const next = { ...prev.prefs, [sessionId]: { ...prev.prefs[sessionId], ...patch } }
      savePrefs(next)
      return { prefs: next }
    }),
  forget: (sessionId) =>
    set((prev) => {
      if (!prev.states[sessionId]) return prev
      const next = { ...prev.states }
      delete next[sessionId]
      return { states: next }
    }),
}))
