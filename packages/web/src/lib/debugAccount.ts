// 调试版专用：本机工作站测试账号的自动登录与开关。
// 只在 __TANDEM_DEBUG__ 分支里动态加载，发布构建不会包含这些标识。
import type { AccountLoginResult } from '@tandem/protocol'
import { workstationApi } from './api'
import { useAppStore } from '../store/useAppStore'

const AUTOLOGIN_KEY = 'tandem.debug.account.autologin'

export function isDebugAutoLoginEnabled(): boolean {
  try {
    return localStorage.getItem(AUTOLOGIN_KEY) !== '0'
  } catch {
    return true
  }
}

export function setDebugAutoLoginEnabled(on: boolean): void {
  try {
    localStorage.setItem(AUTOLOGIN_KEY, on ? '1' : '0')
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 退出调试账号后记住选择：之后打开不再自动登录。 */
export function disableDebugAutoLogin(): void {
  setDebugAutoLoginEnabled(false)
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw.trim()).hostname.replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

function baseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

/** 只有「调试版工作站 + 客户端在回环」才提供入口。 */
export async function probeDebugWorkstation(raw: string): Promise<boolean> {
  const base = baseUrl(raw)
  if (!base || !isLoopbackUrl(base)) return false
  try {
    const status = await workstationApi.publicStatus(base)
    return !!status.debug && status.initialized
  } catch {
    return false
  }
}

/** 用调试账号登录指定工作站；失败返回 false，不抛错。 */
export async function debugLoginAt(raw: string): Promise<boolean> {
  const base = baseUrl(raw)
  if (!(await probeDebugWorkstation(base))) return false
  try {
    const res = await fetch(`${base}/api/debug/auto-login`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return false
    const result = (await res.json()) as AccountLoginResult
    if (!result?.accessToken || !result.account) return false
    useAppStore.getState().applyWorkstationLogin(base, result)
    return true
  } catch {
    return false
  }
}

/** 调试版启动时：连接本机工作站且未登录则自动登录。 */
export async function tryDebugLocalAutoLogin(): Promise<boolean> {
  if (!isDebugAutoLoginEnabled()) return false
  const store = useAppStore.getState()
  if (store.account) return false

  const host = store.hosts.find((h) => h.id === store.activeHostId) ?? store.hosts[0]
  if (host) {
    try {
      const local = await workstationApi.localStatus(host)
      const embedded = local.embedded.urls.find(isLoopbackUrl)
      if (local.embedded.running && embedded && (await debugLoginAt(embedded))) return true
      if (local.join?.url && isLoopbackUrl(local.join.url) && (await debugLoginAt(local.join.url))) return true
    } catch {
      /* 不是 Host 页面或令牌不可用 */
    }
  }
  // 直接打开工作站页面（例如 http://127.0.0.1:8481）时，回环源本身也可能是调试工作站。
  // 若当前源就是 Host 页面，则不要探测：Host 没有工作站状态接口，会留下 401 控制台错误。
  const origin = window.location.origin
  let hostIsOrigin = false
  if (host) {
    try {
      hostIsOrigin = new URL(host.url).origin === origin
    } catch {
      hostIsOrigin = false
    }
  }
  if (!hostIsOrigin && isLoopbackUrl(origin) && (await debugLoginAt(origin))) return true
  return false
}
