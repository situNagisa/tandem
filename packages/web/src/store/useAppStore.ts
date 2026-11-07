import { create } from 'zustand'
import type { ServerMsg } from '@tandem/protocol'
import { api } from '../lib/api'
import { cancelPermissionNotification } from '../lib/attention'
import { useUiStore } from './useUiStore'
import { connections, newId, toast } from './appStore/helpers'
import type { AppState } from './appStore/types'
import { createSessionCore } from './appStore/sessionCore'
import { createServerMessageHandler } from './appStore/serverMessages'
import { createHostsSlice } from './appStore/hostsSlice'
import { createSessionsSlice } from './appStore/sessionsSlice'

export type { HostInboxState } from './appStore/types'
export { depthOf } from './appStore/helpers'

export const useAppStore = create<AppState>((set, get) => {
  let handleServerMessage: (hostId: string, msg: ServerMsg) => void = () => {}
  const core = createSessionCore(set, get, (hostId, msg) => handleServerMessage(hostId, msg))
  handleServerMessage = createServerMessageHandler(set, get, core)

  const {
    getHost,
    patchActive,
    patchSubagent,
    applySessionSummary,
    ensureConnection,
  } = core

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

    clearTurnError: () => {
      const active = get().active
      if (!active) return
      patchActive(active.hostId, active.sessionId, (a) => ({ ...a, turnError: undefined }))
    },

    send: (blocks) => {
      const active = get().active
      if (!active) return false
      const conn = ensureConnection(active.hostId)
      const ok = conn?.send({ type: 'send', sessionId: active.sessionId, content: blocks }) ?? false
      if (!ok) {
        toast('Host 未连接，消息未发送', 'error')
        return false
      }
      const wasRunning = active.running
      const local = {
        id: `local-${newId()}`,
        role: 'user' as const,
        content: blocks,
        createdAt: Date.now(),
        local: true,
        queued: wasRunning,
      }
      patchActive(active.hostId, active.sessionId, (a) => ({
        ...a,
        messages: [...a.messages, local],
        running: true,
        stopping: false,
        turnError: undefined,
        summary: a.summary ? { ...a.summary, status: 'running', updatedAt: Date.now() } : null,
      }))
      if (active.summary) {
        applySessionSummary(active.hostId, { ...active.summary, status: 'running', updatedAt: Date.now() })
      }
      return true
    },

    interrupt: () => {
      const active = get().active
      if (!active || !active.running) return
      const conn = connections.get(active.hostId) ?? ensureConnection(active.hostId)
      const ok = conn?.send({ type: 'interrupt', sessionId: active.sessionId }) ?? false
      if (!ok) {
        toast('Host 未连接，无法中断', 'error')
        return
      }
      patchActive(active.hostId, active.sessionId, (a) => ({ ...a, stopping: true }))
    },

    retryNow: () => {
      const active = get().active
      if (!active) return
      const conn = connections.get(active.hostId) ?? ensureConnection(active.hostId)
      const ok = conn?.send({ type: 'retry_now', sessionId: active.sessionId }) ?? false
      if (!ok) toast('Host 未连接，无法重试', 'error')
    },

    resumePaused: async () => {
      const active = get().active
      if (!active) return
      const host = getHost(active.hostId)
      if (!host) return
      try {
        const summary = await api.resumeSession(host, active.sessionId)
        applySessionSummary(active.hostId, summary)
        patchActive(active.hostId, active.sessionId, (a) => ({
          ...a,
          summary: a.summary ? { ...a.summary, resumePaused: undefined, status: summary.status } : summary,
          running: true,
        }))
      } catch (err) {
        toast(err instanceof Error ? err.message : '恢复失败', 'error')
      }
    },

    interruptSubagent: (childId) => {
      const active = get().active
      if (!active) return
      const conn = connections.get(active.hostId) ?? ensureConnection(active.hostId)
      const ok = conn?.send({ type: 'interrupt', sessionId: childId }) ?? false
      if (!ok) {
        toast('Host 未连接，无法停止子代理', 'error')
        return
      }
      patchSubagent(active.hostId, childId, (sub) => ({
        ...sub,
        summary: sub.summary ? { ...sub.summary, status: 'running' } : null,
      }))
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

    decidePermission: (requestId, decision, reason) => {
      const active = get().active
      if (!active) return
      const conn = connections.get(active.hostId) ?? ensureConnection(active.hostId)
      const ok =
        conn?.send({
          type: 'permission',
          requestId,
          decision,
          ...(reason ? { reason } : {}),
        }) ?? false
      if (!ok) {
        toast('Host 未连接，无法提交审批', 'error')
        return
      }
      patchActive(active.hostId, active.sessionId, (a) => {
        const pending = a.pending.filter((p) => p.id !== requestId)
        return {
          ...a,
          pending,
          summary: a.summary
            ? { ...a.summary, status: pending.length ? 'waiting_permission' : 'running' }
            : null,
        }
      })
      const now = get().active
      if (now && now.summary) applySessionSummary(active.hostId, now.summary)
    },

    decideInboxPermission: (hostId, requestId, decision, reason) => {
      const conn = connections.get(hostId) ?? ensureConnection(hostId)
      const ok =
        conn?.send({
          type: 'permission',
          requestId,
          decision,
          ...(reason ? { reason } : {}),
        }) ?? false
      if (!ok) {
        toast('Host 未连接，无法提交审批', 'error')
        return
      }
      cancelPermissionNotification(requestId)
      // 乐观从收件箱移除；桌面端的 permission_resolved 会再广播一次校正
      set((state) => {
        const inbox = state.inbox[hostId]
        if (!inbox) return state
        const pending = inbox.pending.filter((item) => item.requestId !== requestId)
        return {
          inbox: {
            ...state.inbox,
            [hostId]: {
              ...inbox,
              pending,
              unread: Math.max(0, inbox.unread - (pending.length < inbox.pending.length ? 1 : 0)),
            },
          },
        }
      })
      set((state) => {
        const active = state.active
        if (!active || active.hostId !== hostId) return state
        const pending = active.pending.filter((p) => p.id !== requestId)
        if (pending.length === active.pending.length) return state
        return {
          active: {
            ...active,
            pending,
            subagents: Object.fromEntries(
              Object.entries(active.subagents).map(([id, sub]) => [
                id,
                { ...sub, pending: sub.pending.filter((p) => p.id !== requestId) },
              ]),
            ),
          },
        }
      })
    },

    markInboxSeen: () => {
      set((state) => {
        const inbox = { ...state.inbox }
        let changed = false
        for (const [hostId, entry] of Object.entries(inbox)) {
          if (entry.unread > 0) {
            inbox[hostId] = { ...entry, unread: 0 }
            changed = true
          }
        }
        return changed ? { inbox } : state
      })
    },
  }
})
