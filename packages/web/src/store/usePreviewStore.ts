import { create } from 'zustand'
import type { PreviewSelection, PreviewState } from '@tandem/protocol'

interface PreviewStore {
  /** key = sessionId：最近一次 preview_state。 */
  states: Record<string, PreviewState>
  /** key = sessionId：面板里点选后待附加给 agent 的元素。 */
  selections: Record<string, PreviewSelection[]>
  apply: (state: PreviewState) => void
  addSelection: (sessionId: string, selection: PreviewSelection) => void
  removeSelection: (sessionId: string, selectionId: string) => void
  clearSelections: (sessionId: string) => void
  forget: (sessionId: string) => void
}

const MAX_SELECTIONS = 8

export const usePreviewStore = create<PreviewStore>((set) => ({
  states: {},
  selections: {},
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
  forget: (sessionId) =>
    set((prev) => {
      if (!prev.states[sessionId]) return prev
      const next = { ...prev.states }
      delete next[sessionId]
      return { states: next }
    }),
}))
