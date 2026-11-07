import type { SessionSummary } from '@tandem/protocol'
import type { StoreApi } from 'zustand'
import { api } from '../../lib/api'
import { navigate } from '../../lib/router'
import type { SessionTarget } from '../../lib/types'
import { useUiStore } from '../useUiStore'
import {
  connections,
  emptyActiveSession,
  isRunningStatus,
  matchesView,
  toast,
  viewKeyOf,
} from './helpers'
import type { SessionCore } from './sessionCore'
import type { AppState } from './types'

export type SessionsSlice = Pick<
  AppState,
  | 'openSession'
  | 'openSessionView'
  | 'closeSessionView'
  | 'focusSessionView'
  | 'closeSession'
  | 'reloadActiveSession'
  | 'setPermissionMode'
  | 'rewind'
  | 'setModel'
  | 'createSession'
  | 'startSession'
  | 'dispatchSession'
  | 'updateSession'
  | 'markSessionRead'
  | 'forkSession'
  | 'handoffSession'
  | 'deleteSession'
>

export function createSessionsSlice(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  core: SessionCore,
): SessionsSlice {
  const {
    getHost,
    patchView,
    clearChildSubscriptions,
    applySessionSummary,
    applySnapshot,
    removeSummary,
    removeSessionView,
    ensureConnection,
  } = core

  const viewOf = (target?: SessionTarget | null) => {
    if (target) return get().sessionViews[viewKeyOf(target.hostId, target.sessionId)] ?? null
    return get().active
  }

  const openSessionView = (hostId: string, sessionId: string): void => {
    const key = viewKeyOf(hostId, sessionId)
    if (get().sessionViews[key]) return
    const host = getHost(hostId)
    if (!host) return
    const rt = get().runtimes[hostId]
    const summary = rt?.sessions.find((s) => s.id === sessionId) ?? null
    set((state) => ({
      sessionViews: {
        ...state.sessionViews,
        [key]: emptyActiveSession(hostId, sessionId, summary),
      },
    }))
    if (!rt?.sessionsLoaded) void get().refreshSessions(hostId)
    // 详情面板要在打开会话后立刻显示账号名：账号列表未就绪时补拉一次
    if (!rt?.profilesLoaded && !rt?.profilesLoading) void get().refreshProfiles(hostId)

    const conn = ensureConnection(hostId)
    conn?.subscribe(sessionId)
    // 系统提示注入段落：会话开头展开查看（与 WS 推送互为备份）
    void api
      .injections(host, sessionId)
      .then((injections) => {
        patchView(hostId, sessionId, (view) => ({ ...view, injections }))
      })
      .catch(() => {})
    if (!conn || conn.status !== 'online') void core.loadSessionFallback(hostId, sessionId)
    else {
      // 正常情况下 snapshot 会立刻到达；若 3 秒仍空白再兜底一次。
      window.setTimeout(() => {
        const view = get().sessionViews[key]
        if (view && view.loading && view.messages.length === 0) {
          void core.loadSessionFallback(hostId, sessionId)
        }
      }, 3000)
    }
  }

  const focusView = (hostId: string, sessionId: string): void => {
    openSessionView(hostId, sessionId)
    const view = get().sessionViews[viewKeyOf(hostId, sessionId)]
    if (!view) return
    set({ active: view })
    get().activateHost(hostId)
    core.syncChildren(hostId, sessionId)
    if (view.summary?.unread) void get().markSessionRead(hostId, sessionId)
  }

  return {
    openSession: (hostId, sessionId) => {
      get().activateHost(hostId)
      const host = getHost(hostId)
      if (!host) return
      const current = get().active
      if (current && !matchesView(current, hostId, sessionId)) {
        const panes = useUiStore.getState().splitPanes
        const keep = panes.some(
          (pane) => pane.hostId === current.hostId && pane.sessionId === current.sessionId,
        )
        if (!keep) get().closeSessionView(current.hostId, current.sessionId)
      }
      focusView(hostId, sessionId)
    },

    openSessionView,

    closeSessionView: (hostId, sessionId) => {
      const view = get().sessionViews[viewKeyOf(hostId, sessionId)]
      if (!view) return
      const wasActive = matchesView(get().active, hostId, sessionId)
      connections.get(hostId)?.unsubscribe(sessionId)
      removeSessionView(hostId, sessionId)
      if (wasActive) {
        const remaining = Object.values(get().sessionViews)
        set({ active: remaining[0] ?? null })
      }
      if (!Object.values(get().sessionViews).some((item) => item.hostId === hostId)) {
        clearChildSubscriptions(hostId)
      }
    },

    focusSessionView: focusView,

    closeSession: () => {
      const views = Object.values(get().sessionViews)
      for (const view of views) connections.get(view.hostId)?.unsubscribe(view.sessionId)
      for (const hostId of new Set(views.map((view) => view.hostId))) {
        clearChildSubscriptions(hostId)
      }
      set({ active: null, sessionViews: {} })
    },

    reloadActiveSession: (target) => {
      const view = viewOf(target)
      if (!view) return
      const { hostId, sessionId } = view
      const conn = ensureConnection(hostId)
      patchView(hostId, sessionId, (a) => ({ ...a, loading: true, error: undefined }))
      if (conn?.status === 'online') {
        conn.unsubscribe(sessionId)
        conn.subscribe(sessionId)
      } else {
        void core.loadSessionFallback(hostId, sessionId)
      }
    },

    setPermissionMode: async (mode, target) => {
      const view = viewOf(target)
      const host = view ? getHost(view.hostId) : undefined
      if (!view?.summary || !host) return
      const prev = view.summary
      if (prev.permissionMode === mode) return
      const optimistic = { ...prev, permissionMode: mode }
      patchView(view.hostId, view.sessionId, (a) => ({ ...a, summary: optimistic }))
      applySessionSummary(view.hostId, optimistic)
      try {
        const updated = await api.patchSession(host, prev.id, { permissionMode: mode })
        applySessionSummary(view.hostId, updated)
      } catch (err) {
        applySessionSummary(view.hostId, prev)
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

    setModel: async (profileId, groupId, model, target) => {
      const view = viewOf(target)
      const host = view ? getHost(view.hostId) : undefined
      if (!view?.summary || !host) return
      const prev = view.summary
      const optimistic: SessionSummary = {
        ...prev,
        profileId,
        model: model === 'auto' ? prev.model : model,
        ...(model === 'auto' ? { autoRoute: true } : { autoRoute: undefined }),
        groupId,
      }
      patchView(view.hostId, view.sessionId, (a) => ({ ...a, summary: optimistic }))
      applySessionSummary(view.hostId, optimistic)
      try {
        const updated = await api.patchSession(host, prev.id, {
          profileId,
          model,
          ...(groupId ? { groupId } : {}),
        })
        applySessionSummary(view.hostId, updated)
      } catch (err) {
        applySessionSummary(view.hostId, prev)
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
      const key = viewKeyOf(hostId, summary.id)
      set((state) => ({
        sessionViews: {
          ...state.sessionViews,
          [key]: emptyActiveSession(hostId, summary.id, summary),
        },
      }))
      const view = get().sessionViews[key]!
      set({ active: view })
      navigate({ kind: 'session', hostId, sessionId: summary.id })
      ensureConnection(hostId)?.subscribe(summary.id)
      get().send(content, { hostId, sessionId: summary.id })
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
      const viewSummary = get().sessionViews[viewKeyOf(hostId, sessionId)]?.summary ?? null
      const prev = rt?.sessions.find((s) => s.id === sessionId) ?? viewSummary
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

    markSessionRead: async (hostId, sessionId) => {
      const host = getHost(hostId)
      if (!host) return
      const rt = get().runtimes[hostId]
      const viewSummary = get().sessionViews[viewKeyOf(hostId, sessionId)]?.summary ?? null
      const current = rt?.sessions.find((s) => s.id === sessionId) ?? viewSummary
      if (current?.unread) {
        const { unread: _unread, ...rest } = current
        applySessionSummary(hostId, rest)
      }
      try {
        const updated = await api.markSessionRead(host, sessionId)
        applySessionSummary(hostId, updated)
      } catch {
        // 多端已读是尽力而为：离线时保留本地显示，下次打开再同步
      }
    },

    handoffSession: async (hostId, sessionId, action) => {
      const host = getHost(hostId)
      if (!host) return
      try {
        const summary = await api.handoffSession(host, sessionId, action)
        applySessionSummary(hostId, summary)
      } catch (err) {
        toast(err instanceof Error ? err.message : '交接失败', 'error')
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
      const wasActive = matchesView(get().active, hostId, sessionId)
      await api.deleteSession(host, sessionId, force)
      removeSummary(hostId, sessionId)
      if (get().sessionViews[viewKeyOf(hostId, sessionId)]) {
        get().closeSessionView(hostId, sessionId)
      }
      if (wasActive) navigate({ kind: 'host', hostId })
      toast('会话已删除', 'success')
    },
  }
}
