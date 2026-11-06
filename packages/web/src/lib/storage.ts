import type { HostConfig, Theme } from './types'

const KEYS = {
  hosts: 'tandem.hosts.v1',
  theme: 'tandem.theme.v1',
  ui: 'tandem.ui.v1',
  recentDirs: 'tandem.recentDirs.v1',
  lastHost: 'tandem.lastHost.v1',
} as const

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级为仅内存状态
  }
}

/** 过滤掉结构不完整的 Host（也用于导入配置时的输入校验）。 */
export function sanitizeHosts(input: unknown): HostConfig[] {
  if (!Array.isArray(input)) return []
  return input
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
    }))
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
  collapsedProjects?: string[]
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

export function loadRecentDirs(hostId: string): string[] {
  const map = readJson<Record<string, string[]>>(KEYS.recentDirs, {})
  return Array.isArray(map[hostId]) ? map[hostId].slice(0, 8) : []
}

export function rememberDir(hostId: string, dir: string): void {
  if (!dir) return
  const map = readJson<Record<string, string[]>>(KEYS.recentDirs, {})
  const next = [dir, ...(map[hostId] ?? []).filter((d) => d !== dir)].slice(0, 8)
  map[hostId] = next
  writeJson(KEYS.recentDirs, map)
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
