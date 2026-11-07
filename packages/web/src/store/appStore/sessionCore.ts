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
  summaryOf,
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

  const patchActive = (
    hostId: string,
    sessionId: string,
    updater: (active: ActiveSession) => ActiveSession,
  ): void => {
    set((state) => {
      if (!state.active || state.active.hostId !== hostId || state.active.sessionId !== sessionId) {
        return state
      }
      return { active: updater(state.active) }
    })
  }

  const patchSubagent = (
    hostId: string,
    childId: string,
    updater: (sub: SubagentSession) => SubagentSession,
  ): void => {
    set((state) => {
      const active = state.active
      if (!active || active.hostId !== hostId || !active.subagents[childId]) return state
      return {
        active: {
          ...active,
          subagents: { ...active.subagents, [childId]: updater(active.subagents[childId]) },
        },
      }
    })
  }

  const addSubagent = (hostId: string, summary: SessionSummary): void => {
    const current = get().active
    if (!current || current.hostId !== hostId || !summary.parentId) return
    const sessions = get().runtimes[hostId]?.sessions ?? []
    if (!isDescendantSummary(sessions, summary, current.sessionId)) return
    set((state) => {
      const active = state.active
      if (!active || active.hostId !== hostId) return state
      const prev = active.subagents[summary.id]
      if (prev) {
        if (prev.summary === summary) return state
        return {
          active: {
            ...active,
            subagents: { ...active.subagents, [summary.id]: { ...prev, summary } },
          },
        }
      }
      return {
        active: {
          ...active,
          subagents: { ...active.subagents, [summary.id]: emptySubagent(summary) },
        },
      }
    })
    subscribeChild(hostId, summary.id)
  }

  const subscribeChild = (hostId: string, childId: string): void => {
    const active = get().active
    if (!active || active.hostId !== hostId) return
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
    const active = get().active
    if (!active || active.hostId !== hostId || active.sessionId !== parentId) return
    const sessions = get().runtimes[hostId]?.sessions ?? []
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
    const activeNow = get().active
    if (
      !activeNow ||
      activeNow.hostId !== hostId ||
      !isDescendantSummary(sessions, summary, activeNow.sessionId)
    ) {
      return
    }
    set((state) => {
      const active = state.active
      if (!active || active.hostId !== hostId) return state
      const last = session.messages[session.messages.length - 1]
      return {
        active: {
          ...active,
          subagents: {
            ...active.subagents,
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
        },
      }
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
      if (!state.active || state.active.hostId !== hostId || state.active.sessionId !== summary.id) {
        return { runtimes }
      }
      const active: ActiveSession = {
        ...state.active,
        summary,
        running: isRunningStatus(summary.status) ? true : state.active.running,
        turnError:
          summary.status === 'error'
            ? (state.active.turnError ?? '回合执行出错')
            : summary.status === 'running'
              ? undefined
              : state.active.turnError,
      }
      return { runtimes, active }
    })
    if (summary.parentId) addSubagent(hostId, summary)
  }

  const activeSummaryForSession = (hostId: string, sessionId: string): SessionSummary | null => {
    const active = get().active
    if (!active || active.hostId !== hostId || active.sessionId !== sessionId) return null
    return active.summary
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

  const applySnapshot = (
    hostId: string,
    session: Session,
    pendingPermissions: ActiveSession['pending'],
  ): void => {
    const summary = summaryOf(session)
    set((state) => {
      if (
        !state.active ||
        state.active.hostId !== hostId ||
        state.active.sessionId !== session.id
      ) {
        return state
      }
      const rt = state.runtimes[hostId]
      const runtimes = rt
        ? { ...state.runtimes, [hostId]: { ...rt, sessions: appendSummary(rt.sessions, summary) } }
        : state.runtimes
      const last = session.messages[session.messages.length - 1]
      return {
        runtimes,
        active: {
          ...state.active,
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
        },
      }
    })
  }

  async function loadSessionFallback(hostId: string, sessionId: string): Promise<void> {
    const host = getHost(hostId)
    if (!host) return
    try {
      const session = await api.session(host, sessionId)
      if (!get().active || get().active?.sessionId !== sessionId) return
      applySnapshot(hostId, session, [])
    } catch (err) {
      if (!get().active || get().active?.sessionId !== sessionId) return
      patchActive(hostId, sessionId, (a) => ({
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
    applySnapshot,
    loadSessionFallback,
    ensureConnection,
  }
}
