import { create } from 'zustand'
import type { BrowserState } from '@tandem/protocol'

interface BrowserStore {
  /** key = sessionId：最近一次 browser_state。 */
  states: Record<string, BrowserState>
  apply: (state: BrowserState) => void
  forget: (sessionId: string) => void
}

export const useBrowserStore = create<BrowserStore>((set) => ({
  states: {},
  apply: (state) =>
    set((prev) => {
      const existing = prev.states[state.sessionId]
      // 旧快照可能晚到：按 updatedAt 丢弃更旧的状态
      if (existing && existing.updatedAt > state.updatedAt) return prev
      return { states: { ...prev.states, [state.sessionId]: state } }
    }),
  forget: (sessionId) =>
    set((prev) => {
      if (!prev.states[sessionId]) return prev
      const next = { ...prev.states }
      delete next[sessionId]
      return { states: next }
    }),
}))
