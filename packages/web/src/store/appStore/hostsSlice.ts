import type { SessionSummary } from '@tandem/protocol'
import type { StoreApi } from 'zustand'
import { api, ApiError } from '../../lib/api'
import { normalizeHostUrl } from '../../lib/hostUrl'
import { inviteFromLocation } from '../../lib/inviteLink'
import { isValidFingerprint, normalizeFingerprint, relayHostUrl } from '../../lib/relay'
import {
  loadHosts,
  loadLastHost,
  readRecentDirsMap,
  sanitizeHosts,
  saveCollapsedProjects,
  saveHosts,
  saveLastHost,
  saveRecentDirsMap,
} from '../../lib/storage'
import { navigate } from '../../lib/router'
import type { HostConnection } from '../../lib/ws'
import type { ExternalSessionItem, HostConfig, HostRuntime } from '../../lib/types'
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

export function createHostsSlice(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  deps: HostsSliceDeps,
): HostsSlice {
  const getHost = (id: string): HostConfig | undefined => get().hosts.find((h) => h.id === id)

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
        const profiles = await api.profiles(host)
        if (!getHost(hostId)) return
        deps.patchRuntime(hostId, {
          profiles,
          profilesLoaded: true,
          profilesLoading: false,
          authError: undefined,
          error: undefined,
        })
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
  }
}
