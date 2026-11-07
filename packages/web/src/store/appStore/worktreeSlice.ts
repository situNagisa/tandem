import type { StoreApi } from 'zustand'
import { api } from '../../lib/api'
import { toast } from './helpers'
import type { SessionCore } from './sessionCore'
import type { AppState } from './types'

export type WorktreeSlice = Pick<
  AppState,
  'mergeWorktree' | 'setWorktreeIntent' | 'ensureWorktree'
>

export function createWorktreeSlice(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  core: SessionCore,
): WorktreeSlice {
  const { getHost, applySessionSummary } = core

  return {
    mergeWorktree: async (hostId, sessionId, strategy) => {
      const host = getHost(hostId)
      if (!host) return false
      try {
        const result = await api.mergeWorktree(host, sessionId, strategy)
        if (!result.ok) throw new Error(result.error || '合并失败')
        toast('已合并回基准分支', 'success')
        return true
      } catch (err) {
        toast(err instanceof Error ? err.message : '合并失败', 'error')
        return false
      }
    },

    setWorktreeIntent: (hostId, sessionId, on) => {
      const key = `${hostId}:${sessionId}`
      set((state) => {
        const worktreeIntents = { ...state.worktreeIntents }
        if (on) worktreeIntents[key] = true
        else delete worktreeIntents[key]
        return { worktreeIntents }
      })
    },

    ensureWorktree: async (hostId, sessionId) => {
      const key = `${hostId}:${sessionId}`
      if (!get().worktreeIntents[key]) return true
      const host = getHost(hostId)
      if (!host) return false
      const rt = get().runtimes[hostId]
      const summary =
        (get().active?.hostId === hostId && get().active?.sessionId === sessionId
          ? get().active?.summary
          : null) ?? rt?.sessions.find((s) => s.id === sessionId)
      const clearIntent = () => get().setWorktreeIntent(hostId, sessionId, false)
      if (summary?.worktree) {
        clearIntent()
        return true
      }
      try {
        const updated = await api.worktree(host, sessionId)
        applySessionSummary(hostId, updated)
        clearIntent()
        if (updated.worktree) toast(`已创建隔离分支 ${updated.worktree.branch}`, 'success')
        return true
      } catch (err) {
        toast(err instanceof Error ? err.message : '创建 worktree 失败', 'error')
        return false
      }
    },
  }
}
