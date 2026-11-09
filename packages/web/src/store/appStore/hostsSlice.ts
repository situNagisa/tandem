import type { AccountLoginResult, SessionSummary } from '@tandem/protocol'
import type { StoreApi } from 'zustand'
import { api, ApiError, workstationApi } from '../../lib/api'
import { normalizeHostUrl } from '../../lib/hostUrl'
import { inviteFromLocation } from '../../lib/inviteLink'
import { isValidFingerprint, normalizeFingerprint, relayHostUrl } from '../../lib/relay'
import {
  loadAccountSession,
  loadHosts,
  loadLastHost,
  readRecentDirsMap,
  sanitizeHosts,
  saveAccountSession,
  saveLastWorkstationUrl,
  saveCollapsedProjects,
  saveHosts,
  saveLastHost,
  saveRecentDirsMap,
} from '../../lib/storage'
import { navigate } from '../../lib/router'
import { loginGateEnabled } from '../../lib/loginGate'
import { stashLocalHosts } from '../../lib/localHosts'
import type { HostConnection } from '../../lib/ws'
import type { AccountSession, ExternalSessionItem, HostConfig, HostRuntime } from '../../lib/types'
import { useUiStore } from '../useUiStore'
import {
  commandsInFlight,
  connections,
  freshRuntime,
  hostHashFor,
  newId,
  sameOrigin,
  sortSessions,
  toast,
} from './helpers'
import type { AppState } from './types'

export type HostsSlice = Pick<
  AppState,
  | 'checkConnections'
  | 'goOffline'
  | 'initialize'
  | 'addHost'
  | 'updateHost'
  | 'removeHost'
  | 'activateHost'
  | 'retryHost'
  | 'refreshSessions'
  | 'refreshProfiles'
  | 'refreshCommands'
  | 'refreshExternalSessions'
  | 'importExternalSession'
  | 'applyClientSettings'
  | 'workspaceLogin'
  | 'workspaceRegister'
  | 'applyWorkstationLogin'
  | 'syncWorkstationHosts'
  | 'workspaceLogout'
  | 'refreshWorkspace'
>

interface HostsSliceDeps {
  patchRuntime: (hostId: string, patch: Partial<HostRuntime>) => void
  setExternalSessions: (
    hostId: string,
    updater: (list: ExternalSessionItem[]) => ExternalSessionItem[],
  ) => void
  ensureConnection: (hostId: string) => HostConnection | null
  applySessionSummary: (hostId: string, summary: SessionSummary) => void
  syncChildren: (hostId: string, parentId: string) => void
}

/** 从工作区下发的地址里挑一个与账号中心同主机的；避免远程客户端拿到 127.0.0.1。 */
function pickWorkspaceUrl(centerUrl: string, urls: string[]): string | undefined {
  const valid = urls.filter((u) => /^https?:\/\//i.test(u))
  if (!valid.length) return undefined
  let centerHost = ''
  try {
    centerHost = new URL(centerUrl).hostname
  } catch {
    /* 忽略 */
  }
  const sameHost = valid.find((u) => {
    try {
      return new URL(u).hostname === centerHost
    } catch {
      return false
    }
  })
  if (sameHost) return sameHost
  return valid.find((u) => {
    try {
      const h = new URL(u).hostname
      return h !== '127.0.0.1' && h !== 'localhost' && h !== '::1'
    } catch {
      return false
    }
  }) ?? valid[0]
}

export function createHostsSlice(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  deps: HostsSliceDeps,
): HostsSlice {
  const getHost = (id: string): HostConfig | undefined => get().hosts.find((h) => h.id === id)

  /** 清掉账号会话与账号下的主机（断开连接、清掉活动会话）；之后登录门会显示登录页。 */
  const clearAccountState = (accountId: string | undefined): void => {
    saveAccountSession(null)
    const removed = get().hosts.filter((h) => h.accountId === accountId)
    for (const h of removed) {
      connections.get(h.id)?.close()
      connections.delete(h.id)
    }
    const hosts = get().hosts.filter((h) => h.accountId !== accountId)
    const removedIds = new Set(removed.map((h) => h.id))
    const activeHostId = hosts.some((h) => h.id === get().activeHostId)
      ? get().activeHostId
      : (hosts[0]?.id ?? null)
    set((state) => ({
      account: null,
      hosts,
      activeHostId,
      runtimes: Object.fromEntries(Object.entries(state.runtimes).filter(([id]) => !removedIds.has(id))),
      sessionViews: Object.fromEntries(
        Object.entries(state.sessionViews).filter(([, view]) => !removedIds.has(view.hostId)),
      ),
      active: state.active && removedIds.has(state.active.hostId) ? null : state.active,
    }))
    saveHosts(hosts)
    if (activeHostId) saveLastHost(activeHostId)
  }

  return {
    checkConnections: () => {
      for (const [hostId, conn] of connections) {
        if (getHost(hostId)) conn.checkAlive()
      }
    },

    goOffline: () => {
      for (const conn of connections.values()) conn.markOffline()
    },

    initialize: () => {
      if (get().initialized) return
      // 登录门开启时，工作台只显示账号下的主机：直连凭据（地址 + 主 token）转入本机凭据，
      // 只用于「添加这台电脑」等本机管理。调试版测试开关（?gate=off）保留旧的直连行为。
      const gate = loginGateEnabled()
      let hosts = loadHosts()
      let preferredHostId: string | null = null
      const stashed: HostConfig[] = []

      // 首次通过 ?token= 打开：自动把当前 origin 注册为本机 Host，并清掉地址栏里的 token。
      try {
        const url = new URL(window.location.href)
        if (url.searchParams.has('token')) {
          const token = url.searchParams.get('token') ?? ''
          if (token && gate) {
            stashed.push({ id: newId(), name: '本机', url: url.origin, token, addedAt: Date.now() })
          } else if (token) {
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

      // 同事直接打开邀请链接：弹出入职对话框，并清掉地址栏里的邀请码。
      try {
        const invite = inviteFromLocation()
        if (invite) {
          useUiStore.getState().openJoinInvite(invite)
          const url = new URL(window.location.href)
          url.hash = '#/'
          url.searchParams.delete('invite')
          window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
        }
      } catch {
        /* 忽略 */
      }

      let account = loadAccountSession()
      if (gate) {
        stashLocalHosts([...hosts.filter((h) => !h.accountId), ...stashed])
        hosts = hosts.filter((h) => !!h.accountId)
        // 登录已过期（刷新令牌也失效）按未登录处理：回到登录页，不再连接任何主机。
        if (account && account.refreshExpiresAt <= Date.now()) {
          saveLastWorkstationUrl(account.centerUrl)
          account = null
        }
        if (!account) hosts = []
      }
      const runtimes: Record<string, HostRuntime> = {}
      for (const h of hosts) runtimes[h.id] = freshRuntime()
      const lastHostId = loadLastHost()
      const activeHostId =
        preferredHostId ??
        hosts.find((h) => h.id === lastHostId)?.id ??
        hosts[0]?.id ??
        null

      set({ initialized: true, hosts, account, runtimes, activeHostId })
      saveHosts(hosts)
      if (activeHostId) saveLastHost(activeHostId)

      for (const h of hosts) deps.ensureConnection(h.id)
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
      deps.ensureConnection(host.id)
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
          deps.patchRuntime(id, { status: 'connecting', authError: undefined, error: undefined })
          conn.updateHost(next)
          void get().refreshProfiles(id)
          void get().refreshSessions(id)
        }
      } else {
        deps.ensureConnection(id)
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
        const sessionViews = Object.fromEntries(
          Object.entries(state.sessionViews).filter(([, view]) => view.hostId !== id),
        )
        return {
          hosts,
          runtimes,
          activeHostId,
          sessionViews,
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
      deps.ensureConnection(id)
    },

    retryHost: (id) => {
      const conn = connections.get(id) ?? deps.ensureConnection(id)
      conn?.reconnectNow()
    },

    refreshSessions: async (hostId) => {
      const host = getHost(hostId)
      if (!host) return
      const rt = get().runtimes[hostId]
      if (!rt || rt.sessionsLoading) return
      deps.patchRuntime(hostId, { sessionsLoading: true })
      try {
        const sessions = await api.sessions(host)
        if (!getHost(hostId)) return
        deps.patchRuntime(hostId, {
          sessions: sortSessions(sessions),
          sessionsLoaded: true,
          sessionsLoading: false,
          authError: undefined,
          error: undefined,
        })
        const active = get().active
        if (active?.hostId === hostId) deps.syncChildren(hostId, active.sessionId)
      } catch (err) {
        if (!getHost(hostId)) return
        const auth = err instanceof ApiError && (err.status === 401 || err.status === 403)
        deps.patchRuntime(hostId, {
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
      deps.patchRuntime(hostId, { profilesLoading: true })
      try {
        // 工作站模式：账号与模型是账号级数据，只从工作站读取；所有主机共用同一份。
        const account = get().account
        const profiles = account
          ? (await workstationApi.profiles(account.centerUrl, account.accessToken)).profiles
          : await api.profiles(host)
        if (!getHost(hostId)) return
        deps.patchRuntime(hostId, {
          profiles,
          profilesLoaded: true,
          profilesLoading: false,
          authError: undefined,
          error: undefined,
        })
        if (account) {
          for (const other of get().hosts) {
            if (other.id === hostId || other.mode !== 'relay' || other.relayUrl !== account.centerUrl) continue
            deps.patchRuntime(other.id, { profiles, profilesLoaded: true, profilesLoading: false })
          }
        }
      } catch (err) {
        if (!getHost(hostId)) return
        const auth = err instanceof ApiError && (err.status === 401 || err.status === 403)
        deps.patchRuntime(hostId, {
          profilesLoading: false,
          error: err instanceof Error ? err.message : '获取账号列表失败',
          authError: auth ? (err instanceof Error ? err.message : '认证失败') : undefined,
        })
      }
    },

    refreshCommands: async (hostId) => {
      const host = getHost(hostId)
      if (!host) return []
      const state = get()
      // 项目级命令/技能随会话 cwd 变化；非活动 Host 没有 cwd 时只拉用户级
      const cwd = state.active?.hostId === hostId ? state.active?.summary?.cwd : undefined
      const rt = state.runtimes[hostId]
      if (rt?.commandsLoaded && rt.commandsCwd === cwd) return rt.commands
      const key = `${hostId}:${cwd ?? ''}`
      if (commandsInFlight.has(key)) return rt?.commands ?? []
      commandsInFlight.add(key)
      try {
        const commands = await api.commands(host, cwd)
        commandsInFlight.delete(key)
        if (!getHost(hostId)) return commands
        deps.patchRuntime(hostId, { commands, commandsLoaded: true, commandsCwd: cwd })
        return commands
      } catch {
        commandsInFlight.delete(key)
        return []
      }
    },

    refreshExternalSessions: async (hostId, force = false) => {
      const host = getHost(hostId)
      const rt = get().runtimes[hostId]
      if (!host || !rt) return []
      if (rt.externalLoading) return rt.externalSessions
      if (rt.externalLoaded && !force) return rt.externalSessions
      deps.patchRuntime(hostId, { externalLoading: true, externalError: undefined })
      try {
        const list = (await api.externalSessions(host)).map((item) => ({
          ...item,
          hostId,
        }))
        if (!getHost(hostId)) return list
        deps.setExternalSessions(hostId, () => list)
        deps.patchRuntime(hostId, {
          externalLoaded: true,
          externalLoading: false,
          externalError: undefined,
        })
        return list
      } catch (err) {
        if (getHost(hostId)) {
          deps.patchRuntime(hostId, {
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
        deps.applySessionSummary(hostId, summary)
        deps.setExternalSessions(hostId, (list) =>
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
        deps.ensureConnection(h.id)
        void get().refreshProfiles(h.id)
        void get().refreshSessions(h.id)
      }
    },

    applyWorkstationLogin: (workstationUrl, result) => {
      const base = workstationUrl.trim().replace(/\/+$/, '')
      const session: AccountSession = {
        centerUrl: base,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        accessExpiresAt: result.accessExpiresAt,
        refreshExpiresAt: result.refreshExpiresAt,
        account: result.account,
        workspace: result.workspace,
      }
      saveAccountSession(session)
      saveLastWorkstationUrl(base)
      const next = [...get().hosts]
      const added: HostConfig[] = []
      const seen = new Set<string>()
      for (const remote of result.hosts) {
        if (!remote.fingerprint) continue
        seen.add(remote.id)
        const url = relayHostUrl(base, remote.id)
        const existing = next.find(
          (h) => h.mode === 'relay' && h.relayUrl === base && h.hostId === remote.id,
        )
        if (existing) {
          existing.token = result.accessToken
          existing.accountId = result.account.id
          existing.accountName = result.account.name
          existing.name = remote.name || existing.name
          existing.fingerprint = remote.fingerprint
          continue
        }
        const host: HostConfig = {
          id: newId(),
          name: remote.name || remote.id,
          url,
          token: result.accessToken,
          addedAt: Date.now(),
          mode: 'relay',
          relayUrl: base,
          hostId: remote.id,
          fingerprint: remote.fingerprint,
          accountId: result.account.id,
          accountName: result.account.name,
        }
        next.push(host)
        added.push(host)
      }
      // 账号下已不可见（撤销授权/移除）的主机同步移除，保留其它直连/本地主机。
      const cleaned = next.filter(
        (h) =>
          !(
            h.mode === 'relay' &&
            h.relayUrl === base &&
            h.accountId === result.account.id &&
            h.hostId &&
            !seen.has(h.hostId)
          ),
      )
      const activeHostId = cleaned.some((h) => h.id === get().activeHostId)
        ? get().activeHostId
        : (added[0]?.id ?? cleaned[0]?.id ?? null)
      set((state) => ({
        account: session,
        hosts: cleaned,
        activeHostId,
        runtimes: {
          ...state.runtimes,
          ...Object.fromEntries(added.map((h) => [h.id, freshRuntime()])),
        },
      }))
      saveHosts(cleaned)
      if (activeHostId) saveLastHost(activeHostId)
      for (const h of added) {
        deps.ensureConnection(h.id)
        void get().refreshProfiles(h.id)
        void get().refreshSessions(h.id)
      }
      toast(`已登录 ${session.account.name}（${session.workspace.name}）`, 'success')
    },

    workspaceLogin: async (input) => {
      const base = input.centerUrl.trim().replace(/\/+$/, '')
      const result = await workstationApi.login(base, {
        username: input.username.trim(),
        password: input.password,
        ...(input.totp?.trim() ? { totp: input.totp.trim() } : {}),
      })
      get().applyWorkstationLogin(base, result)
    },

    workspaceRegister: async (input) => {
      const base = input.workstationUrl.trim().replace(/\/+$/, '')
      const result = await workstationApi.register(base, {
        username: input.username.trim(),
        password: input.password,
        ...(input.inviteCode?.trim() ? { inviteCode: input.inviteCode.trim() } : {}),
      })
      get().applyWorkstationLogin(base, result)
    },

    syncWorkstationHosts: async () => {
      let session = get().account
      if (!session) return
      let remoteHosts: Awaited<ReturnType<typeof workstationApi.hosts>>
      try {
        remoteHosts = await workstationApi.hosts(session.centerUrl, session.accessToken)
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401) throw err
        // 授权变化可能作废旧令牌：刷新一次再重试，避免用户手动重登。
        if (!(await get().refreshWorkspace())) throw err
        session = get().account
        if (!session) throw err
        remoteHosts = await workstationApi.hosts(session.centerUrl, session.accessToken)
      }
      const current = get().hosts
      const added: HostConfig[] = []
      const seen = new Set<string>()
      let changed = false
      const next = [...current]
      for (const remote of remoteHosts) {
        if (!remote.fingerprint) continue
        seen.add(remote.id)
        const index = next.findIndex(
          (h) => h.mode === 'relay' && h.relayUrl === session.centerUrl && h.hostId === remote.id,
        )
        if (index >= 0) {
          const existing = next[index]!
          const name = remote.name || existing.name
          if (
            existing.token !== session.accessToken ||
            existing.fingerprint !== remote.fingerprint ||
            existing.name !== name
          ) {
            next[index] = { ...existing, token: session.accessToken, fingerprint: remote.fingerprint, name }
            changed = true
          }
          continue
        }
        const host: HostConfig = {
          id: newId(),
          name: remote.name || remote.id,
          url: relayHostUrl(session.centerUrl, remote.id),
          token: session.accessToken,
          addedAt: Date.now(),
          mode: 'relay',
          relayUrl: session.centerUrl,
          hostId: remote.id,
          fingerprint: remote.fingerprint,
          accountId: session.account.id,
          accountName: session.account.name,
        }
        next.push(host)
        added.push(host)
      }
      const cleaned = next.filter(
        (h) =>
          !(
            h.mode === 'relay' &&
            h.relayUrl === session.centerUrl &&
            h.accountId === session.account.id &&
            h.hostId &&
            !seen.has(h.hostId)
          ),
      )
      // 没有变化就不写状态：定时同步不能让依赖 hosts 的界面与路由逻辑反复重跑。
      if (changed || added.length > 0 || cleaned.length !== next.length) {
        set((state) => ({
          hosts: cleaned,
          runtimes: {
            ...state.runtimes,
            ...Object.fromEntries(added.map((h) => [h.id, freshRuntime()])),
          },
          activeHostId:
            state.activeHostId && cleaned.some((h) => h.id === state.activeHostId)
              ? state.activeHostId
              : (cleaned[0]?.id ?? null),
        }))
        saveHosts(cleaned)
        const activeId = get().activeHostId
        if (activeId) saveLastHost(activeId)
        for (const gone of next.filter((h) => !cleaned.includes(h))) {
          connections.get(gone.id)?.close()
          connections.delete(gone.id)
        }
        for (const h of added) {
          deps.ensureConnection(h.id)
          void get().refreshProfiles(h.id)
          void get().refreshSessions(h.id)
        }
      }
      // 新获授权的主机需要新 perHost 声明，主动换一次访问令牌再连接。
      if (added.length > 0) await get().refreshWorkspace()
    },

    workspaceLogout: async () => {
      const session = get().account
      if (__TANDEM_DEBUG__ && session?.account.debug) {
        // 退出调试账号后记住选择，避免下次启动又被自动登录。
        void import('../../lib/debugAccount').then((mod) => mod.disableDebugAutoLogin())
      }
      if (session) {
        saveLastWorkstationUrl(session.centerUrl)
        await workstationApi.logout(session.centerUrl, session.refreshToken)
      }
      clearAccountState(session?.account.id)
      toast('已退出工作区账号', 'success')
    },

    refreshWorkspace: async () => {
      const session = get().account
      if (!session) return false
      try {
        const tokens = await workstationApi.refresh(session.centerUrl, session.refreshToken)
        const next: AccountSession = {
          ...session,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessExpiresAt: tokens.accessExpiresAt,
          refreshExpiresAt: tokens.refreshExpiresAt,
        }
        saveAccountSession(next)
        const hosts = get().hosts.map((h) =>
          h.accountId === session.account.id ? { ...h, token: tokens.accessToken } : h,
        )
        set({ account: next, hosts })
        saveHosts(hosts)
        return true
      } catch (err) {
        // 刷新令牌被工作站拒绝（过期 / 账号被禁用）：会话已失效，回到登录页。
        if (loginGateEnabled() && err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          saveLastWorkstationUrl(session.centerUrl)
          clearAccountState(session.account.id)
        }
        return false
      }
    },
  }
}
