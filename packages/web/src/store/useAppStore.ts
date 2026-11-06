import { create } from 'zustand'
import type {
  ContentBlock,
  CreateSessionInput,
  ExternalSession,
  ExternalSource,
  HookEventNotice,
  Message,
  PermissionDecision,
  PermissionRequest,
  PermissionMode,
  RewindInput,
  ServerMsg,
  Session,
  SessionSummary,
  SlashCommand,
  UpdateSessionInput,
} from '@tandem/protocol'
import { api, ApiError, type ExternalImportInput } from '../lib/api'
import { HostConnection } from '../lib/ws'
import { normalizeHostUrl } from '../lib/hostUrl'
import { isValidFingerprint, normalizeFingerprint, relayHostUrl } from '../lib/relay'
import {
  loadHosts,
  loadLastHost,
  readRecentDirsMap,
  sanitizeHosts,
  saveCollapsedProjects,
  saveHosts,
  saveLastHost,
  saveRecentDirsMap,
  type ClientSettingsBundle,
} from '../lib/storage'
import { navigate, parseHash } from '../lib/router'
import { notifyPermission, notifyTurnEnd } from '../lib/attention'
import { useUiStore } from './useUiStore'
import type {
  ActiveSession,
  ConnectionState,
  ExternalSessionItem,
  HostConfig,
  HookNotice,
  HostRuntime,
  SubagentSession,
  ToolResultBlock,
  UiMessage,
} from '../lib/types'

interface AppState {
  initialized: boolean
  hosts: HostConfig[]
  activeHostId: string | null
  runtimes: Record<string, HostRuntime>
  /** 外部会话按 hostId 汇总（元素带 hostId，方便侧栏合并展示）。 */
  externalSessions: Record<string, ExternalSessionItem[]>
  active: ActiveSession | null
  /** 回合结束后自增，改动审阅据此刷新。 */
  changesNonce: number
  /** 已打开但尚未创建的 worktree 意图，键为 `${hostId}:${sessionId}`；发送下一条消息前创建。 */
  worktreeIntents: Record<string, boolean>

  initialize: () => void
  checkConnections: () => void
  goOffline: () => void
  bumpChanges: () => void
  /** 打开文件浏览器（预览面板左侧树）；path 给定时同时预览该文件。 */
  openFileBrowser: (path?: string) => void
  addHost: (input: {
    name: string
    url: string
    token: string
    mode?: HostConfig['mode']
    relayUrl?: string
    hostId?: string
    fingerprint?: string
  }) => HostConfig
  updateHost: (
    id: string,
    patch: Partial<
      Pick<HostConfig, 'name' | 'url' | 'token' | 'mode' | 'relayUrl' | 'hostId' | 'fingerprint'>
    >,
  ) => void
  removeHost: (id: string) => void
  activateHost: (id: string) => void
  retryHost: (id: string) => void
  refreshSessions: (hostId: string) => Promise<void>
  refreshProfiles: (hostId: string) => Promise<void>
  refreshCommands: (hostId: string) => Promise<SlashCommand[]>
  refreshExternalSessions: (hostId: string, force?: boolean) => Promise<ExternalSessionItem[]>
  importExternalSession: (
    hostId: string,
    source: ExternalSource,
    id: string,
    input?: ExternalImportInput,
  ) => Promise<SessionSummary | null>
  /** 应用配置迁移带回的客户端设置（Host 列表 / 主题 / 侧栏偏好）。 */
  applyClientSettings: (settings: ClientSettingsBundle, mode: 'merge' | 'replace') => void

  openSession: (hostId: string, sessionId: string) => void
  closeSession: () => void
  reloadActiveSession: () => void
  clearTurnError: () => void
  send: (blocks: ContentBlock[]) => boolean
  interrupt: () => void
  decidePermission: (requestId: string, decision: PermissionDecision, reason?: string) => void
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  rewind: (input: RewindInput, seedText?: string) => Promise<boolean>
  setModel: (profileId: string, groupId: string | undefined, model: string) => Promise<void>
  createSession: (hostId: string, input: CreateSessionInput) => Promise<SessionSummary>
  startSession: (hostId: string, input: CreateSessionInput, content: ContentBlock[]) => Promise<SessionSummary>
  updateSession: (
    hostId: string,
    sessionId: string,
    patch: UpdateSessionInput,
  ) => Promise<SessionSummary | null>
  forkSession: (hostId: string, sessionId: string, messageId?: string) => Promise<SessionSummary | null>
  deleteSession: (hostId: string, sessionId: string, force?: boolean) => Promise<void>
  /** 单独停止一个 Task 子代理会话。 */
  interruptSubagent: (childId: string) => void
  /** 把 worktree 分支合回基准分支。 */
  mergeWorktree: (hostId: string, sessionId: string, strategy: 'merge' | 'squash') => Promise<boolean>
  /** 只记录 worktree 意图，不立即创建。 */
  setWorktreeIntent: (hostId: string, sessionId: string, on: boolean) => void
  /** 发送消息前创建待处理的 worktree；无需创建时直接返回 true。 */
  ensureWorktree: (hostId: string, sessionId: string) => Promise<boolean>
}

const connections = new Map<string, HostConnection>()
const commandsInFlight = new Set<string>()
/** 当前主会话已订阅的子代理会话，避免重复 subscribe 触发快照。 */
const childSubscriptions = new Map<string, Set<string>>()

function emptySubagent(summary: SessionSummary | null = null): SubagentSession {
  return {
    summary,
    messages: [],
    pending: [],
    loading: true,
    running: summary ? isRunningStatus(summary.status) : false,
    liveToolInputs: {},
    toolResults: {},
  }
}

function summaryOf(s: Session): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    profileId: s.profileId,
    ...(s.groupId ? { groupId: s.groupId } : {}),
    model: s.model,
    permissionMode: s.permissionMode,
    status: s.status,
    ...(s.effort ? { effort: s.effort } : {}),
    ...(s.pinned ? { pinned: true } : {}),
    ...(s.pinnedTurns && s.pinnedTurns.length ? { pinnedTurns: [...s.pinnedTurns] } : {}),
    ...(s.forkedFrom ? { forkedFrom: { ...s.forkedFrom } } : {}),
    ...(s.archived ? { archived: true } : {}),
    ...(s.env ? { env: s.env } : {}),
    ...(s.parentId ? { parentId: s.parentId } : {}),
    ...(typeof s.depth === 'number' ? { depth: s.depth } : {}),
    ...(s.worktree ? { worktree: s.worktree } : {}),
    ...(s.scheduledBy ? { scheduledBy: { ...s.scheduledBy } } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    usage: s.usage,
    ...(s.context ? { context: s.context } : {}),
  }
}

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

function freshRuntime(): HostRuntime {
  return {
    status: 'connecting',
    profiles: [],
    profilesLoaded: false,
    profilesLoading: false,
    sessions: [],
    sessionsLoaded: false,
    sessionsLoading: false,
    commands: [],
    commandsLoaded: false,
    externalSessions: [],
    externalLoaded: false,
    externalLoading: false,
  }
}

function sortSessions(list: SessionSummary[]): SessionSummary[] {
  return list.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}


function isRunningStatus(status: SessionSummary['status']): boolean {
  return status === 'running' || status === 'waiting_permission'
}

/** 旧数据没有 depth 时沿 parentId 链推算。 */
export function depthOf(summary: SessionSummary, sessions: SessionSummary[]): number {
  if (typeof summary.depth === 'number') return summary.depth
  let depth = 0
  let cursor: SessionSummary | undefined = summary
  const seen = new Set<string>([summary.id])
  while (cursor?.parentId && !seen.has(cursor.parentId)) {
    seen.add(cursor.parentId)
    depth++
    cursor = sessions.find((s) => s.id === cursor!.parentId)
  }
  return depth
}

/** summary 是否位于 rootId 之后（不含 root 本身）。 */
function isDescendantSummary(
  sessions: SessionSummary[],
  summary: SessionSummary,
  rootId: string,
): boolean {
  let cursor: SessionSummary | undefined = summary
  const seen = new Set<string>([summary.id])
  while (cursor?.parentId && !seen.has(cursor.parentId)) {
    if (cursor.parentId === rootId) return true
    seen.add(cursor.parentId)
    cursor = sessions.find((s) => s.id === cursor!.parentId)
  }
  return false
}

function collectToolResults(messages: Message[], base: Record<string, ToolResultBlock> = {}) {
  const map: Record<string, ToolResultBlock> = { ...base }
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === 'tool_result') map[block.toolUseId] = block
    }
  }
  return map
}

function hostHashFor(hostId: string | null): import('../lib/types').AppRoute {
  return hostId ? { kind: 'host', hostId } : { kind: 'home' }
}

function toast(
  text: string,
  kind: 'info' | 'success' | 'error' = 'info',
  options?: { onClick?: () => void },
): void {
  useUiStore.getState().toast(text, kind, options)
}

function appendSummary(list: SessionSummary[], summary: SessionSummary): SessionSummary[] {
  const idx = list.findIndex((s) => s.id === summary.id)
  if (idx < 0) return sortSessions([...list, summary])
  const next = list.slice()
  next[idx] = summary
  return sortSessions(next)
}

export const useAppStore = create<AppState>((set, get) => {
  const getHost = (id: string): HostConfig | undefined => get().hosts.find((h) => h.id === id)

  const patchRuntime = (hostId: string, patch: Partial<HostRuntime>): void => {
    set((state) => {
      const rt = state.runtimes[hostId]
      if (!rt) return state
      return { runtimes: { ...state.runtimes, [hostId]: { ...rt, ...patch } } }
    })
  }

  /** 外部会话列表同时写入 runtime 和按 hostId 的汇总表。 */
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

  const activeSummaryForSession = (
    hostId: string,
    sessionId: string,
  ): SessionSummary | null => {
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
      onMessage: (msg) => handleServerMessage(hostId, msg),
    })
    connections.set(hostId, conn)
    conn.connect()
    return conn
  }

  function handleServerMessage(hostId: string, msg: ServerMsg): void {
    const rt = get().runtimes[hostId]
    if (!rt) return
    switch (msg.type) {
      case 'hello': {
        patchRuntime(hostId, { info: msg.host, status: 'online', error: undefined })
        void get().refreshProfiles(hostId)
        void get().refreshSessions(hostId)
        void get().refreshExternalSessions(hostId)
        break
      }
      case 'session_snapshot': {
        const snapshotActive = get().active
        if (
          snapshotActive &&
          msg.session.id !== snapshotActive.sessionId &&
          msg.session.parentId
        ) {
          applySubagentSnapshot(hostId, msg.session, msg.pendingPermissions)
        } else {
          applySnapshot(hostId, msg.session, msg.pendingPermissions)
        }
        break
      }
      case 'session_updated': {
        applySessionSummary(hostId, msg.session)
        break
      }
      case 'external_sessions_changed': {
        void get().refreshExternalSessions(hostId, true)
        break
      }
      case 'session_deleted': {
        const active = get().active
        removeSummary(hostId, msg.sessionId)
        if (active?.hostId === hostId && active.subagents[msg.sessionId]) {
          childSubscriptions.get(hostId)?.delete(msg.sessionId)
          const subagents = { ...active.subagents }
          delete subagents[msg.sessionId]
          set({ active: { ...active, subagents } })
        }
        if (active && active.hostId === hostId && active.sessionId === msg.sessionId) {
          connections.get(hostId)?.unsubscribe(msg.sessionId)
          set({ active: null })
          navigate({ kind: 'host', hostId })
          toast('会话已被删除', 'info')
        }
        break
      }
      case 'message_start': {
        const startActive = get().active
        if (startActive?.hostId === hostId && startActive.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => {
            const message = msg.message
            const messages = sub.messages.some((m) => m.id === message.id)
              ? sub.messages.map((m) => (m.id === message.id ? message : m))
              : [...sub.messages, message]
            return {
              ...sub,
              messages,
              loading: false,
              running: message.role === 'assistant' ? true : sub.running,
              streamingMessageId:
                message.role === 'assistant' ? message.id : sub.streamingMessageId,
              toolResults:
                message.role === 'user'
                  ? collectToolResults([message], sub.toolResults)
                  : sub.toolResults,
            }
          })
          break
        }
        patchActive(hostId, msg.sessionId, (active) => {
          const message = msg.message
          let messages = active.messages
          const exists = messages.some((m) => m.id === message.id)
          if (exists) {
            messages = messages.map((m) => (m.id === message.id ? message : m))
          } else {
            if (message.role === 'user') {
              const firstLocal = messages.findIndex((m) => m.local)
              if (firstLocal >= 0) {
                messages = messages.filter((_, i) => i !== firstLocal)
              }
            }
            messages = [...messages, message]
          }
          const toolResults =
            message.role === 'user' ? collectToolResults([message], active.toolResults) : active.toolResults
          return {
            ...active,
            messages,
            toolResults,
            running: message.role === 'assistant' ? true : active.running,
            streamingMessageId: message.role === 'assistant' ? message.id : active.streamingMessageId,
            turnError: message.role === 'assistant' ? undefined : active.turnError,
            error: undefined,
          }
        })
        break
      }
      case 'block_delta': {
        const delta = msg.delta
        const deltaActive = get().active
        if (deltaActive?.hostId === hostId && deltaActive.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => {
            if (delta.kind === 'tool_input') {
              const key = `${msg.messageId}:${msg.index}`
              return {
                ...sub,
                liveToolInputs: {
                  ...sub.liveToolInputs,
                  [key]: (sub.liveToolInputs[key] ?? '') + delta.partialJson,
                },
              }
            }
            const messages = sub.messages.map((m) => {
              if (m.id !== msg.messageId) return m
              const content = m.content.slice()
              while (content.length < msg.index) content.push({ type: 'text', text: '' })
              if (delta.kind === 'block_start') content[msg.index] = delta.block
              else {
                const block = content[msg.index]
                if (block && (block.type === 'text' || block.type === 'thinking')) {
                  content[msg.index] = { ...block, text: block.text + delta.text }
                } else {
                  content[msg.index] = { type: 'text', text: delta.text }
                }
              }
              return { ...m, content }
            })
            return { ...sub, messages, running: true }
          })
          break
        }
        patchActive(hostId, msg.sessionId, (active) => {
          if (delta.kind === 'tool_input') {
            const key = `${msg.messageId}:${msg.index}`
            return {
              ...active,
              liveToolInputs: {
                ...active.liveToolInputs,
                [key]: (active.liveToolInputs[key] ?? '') + delta.partialJson,
              },
            }
          }
          const messages = active.messages.map((m) => {
            if (m.id !== msg.messageId) return m
            const content = m.content.slice()
            while (content.length < msg.index) content.push({ type: 'text', text: '' })
            if (delta.kind === 'block_start') {
              content[msg.index] = delta.block
            } else {
              const block = content[msg.index]
              if (block && (block.type === 'text' || block.type === 'thinking')) {
                content[msg.index] = { ...block, text: block.text + delta.text }
              } else {
                content[msg.index] = { type: 'text', text: delta.text }
              }
            }
            return { ...m, content }
          })
          return { ...active, messages, running: true }
        })
        break
      }
      case 'message_end': {
        const endActive = get().active
        if (endActive?.hostId === hostId && endActive.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => {
            const message = msg.message
            const messages = sub.messages.some((m) => m.id === message.id)
              ? sub.messages.map((m) => (m.id === message.id ? message : m))
              : [...sub.messages, message]
            const prefix = `${message.id}:`
            return {
              ...sub,
              messages,
              liveToolInputs: Object.fromEntries(
                Object.entries(sub.liveToolInputs).filter(([k]) => !k.startsWith(prefix)),
              ),
              toolResults: collectToolResults([message], sub.toolResults),
              streamingMessageId:
                sub.streamingMessageId === message.id ? undefined : sub.streamingMessageId,
            }
          })
          break
        }
        patchActive(hostId, msg.sessionId, (active) => {
          const message = msg.message
          let messages: UiMessage[]
          if (active.messages.some((m) => m.id === message.id)) {
            messages = active.messages.map((m) => (m.id === message.id ? message : m))
          } else {
            messages = [...active.messages, message]
          }
          const prefix = `${message.id}:`
          const liveToolInputs = Object.fromEntries(
            Object.entries(active.liveToolInputs).filter(([k]) => !k.startsWith(prefix)),
          )
          return {
            ...active,
            messages,
            liveToolInputs,
            toolResults: collectToolResults([message], active.toolResults),
            streamingMessageId:
              active.streamingMessageId === message.id ? undefined : active.streamingMessageId,
          }
        })
        break
      }
      case 'permission_request': {
        const req = msg.request
        const active = get().active
        if (
          active &&
          active.hostId === hostId &&
          active.subagents[req.sessionId]
        ) {
          patchSubagent(hostId, req.sessionId, (sub) => ({
            ...sub,
            pending: sub.pending.some((p) => p.id === req.id) ? sub.pending : [...sub.pending, req],
            running: true,
          }))
          // 子代理审批冒泡到主会话审批卡
          patchActive(hostId, active.sessionId, (a) => ({
            ...a,
            pending: a.pending.some((p) => p.id === req.id) ? a.pending : [...a.pending, req],
            running: true,
          }))
          const summary = get().runtimes[hostId]?.sessions.find((s) => s.id === req.sessionId)
          if (summary) applySessionSummary(hostId, { ...summary, status: 'waiting_permission' })
        }
        if (active && active.hostId === hostId && active.sessionId === req.sessionId) {
          patchActive(hostId, req.sessionId, (a) => {
            const pending = a.pending.some((p) => p.id === req.id) ? a.pending : [...a.pending, req]
            return { ...a, pending, running: true, stopping: false }
          })
          if (active.summary) {
            applySessionSummary(hostId, { ...active.summary, status: 'waiting_permission' })
          }
        }
        const notifySummary = get().runtimes[hostId]?.sessions.find(
          (s) => s.id === req.sessionId,
        )
        notifyPermission({
          hostId,
          sessionId: req.sessionId,
          sessionTitle: notifySummary?.title ?? '未命名会话',
          hostName: getHost(hostId)?.name ?? 'Host',
          requestId: req.id,
          description: req.description,
        })
        break
      }
      case 'permission_resolved': {
        const active = get().active
        if (!active || active.hostId !== hostId) break
        if (active.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => {
            const pending = sub.pending.filter((p) => p.id !== msg.requestId)
            return {
              ...sub,
              pending,
              running: pending.length > 0 ? true : sub.summary?.status === 'running',
              summary: sub.summary
                ? {
                    ...sub.summary,
                    status: pending.length > 0 ? 'waiting_permission' : 'running',
                  }
                : null,
            }
          })
          patchActive(hostId, active.sessionId, (a) => {
            const pending = a.pending.filter((p) => p.id !== msg.requestId)
            return {
              ...a,
              pending,
              summary: a.summary
                ? { ...a.summary, status: pending.length > 0 ? 'waiting_permission' : 'running' }
                : null,
            }
          })
          break
        }
        patchActive(hostId, msg.sessionId, (a) => {
          const pending = a.pending.filter((p) => p.id !== msg.requestId)
          const status = pending.length === 0 ? 'running' : 'waiting_permission'
          return {
            ...a,
            pending,
            summary: a.summary ? { ...a.summary, status } : null,
          }
        })
        const now = get().active
        if (now && now.hostId === hostId && now.sessionId === msg.sessionId && now.summary) {
          applySessionSummary(hostId, now.summary)
        }
        break
      }
      case 'todos': {
        const todoActive = get().active
        if (todoActive?.hostId === hostId && todoActive.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => ({
            ...sub,
            summary: sub.summary ? { ...sub.summary, updatedAt: Date.now() } : null,
          }))
          break
        }
        patchActive(hostId, msg.sessionId, (a) => ({ ...a, todos: msg.todos }))
        break
      }
      case 'plan': {
        patchActive(hostId, msg.sessionId, (a) => ({ ...a, plan: msg.plan }))
        break
      }
      case 'hook_event': {
        const hookActive = get().active
        const notice: HookNotice = {
          ...(hookActive && hookActive.sessionId === msg.sessionId
            ? {
                messageId:
                  hookActive.messages[hookActive.messages.length - 1]?.id,
              }
            : {}),
          sessionId: msg.sessionId,
          event: msg.event,
          name: msg.name,
          ok: msg.ok,
          durationMs: msg.durationMs,
          ...(msg.blocked ? { blocked: true } : {}),
          ...(msg.message ? { message: msg.message } : {}),
        }
        if (!notice.ok || notice.blocked) {
          patchActive(hostId, msg.sessionId, (a) => ({
            ...a,
            hookEvents: [...a.hookEvents, notice].slice(-20),
          }))
        }
        break
      }
      case 'turn_end': {
        const turnActive = get().active
        if (turnActive?.hostId === hostId && turnActive.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => {
            const messageId = sub.streamingMessageId
            return {
              ...sub,
              running: false,
              pending: [],
              streamingMessageId: undefined,
              liveToolInputs: messageId
                ? Object.fromEntries(
                    Object.entries(sub.liveToolInputs).filter(([k]) => !k.startsWith(`${messageId}:`)),
                  )
                : sub.liveToolInputs,
              error: msg.reason === 'error' ? (msg.error ?? '子代理执行出错') : undefined,
              summary: sub.summary
                ? {
                    ...sub.summary,
                    status: msg.reason === 'error' ? ('error' as const) : ('idle' as const),
                    updatedAt: Date.now(),
                  }
                : null,
            }
          })
          break
        }
        patchActive(hostId, msg.sessionId, (a) => {
          const messageId = a.streamingMessageId
          const liveToolInputs = messageId
            ? Object.fromEntries(
                Object.entries(a.liveToolInputs).filter(([k]) => !k.startsWith(`${messageId}:`)),
              )
            : a.liveToolInputs
          return {
            ...a,
            messages: a.messages.map((m) =>
              m.local && m.queued ? { ...m, queued: false } : m,
            ),
            running: false,
            stopping: false,
            pending: [],
            streamingMessageId: undefined,
            liveToolInputs,
            turnError: msg.reason === 'error' ? (msg.error ?? '回合执行出错') : undefined,
            summary: a.summary
              ? {
                  ...a.summary,
                  status: msg.reason === 'error' ? ('error' as const) : ('idle' as const),
                }
              : null,
          }
        })
        if (msg.reason === 'error') {
          const route = parseHash()
          const viewing =
            route.kind === 'session' &&
            route.hostId === hostId &&
            route.sessionId === msg.sessionId
          // 正在看这个会话时由对话底部横幅展示，避免同一条错误出现两次。
          if (!viewing) {
            const title =
              get().runtimes[hostId]?.sessions.find((s) => s.id === msg.sessionId)?.title ||
              '未命名会话'
            toast(`会话「${title}」出错`, 'error', {
              onClick: () => navigate({ kind: 'session', hostId, sessionId: msg.sessionId }),
            })
          }
        }
        set((state) => ({ changesNonce: state.changesNonce + 1 }))
        if (activeSummaryForSession(hostId, msg.sessionId)) {
          const base = activeSummaryForSession(hostId, msg.sessionId)!
          applySessionSummary(hostId, {
            ...base,
            status: msg.reason === 'error' ? 'error' : 'idle',
            updatedAt: Date.now(),
          })
        }
        const finished = get().runtimes[hostId]?.sessions.find((s) => s.id === msg.sessionId)
        notifyTurnEnd({
          hostId,
          sessionId: msg.sessionId,
          sessionTitle: finished?.title ?? '未命名会话',
          hostName: getHost(hostId)?.name ?? 'Host',
          reason: msg.reason,
          error: msg.error,
        })
        break
      }
      case 'error': {
        const host = getHost(hostId)
        toast(`${host?.name ?? 'Host'}：${msg.message}`, 'error')
        break
      }
      default:
        break
    }
  }

  return {
    initialized: false,
    hosts: [],
    activeHostId: null,
    runtimes: {},
    externalSessions: {},
    active: null,
    changesNonce: 0,
    worktreeIntents: {},

    checkConnections: () => {
      for (const [hostId, conn] of connections) {
        if (getHost(hostId)) conn.checkAlive()
      }
    },

    goOffline: () => {
      for (const conn of connections.values()) conn.markOffline()
    },

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

    initialize: () => {
      if (get().initialized) return
      let hosts = loadHosts()
      let preferredHostId: string | null = null

      // 首次通过 ?token= 打开：自动把当前 origin 注册为本机 Host，并清掉地址栏里的 token。
      try {
        const url = new URL(window.location.href)
        if (url.searchParams.has('token')) {
          const token = url.searchParams.get('token') ?? ''
          if (token) {
            const origin = url.origin
            const existing = hosts.find((h) => sameOrigin(h.url, origin))
            if (existing) {
              hosts = hosts.map((h) => (h.id === existing.id ? { ...h, token } : h))
              preferredHostId = existing.id
            } else {
              const host: HostConfig = {
                id: newId(),
                name: '本机',
                url: origin,
                token,
                addedAt: Date.now(),
              }
              hosts = [...hosts, host]
              preferredHostId = host.id
            }
          }
          url.searchParams.delete('token')
          const search = url.searchParams.toString()
          window.history.replaceState(
            window.history.state,
            '',
            url.pathname + (search ? `?${search}` : '') + url.hash,
          )
        }
      } catch {
        /* 地址异常时忽略 */
      }

      const runtimes: Record<string, HostRuntime> = {}
      for (const h of hosts) runtimes[h.id] = freshRuntime()
      const lastHostId = loadLastHost()
      const activeHostId =
        preferredHostId ??
        hosts.find((h) => h.id === lastHostId)?.id ??
        hosts[0]?.id ??
        null

      set({ initialized: true, hosts, runtimes, activeHostId })
      saveHosts(hosts)
      if (activeHostId) saveLastHost(activeHostId)

      for (const h of hosts) ensureConnection(h.id)
      if (activeHostId) {
        void get().refreshProfiles(activeHostId)
        void get().refreshSessions(activeHostId)
      }
    },

    addHost: (input) => {
      const mode = input.mode ?? 'direct'
      const relayUrl = input.relayUrl?.trim().replace(/\/+$/, '') || undefined
      const hostId = input.hostId?.trim() || undefined
      const fingerprint = input.fingerprint ? normalizeFingerprint(input.fingerprint) : undefined
      if (mode === 'relay') {
        if (!relayUrl || !/^https?:\/\//i.test(relayUrl)) throw new Error('请填写有效的中继地址')
        if (!hostId) throw new Error('请填写 Host ID')
        if (!fingerprint || !isValidFingerprint(fingerprint)) {
          throw new Error('必须填写 Host 公钥指纹（64 位十六进制），否则无法校验端到端加密')
        }
      }
      const rawUrl = mode === 'relay' && relayUrl && hostId ? relayHostUrl(relayUrl, hostId) : input.url
      const url = normalizeHostUrl(rawUrl)
      const name = input.name.trim() || new URL(url).host
      const existing = get().hosts.find((h) => h.url === url && (h.mode ?? 'direct') === mode)
      if (!existing && get().hosts.some((h) => h.name.trim().toLowerCase() === name.toLowerCase())) {
        throw new Error(`名称「${name}」已被使用，请换一个唯一的名称`)
      }
      if (existing) {
        const patch = {
          name: input.name.trim() || existing.name,
          token: input.token,
          ...(mode === 'relay' ? { mode, relayUrl, hostId, fingerprint } : {}),
        }
        get().updateHost(existing.id, patch)
        if (!get().activeHostId) {
          set({ activeHostId: existing.id })
          saveLastHost(existing.id)
        }
        return { ...existing, ...patch }
      }
      const host: HostConfig = {
        id: newId(),
        name,
        url,
        token: input.token,
        addedAt: Date.now(),
        ...(mode === 'relay' ? { mode, relayUrl, hostId, fingerprint } : {}),
      }
      set((state) => ({
        hosts: [...state.hosts, host],
        runtimes: { ...state.runtimes, [host.id]: freshRuntime() },
        activeHostId: state.activeHostId ?? host.id,
      }))
      if (!loadLastHost() || !get().hosts.some((h) => h.id === loadLastHost())) {
        saveLastHost(get().activeHostId ?? host.id)
      } else if (get().activeHostId === host.id) {
        saveLastHost(host.id)
      }
      saveHosts(get().hosts)
      ensureConnection(host.id)
      void get().refreshProfiles(host.id)
      void get().refreshSessions(host.id)
      return host
    },

    updateHost: (id, patch) => {
      const prev = getHost(id)
      if (!prev) return
      const mode = patch.mode ?? prev.mode ?? 'direct'
      let relayUrl = patch.relayUrl ?? prev.relayUrl
      let hostId = patch.hostId ?? prev.hostId
      let fingerprint =
        patch.fingerprint !== undefined ? normalizeFingerprint(patch.fingerprint) : prev.fingerprint
      if (mode === 'relay') {
        relayUrl = relayUrl?.trim().replace(/\/+$/, '')
        hostId = hostId?.trim()
        if (!relayUrl || !/^https?:\/\//i.test(relayUrl)) {
          toast('请填写有效的中继地址', 'error')
          return
        }
        if (!hostId) {
          toast('请填写 Host ID', 'error')
          return
        }
        if (!fingerprint || !isValidFingerprint(fingerprint)) {
          toast('必须填写 Host 公钥指纹（64 位十六进制）', 'error')
          return
        }
      }
      let url = prev.url
      const rawUrl =
        mode === 'relay' && relayUrl && hostId
          ? relayHostUrl(relayUrl, hostId)
          : (patch.url ?? prev.url)
      try {
        url = normalizeHostUrl(rawUrl)
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Host 地址无效', 'error')
        return
      }
      const name = (patch.name ?? prev.name).trim() || new URL(url).host
      const token = patch.token ?? prev.token
      const next: HostConfig = {
        ...prev,
        name,
        url,
        token,
        ...(mode === 'relay'
          ? { mode, relayUrl, hostId, fingerprint }
          : { mode: 'direct' as const, relayUrl: undefined, hostId: undefined, fingerprint: undefined }),
      }
      set((state) => ({
        hosts: state.hosts.map((h) => (h.id === id ? next : h)),
      }))
      saveHosts(get().hosts)
      const conn = connections.get(id)
      const changed =
        url !== prev.url ||
        token !== prev.token ||
        mode !== (prev.mode ?? 'direct') ||
        fingerprint !== prev.fingerprint
      if (conn) {
        if (changed) {
          patchRuntime(id, { status: 'connecting', authError: undefined, error: undefined })
          conn.updateHost(next)
          void get().refreshProfiles(id)
          void get().refreshSessions(id)
        }
      } else {
        ensureConnection(id)
      }
    },

    removeHost: (id) => {
      const host = getHost(id)
      if (!host) return
      const removingActiveSession = get().active?.hostId === id
      connections.get(id)?.close()
      connections.delete(id)
      set((state) => {
        const hosts = state.hosts.filter((h) => h.id !== id)
        const runtimes = { ...state.runtimes }
        delete runtimes[id]
        const wasActive = state.active?.hostId === id
        let activeHostId = state.activeHostId
        if (activeHostId === id) activeHostId = hosts[0]?.id ?? null
        return {
          hosts,
          runtimes,
          activeHostId,
          active: wasActive ? null : state.active,
        }
      })
      saveHosts(get().hosts)
      const nextActive = get().activeHostId
      if (nextActive) saveLastHost(nextActive)
      if (removingActiveSession) navigate(hostHashFor(nextActive))
      toast(`已移除 Host「${host.name}」`, 'success')
    },

    activateHost: (id) => {
      if (!get().hosts.some((h) => h.id === id)) return
      if (get().activeHostId !== id) {
        set({ activeHostId: id })
        saveLastHost(id)
      }
      const rt = get().runtimes[id]
      if (rt) {
        if (!rt.profilesLoaded && !rt.profilesLoading) void get().refreshProfiles(id)
        if (!rt.sessionsLoaded && !rt.sessionsLoading) void get().refreshSessions(id)
      }
      ensureConnection(id)
    },

    retryHost: (id) => {
      const conn = connections.get(id) ?? ensureConnection(id)
      conn?.reconnectNow()
    },

    refreshSessions: async (hostId) => {
      const host = getHost(hostId)
      if (!host) return
      const rt = get().runtimes[hostId]
      if (!rt || rt.sessionsLoading) return
      patchRuntime(hostId, { sessionsLoading: true })
      try {
        const sessions = await api.sessions(host)
        if (!getHost(hostId)) return
        patchRuntime(hostId, {
          sessions: sortSessions(sessions),
          sessionsLoaded: true,
          sessionsLoading: false,
          authError: undefined,
          error: undefined,
        })
        const active = get().active
        if (active?.hostId === hostId) syncChildren(hostId, active.sessionId)
      } catch (err) {
        if (!getHost(hostId)) return
        const auth = err instanceof ApiError && (err.status === 401 || err.status === 403)
        patchRuntime(hostId, {
          sessionsLoading: false,
          error: err instanceof Error ? err.message : '获取会话列表失败',
          authError: auth ? (err instanceof Error ? err.message : '认证失败') : undefined,
        })
      }
    },

    refreshProfiles: async (hostId) => {
      const host = getHost(hostId)
      if (!host) return
      const rt = get().runtimes[hostId]
      if (!rt || rt.profilesLoading) return
      patchRuntime(hostId, { profilesLoading: true })
      try {
        const profiles = await api.profiles(host)
        if (!getHost(hostId)) return
        patchRuntime(hostId, {
          profiles,
          profilesLoaded: true,
          profilesLoading: false,
          authError: undefined,
          error: undefined,
        })
      } catch (err) {
        if (!getHost(hostId)) return
        const auth = err instanceof ApiError && (err.status === 401 || err.status === 403)
        patchRuntime(hostId, {
          profilesLoading: false,
          error: err instanceof Error ? err.message : '获取账号列表失败',
          authError: auth ? (err instanceof Error ? err.message : '认证失败') : undefined,
        })
      }
    },

    refreshCommands: async (hostId) => {
      const host = getHost(hostId)
      if (!host) return []
      const rt = get().runtimes[hostId]
      if (rt?.commandsLoaded) return rt.commands
      if (commandsInFlight.has(hostId)) return rt?.commands ?? []
      commandsInFlight.add(hostId)
      try {
        const commands = await api.commands(host)
        commandsInFlight.delete(hostId)
        if (!getHost(hostId)) return commands
        patchRuntime(hostId, { commands, commandsLoaded: true })
        return commands
      } catch {
        commandsInFlight.delete(hostId)
        return []
      }
    },

    refreshExternalSessions: async (hostId, force = false) => {
      const host = getHost(hostId)
      const rt = get().runtimes[hostId]
      if (!host || !rt) return []
      if (rt.externalLoading) return rt.externalSessions
      if (rt.externalLoaded && !force) return rt.externalSessions
      patchRuntime(hostId, { externalLoading: true, externalError: undefined })
      try {
        const list = (await api.externalSessions(host)).map((item) => ({
          ...item,
          hostId,
        }))
        if (!getHost(hostId)) return list
        setExternalSessions(hostId, () => list)
        patchRuntime(hostId, {
          externalLoaded: true,
          externalLoading: false,
          externalError: undefined,
        })
        return list
      } catch (err) {
        if (getHost(hostId)) {
          patchRuntime(hostId, {
            externalLoading: false,
            externalError: err instanceof Error ? err.message : '读取外部会话失败',
          })
        }
        return get().runtimes[hostId]?.externalSessions ?? []
      }
    },

    importExternalSession: async (hostId, source, id, input = {}) => {
      const host = getHost(hostId)
      if (!host) return null
      try {
        const summary = await api.importExternalSession(host, source, id, input)
        applySessionSummary(hostId, summary)
        setExternalSessions(hostId, (list) =>
          list.map((x) =>
            x.source === source && x.id === id
              ? { ...x, importedSessionId: summary.id }
              : x,
          ),
        )
        navigate({ kind: 'session', hostId, sessionId: summary.id })
        toast('已导入为 Tandem 会话，可以继续对话', 'success')
        return summary
      } catch (err) {
        toast(err instanceof Error ? err.message : '导入会话失败', 'error')
        return null
      }
    },

    applyClientSettings: (settings, mode) => {
      // 文件里没有 Host 列表时（例如旧版本/其他端导出），保留本机 Host，避免清空。
      const hasHosts = Array.isArray(settings.hosts)
      const imported = hasHosts ? sanitizeHosts(settings.hosts) : []
      const replaceHosts = mode === 'replace' && hasHosts
      const normalized = (url: string): string => {
        try {
          return normalizeHostUrl(url)
        } catch {
          return url
        }
      }
      const before = get().hosts
      let hosts: HostConfig[]
      if (replaceHosts) {
        for (const id of connections.keys()) {
          connections.get(id)?.close()
        }
        connections.clear()
        const seen = new Set<string>()
        hosts = imported.map((h) => {
          const id = h.id && !seen.has(h.id) ? h.id : newId()
          seen.add(id)
          return { ...h, id }
        })
      } else {
        hosts = before.slice()
        if (hasHosts) {
          for (const h of imported) {
            const existing = hosts.find((x) => normalized(x.url) === normalized(h.url))
            if (existing) continue
            const id = hosts.some((x) => x.id === h.id) ? newId() : h.id
            hosts.push({ ...h, id })
          }
        }
      }

      const runtimes = replaceHosts ? {} : { ...get().runtimes }
      for (const h of hosts) {
        if (!runtimes[h.id]) runtimes[h.id] = freshRuntime()
      }
      const activeHostId = replaceHosts
        ? (hosts.find((h) => h.id === settings.lastHost)?.id ?? hosts[0]?.id ?? null)
        : get().activeHostId && hosts.some((h) => h.id === get().activeHostId)
          ? get().activeHostId
          : (hosts[0]?.id ?? null)

      const active = get().active
      if (replaceHosts && active) connections.get(active.hostId)?.unsubscribe(active.sessionId)
      set({
        hosts,
        runtimes,
        activeHostId,
        ...(replaceHosts ? { active: null } : {}),
      })
      if (replaceHosts && active) navigate({ kind: 'home' })
      saveHosts(hosts)
      if (activeHostId) saveLastHost(activeHostId)

      const ui = useUiStore.getState()
      if (settings.theme === 'light' || settings.theme === 'dark' || settings.theme === 'system') {
        ui.setTheme(settings.theme)
      }
      const prefs = settings.ui ?? {}
      if (typeof prefs.sidebarCollapsed === 'boolean') ui.setSidebarCollapsed(prefs.sidebarCollapsed)
      if (typeof prefs.sidebarWidth === 'number') ui.setSidebarWidth(prefs.sidebarWidth)
      if (typeof prefs.panelOpen === 'boolean') ui.setPanelOpen(prefs.panelOpen)
      if (Array.isArray(prefs.collapsedProjects)) {
        const map: Record<string, boolean> = {}
        for (const key of prefs.collapsedProjects) {
          if (typeof key === 'string') map[key] = true
        }
        useUiStore.setState({ collapsedProjects: map })
        saveCollapsedProjects(map)
      }

      if (settings.recentDirs && typeof settings.recentDirs === 'object') {
        const merged = mode === 'replace' ? {} : readRecentDirsMap()
        for (const [hostId, dirs] of Object.entries(settings.recentDirs)) {
          if (!Array.isArray(dirs)) continue
          const clean = dirs.filter((d): d is string => typeof d === 'string')
          const prev = merged[hostId] ?? []
          merged[hostId] = [...new Set([...prev, ...clean])].slice(0, 8)
        }
        saveRecentDirsMap(merged)
      }

      for (const h of hosts) {
        ensureConnection(h.id)
        void get().refreshProfiles(h.id)
        void get().refreshSessions(h.id)
      }
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
      syncChildren(hostId, sessionId)
      // WebSocket 尚未连上时，先用 REST 拉一份只读快照，避免空白等待。
      if (!conn || conn.status !== 'online') void loadSessionFallback(hostId, sessionId)
      else {
        // 正常情况下 snapshot 会立刻到达；若 3 秒仍空白再兜底一次。
        window.setTimeout(() => {
          const a = get().active
          if (a && a.hostId === hostId && a.sessionId === sessionId && a.loading && a.messages.length === 0) {
            void loadSessionFallback(hostId, sessionId)
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
        void loadSessionFallback(active.hostId, active.sessionId)
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
      const local: UiMessage = {
        id: `local-${newId()}`,
        role: 'user',
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

