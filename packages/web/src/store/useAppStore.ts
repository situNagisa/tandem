import { create } from 'zustand'
import type {
  ContentBlock,
  CreateSessionInput,
  ExternalSession,
  ExternalSource,
  Message,
  PermissionDecision,
  PermissionMode,
  ServerMsg,
  Session,
  SessionSummary,
  SlashCommand,
  UpdateSessionInput,
} from '@tandem/protocol'
import { api, ApiError, type ExternalImportInput } from '../lib/api'
import { HostConnection } from '../lib/ws'
import { normalizeHostUrl } from '../lib/hostUrl'
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
import { navigate } from '../lib/router'
import { useUiStore } from './useUiStore'
import type {
  ActiveSession,
  ConnectionState,
  HostConfig,
  HostRuntime,
  ToolResultBlock,
  UiMessage,
} from '../lib/types'

interface AppState {
  initialized: boolean
  hosts: HostConfig[]
  activeHostId: string | null
  runtimes: Record<string, HostRuntime>
  active: ActiveSession | null

  initialize: () => void
  addHost: (input: { name: string; url: string; token: string }) => HostConfig
  updateHost: (id: string, patch: Partial<Pick<HostConfig, 'name' | 'url' | 'token'>>) => void
  removeHost: (id: string) => void
  activateHost: (id: string) => void
  retryHost: (id: string) => void
  refreshSessions: (hostId: string) => Promise<void>
  refreshProfiles: (hostId: string) => Promise<void>
  refreshCommands: (hostId: string) => Promise<SlashCommand[]>
  refreshExternalSessions: (hostId: string, force?: boolean) => Promise<ExternalSession[]>
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
  send: (blocks: ContentBlock[]) => boolean
  interrupt: () => void
  decidePermission: (requestId: string, decision: PermissionDecision) => void
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setModel: (profileId: string, groupId: string | undefined, model: string) => Promise<void>
  createSession: (hostId: string, input: CreateSessionInput) => Promise<SessionSummary>
  startSession: (hostId: string, input: CreateSessionInput, content: ContentBlock[]) => Promise<SessionSummary>
  updateSession: (
    hostId: string,
    sessionId: string,
    patch: UpdateSessionInput,
  ) => Promise<SessionSummary | null>
  forkSession: (hostId: string, sessionId: string) => Promise<SessionSummary | null>
  deleteSession: (hostId: string, sessionId: string) => Promise<void>
}

const connections = new Map<string, HostConnection>()
const commandsInFlight = new Set<string>()

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
    ...(s.pinned ? { pinned: true } : {}),
    ...(s.archived ? { archived: true } : {}),
    ...(s.env ? { env: s.env } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    usage: s.usage,
  }
}

function isRunningStatus(status: SessionSummary['status']): boolean {
  return status === 'running' || status === 'waiting_permission'
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

function toast(text: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  useUiStore.getState().toast(text, kind)
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
        applySnapshot(hostId, msg.session, msg.pendingPermissions)
        break
      }
      case 'session_updated': {
        applySessionSummary(hostId, msg.session)
        break
      }
      case 'session_deleted': {
        const active = get().active
        removeSummary(hostId, msg.sessionId)
        if (active && active.hostId === hostId && active.sessionId === msg.sessionId) {
          connections.get(hostId)?.unsubscribe(msg.sessionId)
          set({ active: null })
          navigate({ kind: 'host', hostId })
          toast('会话已被删除', 'info')
        }
        break
      }
      case 'message_start': {
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
        if (active && active.hostId === hostId && active.sessionId === req.sessionId) {
          patchActive(hostId, req.sessionId, (a) => {
            const pending = a.pending.some((p) => p.id === req.id) ? a.pending : [...a.pending, req]
            return { ...a, pending, running: true, stopping: false }
          })
          if (active.summary) {
            applySessionSummary(hostId, { ...active.summary, status: 'waiting_permission' })
          }
        }
        break
      }
      case 'permission_resolved': {
        const active = get().active
        if (!active || active.hostId !== hostId) break
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
        patchActive(hostId, msg.sessionId, (a) => ({ ...a, todos: msg.todos }))
        break
      }
      case 'turn_end': {
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
          const host = getHost(hostId)
          toast(`${host?.name ?? 'Host'}：${msg.error ?? '回合执行出错'}`, 'error')
        }
        if (activeSummaryForSession(hostId, msg.sessionId)) {
          const base = activeSummaryForSession(hostId, msg.sessionId)!
          applySessionSummary(hostId, {
            ...base,
            status: msg.reason === 'error' ? 'error' : 'idle',
            updatedAt: Date.now(),
          })
        }
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
    active: null,

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
      const url = normalizeHostUrl(input.url)
      const name = input.name.trim() || new URL(url).host
      const existing = get().hosts.find((h) => h.url === url)
      if (existing) {
        get().updateHost(existing.id, { name: input.name.trim() || existing.name, token: input.token })
        if (!get().activeHostId) {
          set({ activeHostId: existing.id })
          saveLastHost(existing.id)
        }
        return { ...existing, name: input.name.trim() || existing.name, token: input.token }
      }
      const host: HostConfig = { id: newId(), name, url, token: input.token, addedAt: Date.now() }
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
      let url = prev.url
      if (patch.url !== undefined) {
        try {
          url = normalizeHostUrl(patch.url)
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Host 地址无效', 'error')
          return
        }
      }
      const name = (patch.name ?? prev.name).trim() || new URL(url).host
      const token = patch.token ?? prev.token
      const next: HostConfig = { ...prev, name, url, token }
      set((state) => ({
        hosts: state.hosts.map((h) => (h.id === id ? next : h)),
      }))
      saveHosts(get().hosts)
      const conn = connections.get(id)
      if (conn) {
        if (url !== prev.url || token !== prev.token) {
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
        const list = await api.externalSessions(host)
        if (!getHost(hostId)) return list
        patchRuntime(hostId, {
          externalSessions: list,
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
        const rt = get().runtimes[hostId]
        if (rt) {
          patchRuntime(hostId, {
            externalSessions: rt.externalSessions.map((x) =>
              x.source === source && x.id === id
                ? { ...x, importedSessionId: summary.id }
                : x,
            ),
          })
        }
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
      if (current) connections.get(current.hostId)?.unsubscribe(current.sessionId)

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
        },
      })
      if (!rt?.sessionsLoaded) void get().refreshSessions(hostId)

      const conn = ensureConnection(hostId)
      conn?.subscribe(sessionId)
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
      if (active) connections.get(active.hostId)?.unsubscribe(active.sessionId)
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

    decidePermission: (requestId, decision) => {
      const active = get().active
      if (!active) return
      const conn = connections.get(active.hostId) ?? ensureConnection(active.hostId)
      const ok = conn?.send({ type: 'permission', requestId, decision }) ?? false
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

    forkSession: async (hostId, sessionId) => {
      const host = getHost(hostId)
      if (!host) return null
      try {
        const summary = await api.forkSession(host, sessionId)
        applySessionSummary(hostId, summary)
        toast('已复制会话', 'success')
        navigate({ kind: 'session', hostId, sessionId: summary.id })
        return summary
      } catch (err) {
        toast(err instanceof Error ? err.message : '复制会话失败', 'error')
        return null
      }
    },

    deleteSession: async (hostId, sessionId) => {
      const host = getHost(hostId)
      if (!host) return
      await api.deleteSession(host, sessionId)
      removeSummary(hostId, sessionId)
      const active = get().active
      if (active && active.hostId === hostId && active.sessionId === sessionId) {
        connections.get(hostId)?.unsubscribe(sessionId)
        set({ active: null })
        navigate({ kind: 'host', hostId })
      }
      toast('会话已删除', 'success')
    },
  }
})

