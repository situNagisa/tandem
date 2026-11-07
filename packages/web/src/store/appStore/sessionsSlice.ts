import type { SessionSummary } from '@tandem/protocol'
import type { StoreApi } from 'zustand'
import { api } from '../../lib/api'
import { navigate } from '../../lib/router'
import { useUiStore } from '../useUiStore'
import { connections, isRunningStatus, toast } from './helpers'
import type { SessionCore } from './sessionCore'
import type { AppState } from './types'

export type SessionsSlice = Pick<
  AppState,
  | 'openSession'
  | 'closeSession'
  | 'reloadActiveSession'
  | 'setPermissionMode'
  | 'rewind'
  | 'setModel'
  | 'createSession'
  | 'startSession'
  | 'dispatchSession'
  | 'updateSession'
  | 'forkSession'
  | 'deleteSession'
>

export function createSessionsSlice(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  core: SessionCore,
): SessionsSlice {
  const {
    getHost,
    patchActive,
    clearChildSubscriptions,
    applySessionSummary,
    applySnapshot,
    removeSummary,
    ensureConnection,
  } = core

  return {
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
          viewers: [],
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
          viewers: [],
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
}
