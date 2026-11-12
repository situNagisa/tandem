import type { SessionSummary } from '@tandem/protocol'
import type { StoreApi } from 'zustand'
import { api } from '../../lib/api'
import { SESSION_TAIL_MESSAGES } from '../../lib/messagePaging'
import { navigate } from '../../lib/router'
import type { ActiveSession, SessionTarget, UiMessage } from '../../lib/types'
import { useUiStore } from '../useUiStore'
import { DRAFT_SESSION_PREFIX } from '../../lib/draftSession'
import {
  childSubscriptions,
  connections,
  emptyActiveSession,
  isRunningStatus,
  matchesView,
  newId,
  toast,
  viewKeyOf,
} from './helpers'
import type { SessionCore } from './sessionCore'
import type { AppState } from './types'

export type SessionsSlice = Pick<
  AppState,
  | 'openSession'
  | 'openSessionView'
  | 'ensureSubagent'
  | 'commitPendingFocus'
  | 'closeSessionView'
  | 'focusSessionView'
  | 'closeSession'
  | 'reloadActiveSession'
  | 'setPermissionMode'
  | 'rewind'
  | 'undoCompaction'
  | 'setModel'
  | 'createSession'
  | 'startSession'
  | 'updateSession'
  | 'markSessionRead'
  | 'forkSession'
  | 'handoffSession'
  | 'deleteSession'
>

/** 目标首屏迟迟不就绪时的兜底切换时间，避免点了没反应。 */
const PENDING_FOCUS_MS = 1500

const isViewReady = (view: ActiveSession): boolean =>
  !view.loading || view.messages.length > 0 || !!view.error

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
    subscribeChild,
    syncChildren,
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
    conn?.subscribe(sessionId, { tail: SESSION_TAIL_MESSAGES })
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

  /** 从分叉/其他会话直接进入子代理时，把它挂到树根会话的视图上并订阅快照。 */
  const ensureSubagent = (hostId: string, childId: string): void => {
    const shown = Object.values(get().sessionViews).some(
      (view) => view.hostId === hostId && !!view.subagents[childId],
    )
    if (shown) {
      subscribeChild(hostId, childId)
      return
    }
    const sessions = get().runtimes[hostId]?.sessions ?? []
    const byId = new Map(sessions.map((item) => [item.id, item]))
    let root = byId.get(childId)
    if (!root) return
    const seen = new Set<string>([root.id])
    while (root.parentId && !seen.has(root.parentId)) {
      const parent = byId.get(root.parentId)
      if (!parent) break
      seen.add(parent.id)
      root = parent
    }
    openSessionView(hostId, root.id)
    syncChildren(hostId, root.id)
    subscribeChild(hostId, childId)
  }

  const focusView = (hostId: string, sessionId: string): void => {
    openSessionView(hostId, sessionId)
    const view = get().sessionViews[viewKeyOf(hostId, sessionId)]
    if (!view) return
    set({ active: view })
    get().activateHost(hostId)
    core.syncChildren(hostId, sessionId)
    // 快照摘要与列表摘要可能短暂不同步：任一处仍有未读就写回已读（反馈2156#02）。
    const listed = get().runtimes[hostId]?.sessions.find((item) => item.id === sessionId)
    if (view.summary?.unread || listed?.unread) void get().markSessionRead(hostId, sessionId)
  }

  /** 关闭不再显示、也不在分屏中的会话视图。 */
  const dropView = (hostId: string, sessionId: string): void => {
    const panes = useUiStore.getState().splitPanes
    if (panes.some((pane) => pane.hostId === hostId && pane.sessionId === sessionId)) return
    get().closeSessionView(hostId, sessionId)
  }

  const commitFocus = (hostId: string, sessionId: string): void => {
    const current = get().active
    if (current && !matchesView(current, hostId, sessionId)) dropView(current.hostId, current.sessionId)
    focusView(hostId, sessionId)
  }

  // 切换会话时先保留当前画面，目标首屏就绪后再切走，避免「旧画面 → 骨架屏 → 新画面」的闪动。
  let pendingFocus: { hostId: string; sessionId: string } | null = null

  return {
    openSession: (hostId, sessionId) => {
      get().activateHost(hostId)
      if (!getHost(hostId)) return
      // 反馈2108#04：地址栏与当前会话必须一致，否则「查看」等按路由跳转的入口会被 navigate 的同址短路吞掉。
      navigate({ kind: 'session', hostId, sessionId })
      const current = get().active
      const stale = pendingFocus
      pendingFocus = null
      if (stale && !matchesView(stale, hostId, sessionId) && !matchesView(current, stale.hostId, stale.sessionId)) {
        dropView(stale.hostId, stale.sessionId)
      }
      openSessionView(hostId, sessionId)
      const view = get().sessionViews[viewKeyOf(hostId, sessionId)]
      // 没有可保留的当前画面（如刷新后直接打开）或目标已就绪时立即切换。
      if (!current || !view || isViewReady(view) || matchesView(current, hostId, sessionId)) {
        commitFocus(hostId, sessionId)
        return
      }
      pendingFocus = { hostId, sessionId }
      window.setTimeout(() => {
        if (pendingFocus?.hostId === hostId && pendingFocus.sessionId === sessionId) {
          get().commitPendingFocus(true)
        }
      }, PENDING_FOCUS_MS)
    },

    commitPendingFocus: (force = false) => {
      const target = pendingFocus
      if (!target) return
      const view = get().sessionViews[viewKeyOf(target.hostId, target.sessionId)]
      if (!view) {
        pendingFocus = null
        return
      }
      if (!force && !isViewReady(view)) return
      pendingFocus = null
      commitFocus(target.hostId, target.sessionId)
    },

    openSessionView,
    ensureSubagent,

    closeSessionView: (hostId, sessionId) => {
      const view = get().sessionViews[viewKeyOf(hostId, sessionId)]
      if (!view) return
      const wasActive = matchesView(get().active, hostId, sessionId)
      connections.get(hostId)?.unsubscribe(sessionId)
      removeSessionView(hostId, sessionId)
      const remaining = Object.values(get().sessionViews)
      if (wasActive) set({ active: remaining[0] ?? null })
      // 视图关闭后若没有别的视图还显示这些子代理，就一并退订：
      // 保留的订阅记录会让重新打开的主会话不再请求子代理快照，子代理视图停在骨架屏（反馈1603#08）。
      for (const childId of Object.keys(view.subagents)) {
        if (remaining.some((item) => item.hostId === hostId && !!item.subagents[childId])) continue
        childSubscriptions.get(hostId)?.delete(childId)
        connections.get(hostId)?.unsubscribe(childId)
      }
      if (!remaining.some((item) => item.hostId === hostId)) {
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
        conn.subscribe(sessionId, { tail: SESSION_TAIL_MESSAGES })
      } else {
        void core.loadSessionFallback(hostId, sessionId)
      }
    },

    undoCompaction: async (noticeId, target) => {
      const view = viewOf(target)
      const host = view ? getHost(view.hostId) : undefined
      if (!view || !host) return false
      if (view.running) {
        toast('会话正在运行，结束后才能撤销压缩', 'error')
        return false
      }
      try {
        const session = await api.undoCompaction(host, view.sessionId, noticeId)
        applySnapshot(view.hostId, session, [])
        toast('已恢复压缩前的上下文', 'success')
        return true
      } catch (err) {
        toast(err instanceof Error ? err.message : '撤销压缩失败', 'error')
        return false
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
      // 发送即进入会话：创建请求返回前先显示占位会话与用户消息，返回后换成真实会话。
      const draftId = `${DRAFT_SESSION_PREFIX}${newId()}`
      const draftKey = viewKeyOf(hostId, draftId)
      const now = Date.now()
      const draftSummary: SessionSummary = {
        id: draftId,
        title: input.title ?? '',
        cwd: input.cwd,
        profileId: input.profileId,
        groupId: input.groupId,
        model: input.model ?? '',
        permissionMode: input.permissionMode ?? 'default',
        effort: input.effort,
        delegation: input.delegation,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        usage: { inputTokens: 0, outputTokens: 0 },
      }
      const message: UiMessage = {
        id: `local-${newId()}`,
        role: 'user',
        content,
        createdAt: now,
        local: true,
      }
      const draft: ActiveSession = {
        ...emptyActiveSession(hostId, draftId, draftSummary),
        loading: false,
        messages: [message],
      }
      set((state) => ({
        sessionViews: { ...state.sessionViews, [draftKey]: draft },
        active: draft,
      }))
      let summary: SessionSummary
      try {
        summary = await api.createSession(host, input)
      } catch (err) {
        set((state) => {
          const views = { ...state.sessionViews }
          delete views[draftKey]
          return {
            sessionViews: views,
            active: matchesView(state.active, hostId, draftId) ? null : state.active,
          }
        })
        toast(err instanceof Error ? err.message : '创建会话失败', 'error')
        throw err
      }
      applySessionSummary(hostId, summary)
      const key = viewKeyOf(hostId, summary.id)
      set((state) => {
        const views = { ...state.sessionViews }
        delete views[draftKey]
        views[key] = emptyActiveSession(hostId, summary.id, summary)
        return { sessionViews: views, active: views[key] }
      })
      navigate({ kind: 'session', hostId, sessionId: summary.id })
      ensureConnection(hostId)?.subscribe(summary.id, { tail: SESSION_TAIL_MESSAGES })
      get().send(content, { hostId, sessionId: summary.id })
      return summary
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
