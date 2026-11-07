import type {
  PermissionRequest,
  ServerMsg,
  Session,
  SessionSummary,
} from '@tandem/protocol'
import type { StoreApi } from 'zustand'
import { api } from '../../lib/api'
import { HostConnection } from '../../lib/ws'
import type {
  ActiveSession,
  ConnectionState,
  ExternalSessionItem,
  HostConfig,
  HostRuntime,
  SubagentSession,
} from '../../lib/types'
import {
  appendSummary,
  childSubscriptions,
  collectToolResults,
  connections,
  emptySubagent,
  isDescendantSummary,
  isRunningStatus,
  matchesView,
  summaryOf,
  viewKeyOf,
} from './helpers'
import type { AppState } from './types'

/** useAppStore 内部共享的会话辅助函数，供各 slice 与 WS 消息处理复用。 */
export interface SessionCore {
  getHost: (id: string) => HostConfig | undefined
  patchRuntime: (hostId: string, patch: Partial<HostRuntime>) => void
  /** 外部会话列表同时写入 runtime 和按 hostId 的汇总表。 */
  setExternalSessions: (
    hostId: string,
    updater: (list: ExternalSessionItem[]) => ExternalSessionItem[],
  ) => void
  /** 更新一个已打开会话视图（不含子代理）；聚焦中时同步 active。 */
  patchView: (
    hostId: string,
    sessionId: string,
    updater: (active: ActiveSession) => ActiveSession,
  ) => void
  /** 兼容旧调用名：语义同 patchView。 */
  patchActive: (
    hostId: string,
    sessionId: string,
    updater: (active: ActiveSession) => ActiveSession,
  ) => void
  patchSubagent: (
    hostId: string,
    childId: string,
    updater: (sub: SubagentSession) => SubagentSession,
  ) => void
  addSubagent: (hostId: string, summary: SessionSummary) => void
  subscribeChild: (hostId: string, childId: string) => void
  syncChildren: (hostId: string, parentId: string) => void
  clearChildSubscriptions: (hostId: string) => void
  applySubagentSnapshot: (
    hostId: string,
    session: Session,
    pendingPermissions: PermissionRequest[],
  ) => void
  applySessionSummary: (hostId: string, summary: SessionSummary) => void
  activeSummaryForSession: (hostId: string, sessionId: string) => SessionSummary | null
  removeSummary: (hostId: string, sessionId: string) => void
  removeSessionView: (hostId: string, sessionId: string) => void
  applySnapshot: (
    hostId: string,
    session: Session,
    pendingPermissions: ActiveSession['pending'],
  ) => void
  loadSessionFallback: (hostId: string, sessionId: string) => Promise<void>
  ensureConnection: (hostId: string) => HostConnection | null
}

export function createSessionCore(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  onServerMessage: (hostId: string, msg: ServerMsg) => void,
): SessionCore {
  const getHost = (id: string): HostConfig | undefined => get().hosts.find((h) => h.id === id)

  const patchRuntime = (hostId: string, patch: Partial<HostRuntime>): void => {
    set((state) => {
      const rt = state.runtimes[hostId]
      if (!rt) return state
      return { runtimes: { ...state.runtimes, [hostId]: { ...rt, ...patch } } }
    })
  }

  const setExternalSessions = (
    hostId: string,
    updater: (list: ExternalSessionItem[]) => ExternalSessionItem[],
  ): void => {
    set((state) => {
      const rt = state.runtimes[hostId]
      const current = state.externalSessions[hostId] ?? rt?.externalSessions ?? []
      const next = updater(current)
      return {
        ...(rt
          ? { runtimes: { ...state.runtimes, [hostId]: { ...rt, externalSessions: next } } }
          : {}),
        externalSessions: { ...state.externalSessions, [hostId]: next },
      }
    })
  }

  const patchView = (
    hostId: string,
    sessionId: string,
    updater: (active: ActiveSession) => ActiveSession,
  ): void => {
    set((state) => {
      const key = viewKeyOf(hostId, sessionId)
      const current = state.sessionViews[key]
      const activeMatches = matchesView(state.active, hostId, sessionId)
      if (!current) {
        if (!activeMatches || !state.active) return state
        const next = updater(state.active)
        return {
          active: next,
          sessionViews: { ...state.sessionViews, [key]: next },
        }
      }
      const next = updater(current)
      if (next === current && (!activeMatches || state.active === current)) return state
      return {
        sessionViews: { ...state.sessionViews, [key]: next },
        ...(activeMatches ? { active: next } : {}),
      }
    })
  }

  const patchActive = patchView

  const patchSubagent = (
    hostId: string,
    childId: string,
    updater: (sub: SubagentSession) => SubagentSession,
  ): void => {
    set((state) => {
      let active = state.active
      let changed = false
      const views = { ...state.sessionViews }
      for (const [key, view] of Object.entries(state.sessionViews)) {
        if (view.hostId !== hostId) continue
        const sub = view.subagents[childId]
        if (!sub) continue
        const nextSub = updater(sub)
        if (nextSub === sub) continue
        const nextView = {
          ...view,
          subagents: { ...view.subagents, [childId]: nextSub },
        }
        views[key] = nextView
        if (matchesView(active, view.hostId, view.sessionId)) active = nextView
        changed = true
      }
      if (!changed && state.active && state.active.subagents[childId]) {
        const nextSub = updater(state.active.subagents[childId])
        if (nextSub !== state.active.subagents[childId]) {
          active = {
            ...state.active,
            subagents: { ...state.active.subagents, [childId]: nextSub },
          }
          changed = true
        }
      }
      return changed ? { sessionViews: views, active } : state
    })
  }

  const addSubagent = (hostId: string, summary: SessionSummary): void => {
    const sessions = get().runtimes[hostId]?.sessions ?? []
    let added = false
    set((state) => {
      let active = state.active
      let changed = false
      const views = { ...state.sessionViews }
      for (const [key, view] of Object.entries(state.sessionViews)) {
        if (view.hostId !== hostId) continue
        if (!isDescendantSummary(sessions, summary, view.sessionId)) continue
        const prev = view.subagents[summary.id]
        if (prev) {
          if (prev.summary === summary) continue
          views[key] = {
            ...view,
            subagents: { ...view.subagents, [summary.id]: { ...prev, summary } },
          }
        } else {
          views[key] = {
            ...view,
            subagents: { ...view.subagents, [summary.id]: emptySubagent(summary) },
          }
          added = true
        }
        if (matchesView(active, view.hostId, view.sessionId)) active = views[key]
        changed = true
      }
      return changed ? { sessionViews: views, active } : state
    })
    if (added) subscribeChild(hostId, summary.id)
  }

  const subscribeChild = (hostId: string, childId: string): void => {
    const hasChild = Object.values(get().sessionViews).some(
      (view) => view.hostId === hostId && !!view.subagents[childId],
    )
    if (!hasChild) return
    let set = childSubscriptions.get(hostId)
    if (!set) {
      set = new Set()
      childSubscriptions.set(hostId, set)
    }
    if (set.has(childId)) return
    set.add(childId)
    connections.get(hostId)?.subscribe(childId)
  }

  const syncChildren = (hostId: string, parentId: string): void => {
    const sessions = get().runtimes[hostId]?.sessions ?? []
    const hasParent = Object.values(get().sessionViews).some(
      (view) => view.hostId === hostId && view.sessionId === parentId,
    )
    if (!hasParent) return
    for (const child of sessions) {
      if (isDescendantSummary(sessions, child, parentId)) addSubagent(hostId, child)
    }
  }

  const clearChildSubscriptions = (hostId: string): void => {
    const set = childSubscriptions.get(hostId)
    if (!set) return
    const conn = connections.get(hostId)
    for (const id of set) conn?.unsubscribe(id)
    childSubscriptions.delete(hostId)
  }

  const applySubagentSnapshot = (
    hostId: string,
    session: Session,
    pendingPermissions: PermissionRequest[],
  ): void => {
    const summary = summaryOf(session)
    const sessions = get().runtimes[hostId]?.sessions ?? []
    set((state) => {
      let active = state.active
      let changed = false
      const views = { ...state.sessionViews }
      for (const [key, view] of Object.entries(state.sessionViews)) {
        if (view.hostId !== hostId) continue
        if (view.sessionId === session.id) continue
        if (!isDescendantSummary(sessions, summary, view.sessionId)) continue
        const last = session.messages[session.messages.length - 1]
        const next = {
          ...view,
          subagents: {
            ...view.subagents,
            [session.id]: {
              summary,
              messages: session.messages,
              pending: pendingPermissions,
              loading: false,
              running: isRunningStatus(session.status),
              streamingMessageId:
                session.status === 'running' && last?.role === 'assistant' ? last.id : undefined,
              liveToolInputs: {},
              toolResults: collectToolResults(session.messages),
            },
          },
        }
        views[key] = next
        if (matchesView(active, view.hostId, view.sessionId)) active = next
        changed = true
      }
      return changed ? { sessionViews: views, active } : state
    })
  }

  const applySessionSummary = (hostId: string, summary: SessionSummary): void => {
    set((state) => {
      const rt = state.runtimes[hostId]
      if (!rt) return state
      const runtimes = {
        ...state.runtimes,
        [hostId]: { ...rt, sessions: appendSummary(rt.sessions, summary) },
      }
      const key = viewKeyOf(hostId, summary.id)
      const view = state.sessionViews[key]
      const activeMatches = matchesView(state.active, hostId, summary.id)
      if (!view && !activeMatches) return { runtimes }
      const base = view ?? state.active!
      const next: ActiveSession = {
        ...base,
        summary,
        running: isRunningStatus(summary.status) ? true : base.running,
        turnError:
          summary.status === 'error'
            ? (base.turnError ?? '回合执行出错')
            : summary.status === 'running'
              ? undefined
              : base.turnError,
      }
      return {
        runtimes,
        sessionViews: { ...state.sessionViews, [key]: next },
        ...(activeMatches ? { active: next } : {}),
      }
    })
    if (summary.parentId) addSubagent(hostId, summary)
  }

  const activeSummaryForSession = (hostId: string, sessionId: string): SessionSummary | null => {
    const view = get().sessionViews[viewKeyOf(hostId, sessionId)]
    return view?.summary ?? null
  }

  const removeSummary = (hostId: string, sessionId: string): void => {
    set((state) => {
      const rt = state.runtimes[hostId]
      if (!rt) return state
      return {
        runtimes: {
          ...state.runtimes,
          [hostId]: { ...rt, sessions: rt.sessions.filter((s) => s.id !== sessionId) },
        },
      }
    })
  }

  const removeSessionView = (hostId: string, sessionId: string): void => {
    set((state) => {
      const key = viewKeyOf(hostId, sessionId)
      if (!state.sessionViews[key] && !matchesView(state.active, hostId, sessionId)) return state
      const sessionViews = { ...state.sessionViews }
      delete sessionViews[key]
      return {
        sessionViews,
        ...(matchesView(state.active, hostId, sessionId) ? { active: null } : {}),
      }
    })
  }

  const applySnapshot = (
    hostId: string,
    session: Session,
    pendingPermissions: ActiveSession['pending'],
  ): void => {
    const summary = summaryOf(session)
    set((state) => {
      const key = viewKeyOf(hostId, session.id)
      const view = state.sessionViews[key]
      const activeMatches = matchesView(state.active, hostId, session.id)
      if (!view && !activeMatches) return state
      const base = view ?? state.active!
      const rt = state.runtimes[hostId]
      const runtimes = rt
        ? { ...state.runtimes, [hostId]: { ...rt, sessions: appendSummary(rt.sessions, summary) } }
        : state.runtimes
      const last = session.messages[session.messages.length - 1]
      const next: ActiveSession = {
        ...base,
        summary,
        messages: session.messages,
        pending: pendingPermissions,
        todos: session.todos ?? [],
        loading: false,
        error: undefined,
        running: isRunningStatus(session.status),
        stopping: false,
        streamingMessageId:
          session.status === 'running' && last?.role === 'assistant' ? last.id : undefined,
        liveToolInputs: {},
        toolResults: collectToolResults(session.messages),
        plan: session.plan,
        hookEvents: [],
      }
      return {
        runtimes,
        sessionViews: { ...state.sessionViews, [key]: next },
        ...(activeMatches ? { active: next } : {}),
      }
    })
  }

  async function loadSessionFallback(hostId: string, sessionId: string): Promise<void> {
    const host = getHost(hostId)
    if (!host) return
    const key = viewKeyOf(hostId, sessionId)
    try {
      const session = await api.session(host, sessionId)
      if (!get().sessionViews[key]) return
      applySnapshot(hostId, session, [])
    } catch (err) {
      if (!get().sessionViews[key]) return
      patchView(hostId, sessionId, (a) => ({
        ...a,
        loading: false,
        error: err instanceof Error ? err.message : '加载会话失败',
      }))
    }
  }

  function ensureConnection(hostId: string): HostConnection | null {
    const host = getHost(hostId)
    if (!host) return null
    const existing = connections.get(hostId)
    if (existing) return existing

    const conn = new HostConnection(host, {
      onStatus: (status: ConnectionState, error?: string) => {
        patchRuntime(hostId, {
          status,
          error: status === 'offline' ? (error ?? '连接已断开，正在重连…') : undefined,
        })
      },
      onMessage: (msg) => onServerMessage(hostId, msg),
    })
    connections.set(hostId, conn)
    conn.connect()
    return conn
  }

  return {
    getHost,
    patchRuntime,
    setExternalSessions,
    patchView,
    patchActive,
    patchSubagent,
    addSubagent,
    subscribeChild,
    syncChildren,
    clearChildSubscriptions,
    applySubagentSnapshot,
    applySessionSummary,
    activeSummaryForSession,
    removeSummary,
    removeSessionView,
    applySnapshot,
    loadSessionFallback,
    ensureConnection,
  }
}
