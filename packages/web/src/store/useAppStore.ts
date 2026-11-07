import { create } from 'zustand'
import type { ServerMsg, SessionSummary } from '@tandem/protocol'
import { api } from '../lib/api'
import { navigate } from '../lib/router'
import { cancelPermissionNotification } from '../lib/attention'
import { useUiStore } from './useUiStore'
import type { ActiveSession } from '../lib/types'
import { connections, isRunningStatus, newId, toast } from './appStore/helpers'
import type { AppState } from './appStore/types'
import { createSessionCore } from './appStore/sessionCore'
import { createServerMessageHandler } from './appStore/serverMessages'
import { createHostsSlice } from './appStore/hostsSlice'

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
    clearChildSubscriptions,
    applySessionSummary,
    applySnapshot,
    removeSummary,
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

    openSession: (hostId, sessionId) => {
      const current = get().active
      if (current && current.hostId === hostId && current.sessionId === sessionId) return
      if (current) {
        connections.get(current.hostId)?.unsubscribe(current.sessionId)
        clearChildSubscriptions(current.hostId)
      }

      get().activateHost(hostId)
      const host = getHost(hostId)
      if (!host) return
      const rt = get().runtimes[hostId]
      const summary = rt?.sessions.find((s) => s.id === sessionId) ?? null
      set({
        active: {
          hostId,
          sessionId,
          summary,
          messages: [],
          pending: [],
          todos: [],
          loading: true,
          running: summary ? isRunningStatus(summary.status) : false,
          stopping: false,
          liveToolInputs: {},
          toolResults: {},
          hookEvents: [],
          subagents: {},
        },
      })
      if (!rt?.sessionsLoaded) void get().refreshSessions(hostId)
      // 详情面板要在打开会话后立刻显示账号名：账号列表未就绪时补拉一次
      if (!rt?.profilesLoaded && !rt?.profilesLoading) void get().refreshProfiles(hostId)

      const conn = ensureConnection(hostId)
      conn?.subscribe(sessionId)
      core.syncChildren(hostId, sessionId)
      // 系统提示注入段落：会话开头展开查看（与 WS 推送互为备份）
      void api
        .injections(host, sessionId)
        .then((injections) => {
          const now = get().active
          if (!now || now.hostId !== hostId || now.sessionId !== sessionId) return
          set({ active: { ...now, injections } })
        })
        .catch(() => {})
      // WebSocket 尚未连上时，先用 REST 拉一份只读快照，避免空白等待。
      if (!conn || conn.status !== 'online') void core.loadSessionFallback(hostId, sessionId)
      else {
        // 正常情况下 snapshot 会立刻到达；若 3 秒仍空白再兜底一次。
        window.setTimeout(() => {
          const a = get().active
          if (a && a.hostId === hostId && a.sessionId === sessionId && a.loading && a.messages.length === 0) {
            void core.loadSessionFallback(hostId, sessionId)
          }
        }, 3000)
      }
    },

    closeSession: () => {
      const active = get().active
      if (active) {
        connections.get(active.hostId)?.unsubscribe(active.sessionId)
        clearChildSubscriptions(active.hostId)
      }
      set({ active: null })
    },

    reloadActiveSession: () => {
      const active = get().active
      if (!active) return
      const conn = ensureConnection(active.hostId)
      patchActive(active.hostId, active.sessionId, (a) => ({ ...a, loading: true, error: undefined }))
      if (conn?.status === 'online') {
        conn.unsubscribe(active.sessionId)
        conn.subscribe(active.sessionId)
      } else {
        void core.loadSessionFallback(active.hostId, active.sessionId)
      }
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

    setPermissionMode: async (mode) => {
      const active = get().active
      const host = active ? getHost(active.hostId) : undefined
      if (!active?.summary || !host) return
      const prev = active.summary
      if (prev.permissionMode === mode) return
      const optimistic = { ...prev, permissionMode: mode }
      patchActive(active.hostId, active.sessionId, (a) => ({ ...a, summary: optimistic }))
      applySessionSummary(active.hostId, optimistic)
      try {
        const updated = await api.patchSession(host, prev.id, { permissionMode: mode })
        applySessionSummary(active.hostId, updated)
      } catch (err) {
        applySessionSummary(active.hostId, prev)
        toast(err instanceof Error ? err.message : '切换权限模式失败', 'error')
      }
    },

    rewind: async (input, seedText) => {
      const active = get().active
      const host = active ? getHost(active.hostId) : undefined
      if (!active || !host) return false
      if (active.running) {
        toast('会话正在运行，无法回退', 'error')
        return false
      }
      try {
        const session = await api.rewind(host, active.sessionId, input)
        applySnapshot(active.hostId, session, [])
        get().bumpChanges()
        if (input.restoreConversation && seedText !== undefined) {
          useUiStore.getState().seedPrompt(seedText)
        }
        toast(
          input.restoreFiles && input.restoreConversation
            ? '已恢复代码和对话'
            : input.restoreFiles
              ? '已恢复代码'
              : '已恢复对话',
          'success',
        )
        return true
      } catch (err) {
        toast(err instanceof Error ? err.message : '回退失败', 'error')
        return false
      }
    },

    setModel: async (profileId, groupId, model) => {
      const active = get().active
      const host = active ? getHost(active.hostId) : undefined
      if (!active?.summary || !host) return
      const prev = active.summary
      const optimistic: SessionSummary = { ...prev, profileId, model, groupId }
      patchActive(active.hostId, active.sessionId, (a) => ({ ...a, summary: optimistic }))
      applySessionSummary(active.hostId, optimistic)
      try {
        const updated = await api.patchSession(host, prev.id, {
          profileId,
          model,
          ...(groupId ? { groupId } : {}),
        })
        applySessionSummary(active.hostId, updated)
      } catch (err) {
        applySessionSummary(active.hostId, prev)
        toast(err instanceof Error ? err.message : '切换模型失败', 'error')
      }
    },

    createSession: async (hostId, input) => {
      const host = getHost(hostId)
      if (!host) throw new Error('Host 不存在')
      const summary = await api.createSession(host, input)
      const rt = get().runtimes[hostId]
      if (rt) applySessionSummary(hostId, summary)
      navigate({ kind: 'session', hostId, sessionId: summary.id })
      return summary
    },

    startSession: async (hostId, input, content) => {
      const host = getHost(hostId)
      if (!host) throw new Error('Host 不存在')
      const summary = await api.createSession(host, input)
      applySessionSummary(hostId, summary)
      set({
        active: {
          hostId,
          sessionId: summary.id,
          summary,
          messages: [],
          pending: [],
          todos: [],
          loading: true,
          running: false,
          stopping: false,
          liveToolInputs: {},
          toolResults: {},
          hookEvents: [],
          subagents: {},
        },
      })
      navigate({ kind: 'session', hostId, sessionId: summary.id })
      ensureConnection(hostId)?.subscribe(summary.id)
      get().send(content)
      return summary
    },

    dispatchSession: async (hostId, input, content) => {
      const host = getHost(hostId)
      if (!host) throw new Error('Host 不存在')
      if (get().runtimes[hostId]?.status !== 'online') throw new Error('Host 离线，无法派单')
      const summary = await api.createSession(host, input)
      applySessionSummary(hostId, summary)
      const conn = ensureConnection(hostId)
      const sent = conn?.send({ type: 'send', sessionId: summary.id, content }) ?? false
      return { summary, sent }
    },

    updateSession: async (hostId, sessionId, patch) => {
      const host = getHost(hostId)
      if (!host) return null
      const rt = get().runtimes[hostId]
      const active = get().active
      const prev =
        rt?.sessions.find((s) => s.id === sessionId) ??
        (active?.hostId === hostId && active.sessionId === sessionId ? active.summary : null)
      if (!prev) return null
      const optimistic: SessionSummary = { ...prev, ...patch }
      applySessionSummary(hostId, optimistic)
      try {
        const updated = await api.patchSession(host, sessionId, patch)
        applySessionSummary(hostId, updated)
        return updated
      } catch (err) {
        applySessionSummary(hostId, prev)
        toast(err instanceof Error ? err.message : '更新会话失败', 'error')
        return null
      }
    },

    forkSession: async (hostId, sessionId, messageId) => {
      const host = getHost(hostId)
      if (!host) return null
      try {
        const summary = await api.forkSession(host, sessionId, messageId)
        applySessionSummary(hostId, summary)
        toast(messageId ? '已从该消息分叉' : '已复制会话', 'success')
        navigate({ kind: 'session', hostId, sessionId: summary.id })
        return summary
      } catch (err) {
        toast(err instanceof Error ? err.message : '复制会话失败', 'error')
        return null
      }
    },

    deleteSession: async (hostId, sessionId, force = false) => {
      const host = getHost(hostId)
      if (!host) return
      await api.deleteSession(host, sessionId, force)
      removeSummary(hostId, sessionId)
      const active = get().active
      if (active && active.hostId === hostId && active.sessionId === sessionId) {
        connections.get(hostId)?.unsubscribe(sessionId)
        clearChildSubscriptions(hostId)
        set({ active: null })
        navigate({ kind: 'host', hostId })
      }
      toast('会话已删除', 'success')
    },
  }
})
