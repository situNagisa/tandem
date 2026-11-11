import type { AccountSession, HostConfig, SplitState, Theme } from './types'
import { isValidFingerprint, normalizeFingerprint } from './relay'
import { sanitizeSplitState } from './split'

const KEYS = {
  hosts: 'tandem.hosts.v1',
  theme: 'tandem.theme.v1',
  ui: 'tandem.ui.v1',
  recentDirs: 'tandem.recentDirs.v1',
  lastHost: 'tandem.lastHost.v1',
  drafts: 'tandem.drafts.v1',
  sentHistory: 'tandem.sentHistory.v1',
  migrations: 'tandem.migrations.v1',
  split: 'tandem.split.v1',
  account: 'tandem.account.v1',
} as const

/** 原始字符串读写：localStorage 不可用（隐私模式等）时静默降级为无持久化。 */
export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 忽略 */
  }
}

export function removeRaw(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* 忽略 */
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readRaw(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级为仅内存状态
  }
}

/** 会话级存储（如本次会话的错误缓冲），关闭标签页即清空。 */
export function readSessionRaw(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeSessionRaw(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* 隐私模式或配额不足时只保留内存副本 */
  }
}

/** 过滤掉结构不完整的 Host（也用于导入配置时的输入校验）。 */
export function sanitizeHosts(input: unknown): HostConfig[] {
  if (!Array.isArray(input)) return []
  return input
    // 旧版 SSH 远程接入（2026-11-10 删除）留下的条目直接忽略，不迁移。
    .filter((h) => !(h && typeof h === 'object' && (h as { mode?: unknown }).mode === 'ssh'))
    .filter(
      (h): h is HostConfig =>
        !!h &&
        typeof h === 'object' &&
        typeof (h as HostConfig).id === 'string' &&
        typeof (h as HostConfig).url === 'string' &&
        typeof (h as HostConfig).token === 'string',
    )
    .map((h) => ({
      id: h.id,
      name: typeof h.name === 'string' ? h.name : h.url,
      url: h.url,
      token: h.token,
      addedAt: typeof h.addedAt === 'number' ? h.addedAt : Date.now(),
      ...(typeof h.accountId === 'string' ? { accountId: h.accountId } : {}),
      ...(typeof h.accountName === 'string' ? { accountName: h.accountName } : {}),
      ...(h.mode === 'relay'
        ? {
            mode: 'relay' as const,
            relayUrl: typeof h.relayUrl === 'string' ? h.relayUrl.replace(/\/+$/, '') : '',
            hostId: typeof h.hostId === 'string' ? h.hostId : '',
            fingerprint: typeof h.fingerprint === 'string' ? normalizeFingerprint(h.fingerprint) : '',
          }
        : { mode: 'direct' as const }),
    }))
    // 加密隧道 Host 没有有效指纹就无法保证端到端加密，宁可不加载。
    .filter((h) => h.mode !== 'relay' || (!!h.relayUrl && !!h.hostId && isValidFingerprint(h.fingerprint)))
}

export function loadHosts(): HostConfig[] {
  return sanitizeHosts(readJson<unknown>(KEYS.hosts, []))
}

export function saveHosts(hosts: HostConfig[]): void {
  writeJson(KEYS.hosts, hosts)
}

export function loadTheme(): Theme {
  const t = localStorage.getItem(KEYS.theme)
  return t === 'light' || t === 'dark' || t === 'system' ? t : 'system'
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEYS.theme, theme)
  } catch {
    /* 忽略 */
  }
}

export interface UiPrefs {
  sidebarCollapsed?: boolean
  panelOpen?: boolean
  sidebarWidth?: number
  changesWidth?: number
  filePreviewWidth?: number
  /** 应用预览侧面板宽度。 */
  previewWidth?: number
  collapsedProjects?: string[]
  notifications?: boolean
  /** App 内本地通知（安卓本地通知，不经推送服务）。 */
  nativeNotifications?: boolean
  /** 安卓前台服务：App 退到后台后继续保持 WS 连接。 */
  backgroundService?: boolean
  /** 收件箱要提醒的事件类型。 */
  notifyEvents?: { permission?: boolean; turnEnd?: boolean; error?: boolean; budget?: boolean }
  showSubagents?: boolean
  showExternalSessions?: boolean
  /** 侧栏筛选里被关掉的来源（claude-code / codex）。 */
  hiddenExternalSources?: string[]
  /** 固定在侧栏顶部的项目分组 key（`${hostId}:${项目名}`）。 */
  pinnedProjects?: string[]
  /** 文件预览里的文件浏览器：是否展开、树宽。 */
  fileBrowserVisible?: boolean
  fileBrowserWidth?: number
}

/** 随配置迁移打包的客户端设置：Host 列表、主题、侧栏偏好等 localStorage 内容。 */
export interface ClientSettingsBundle {
  hosts?: HostConfig[]
  theme?: Theme
  ui?: UiPrefs
  recentDirs?: Record<string, string[]>
  lastHost?: string | null
}

export function loadUiPrefs(): UiPrefs {
  return readJson<UiPrefs>(KEYS.ui, {})
}

export function saveUiPrefs(prefs: UiPrefs): void {
  writeJson(KEYS.ui, { ...loadUiPrefs(), ...prefs })
}

export function loadSidebarWidth(): number {
  const n = loadUiPrefs().sidebarWidth
  if (typeof n !== 'number' || !Number.isFinite(n)) return 272
  return Math.min(400, Math.max(220, n))
}

export function saveSidebarWidth(width: number): void {
  saveUiPrefs({ sidebarWidth: width })
}

/** 多会话分屏：打开了哪些会话、布局与分隔条比例。 */
export function loadSplitState(): SplitState | null {
  return sanitizeSplitState(readJson<unknown>(KEYS.split, null))
}

export function saveSplitState(state: SplitState | null): void {
  try {
    if (!state || state.panes.length < 2) localStorage.removeItem(KEYS.split)
    else localStorage.setItem(KEYS.split, JSON.stringify(state))
  } catch {
    // localStorage 不可用时只影响刷新恢复
  }
}

export function loadCollapsedProjects(): Record<string, boolean> {
  const list = loadUiPrefs().collapsedProjects
  if (!Array.isArray(list)) return {}
  const map: Record<string, boolean> = {}
  for (const key of list) if (typeof key === 'string') map[key] = true
  return map
}

export function saveCollapsedProjects(map: Record<string, boolean>): void {
  saveUiPrefs({ collapsedProjects: Object.keys(map).filter((k) => map[k]) })
}

export function loadPinnedProjects(): string[] {
  const list = loadUiPrefs().pinnedProjects
  return Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string') : []
}

export function savePinnedProjects(list: string[]): void {
  saveUiPrefs({ pinnedProjects: [...new Set(list)] })
}

export function loadRecentDirs(hostId: string): string[] {
  const map = readJson<Record<string, string[]>>(KEYS.recentDirs, {})
  return Array.isArray(map[hostId]) ? map[hostId].slice(0, 8) : []
}

/** 输入框草稿：按会话保存，切换会话后恢复。 */
export function loadDraft(sessionKey: string): string {
  const map = readJson<Record<string, string>>(KEYS.drafts, {})
  return typeof map[sessionKey] === 'string' ? map[sessionKey] : ''
}

export function saveDraft(sessionKey: string, text: string): void {
  const map = readJson<Record<string, string>>(KEYS.drafts, {})
  if (text) map[sessionKey] = text
  else delete map[sessionKey]
  writeJson(KEYS.drafts, map)
}

/** 每个会话最近发送的原文，供输入框空内容时按 ↑ 调出。 */
export function loadSentHistory(sessionKey: string): string[] {
  const map = readJson<Record<string, string[]>>(KEYS.sentHistory, {})
  const list = map[sessionKey]
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
}

export function pushSentHistory(sessionKey: string, text: string): void {
  if (!text) return
  const map = readJson<Record<string, string[]>>(KEYS.sentHistory, {})
  const list = [text, ...(map[sessionKey] ?? []).filter((x) => x !== text)].slice(0, 20)
  map[sessionKey] = list
  writeJson(KEYS.sentHistory, map)
}

export function rememberDir(hostId: string, dir: string): void {
  if (!dir) return
  const map = readJson<Record<string, string[]>>(KEYS.recentDirs, {})
  const next = [dir, ...(map[hostId] ?? []).filter((d) => d !== dir)].slice(0, 8)
  map[hostId] = next
  writeJson(KEYS.recentDirs, map)
}

/** 跨 Host 迁移后，在原会话上留一条本机标记（Host 端记录已复制到目标 Host）。 */
export function rememberMigration(hostId: string, sessionId: string, targetName: string): void {
  const map = readJson<Record<string, string>>(KEYS.migrations, {})
  map[`${hostId}:${sessionId}`] = targetName
  writeJson(KEYS.migrations, map)
}

export function loadMigration(hostId: string, sessionId: string): string | undefined {
  const map = readJson<Record<string, string>>(KEYS.migrations, {})
  const value = map[`${hostId}:${sessionId}`]
  return typeof value === 'string' && value ? value : undefined
}

export function loadLastHost(): string | null {
  try {
    return localStorage.getItem(KEYS.lastHost)
  } catch {
    return null
  }
}

export function saveLastHost(hostId: string): void {
  try {
    localStorage.setItem(KEYS.lastHost, hostId)
  } catch {
    /* 忽略 */
  }
}

export function readRecentDirsMap(): Record<string, string[]> {
  const map = readJson<Record<string, string[]>>(KEYS.recentDirs, {})
  if (!map || typeof map !== 'object') return {}
  const out: Record<string, string[]> = {}
  for (const [hostId, dirs] of Object.entries(map)) {
    if (Array.isArray(dirs)) {
      out[hostId] = dirs.filter((d): d is string => typeof d === 'string').slice(0, 8)
    }
  }
  return out
}

export function saveRecentDirsMap(map: Record<string, string[]>): void {
  writeJson(KEYS.recentDirs, map)
}

/** 收集将要随 ConfigBundle 打包的客户端设置。 */
export function collectClientSettings(): ClientSettingsBundle {
  return {
    hosts: loadHosts(),
    theme: loadTheme(),
    ui: loadUiPrefs(),
    recentDirs: readRecentDirsMap(),
    lastHost: loadLastHost(),
  }
}

export function loadAccountSession(): AccountSession | null {
  const raw = readJson<AccountSession | null>(KEYS.account, null)
  if (!raw || typeof raw !== 'object' || !raw.accessToken || !raw.account || !raw.centerUrl) return null
  return raw
}

export function saveAccountSession(session: AccountSession | null): void {
  writeJson(KEYS.account, session)
}

/** 上次登录的工作站地址：登录页预填，令牌过期或退出后重新登录不用再找地址。 */
export function loadLastWorkstationUrl(): string {
  try {
    return localStorage.getItem('tandem.workstation.lastUrl.v1') ?? ''
  } catch {
    return ''
  }
}

export function saveLastWorkstationUrl(url: string): void {
  try {
    localStorage.setItem('tandem.workstation.lastUrl.v1', url)
  } catch {
    /* 忽略 */
  }
}
