import { create } from 'zustand'
import type { ServerMsg } from '@tandem/protocol'
import { api } from '../lib/api'
import { useUiStore } from './useUiStore'
import { toast } from './appStore/helpers'
import type { AppState } from './appStore/types'
import { createSessionCore } from './appStore/sessionCore'
import { createServerMessageHandler } from './appStore/serverMessages'
import { createHostsSlice } from './appStore/hostsSlice'
import { createSessionsSlice } from './appStore/sessionsSlice'
import { createMessagesSlice } from './appStore/messagesSlice'
import { createInboxSlice } from './appStore/inboxSlice'

export type { HostInboxState } from './appStore/types'
export { depthOf } from './appStore/helpers'

export const useAppStore = create<AppState>((set, get) => {
  let handleServerMessage: (hostId: string, msg: ServerMsg) => void = () => {}
  const core = createSessionCore(set, get, (hostId, msg) => handleServerMessage(hostId, msg))
  handleServerMessage = createServerMessageHandler(set, get, core)

  const { getHost, applySessionSummary } = core

  return {
    initialized: false,
    hosts: [],
    activeHostId: null,
    runtimes: {},
    externalSessions: {},
    inbox: {},
    active: null,
    changesNonce: 0,
    worktreeIntents: {},

    ...createHostsSlice(set, get, core),
    ...createSessionsSlice(set, get, core),
    ...createMessagesSlice(set, get, core),
    ...createInboxSlice(set, get, core),

    bumpChanges: () => set((state) => ({ changesNonce: state.changesNonce + 1 })),
    openFileBrowser: (path) => {
      const cwd = get().active?.summary?.cwd
      if (!cwd) {
        useUiStore.getState().toast('当前会话没有工作目录', 'error')
        return
      }
      const ui = useUiStore.getState()
      ui.setFileBrowserVisible(true)
      ui.openFilePreview({ path: path ?? '', cwd })
    },

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
})
