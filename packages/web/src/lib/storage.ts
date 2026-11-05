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

export function loadHosts(): HostConfig[] {
  const list = readJson<HostConfig[]>(KEYS.hosts, [])
  if (!Array.isArray(list)) return []
  return list.filter(
    (h) => h && typeof h.id === 'string' && typeof h.url === 'string' && typeof h.token === 'string',
  )
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

interface UiPrefs {
  sidebarCollapsed?: boolean
  panelOpen?: boolean
}

export function loadUiPrefs(): UiPrefs {
  return readJson<UiPrefs>(KEYS.ui, {})
}

export function saveUiPrefs(prefs: UiPrefs): void {
  writeJson(KEYS.ui, { ...loadUiPrefs(), ...prefs })
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
