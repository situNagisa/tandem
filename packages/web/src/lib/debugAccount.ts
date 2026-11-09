// 调试版专用：本机工作站测试账号的自动登录与开关。
// 只在 __TANDEM_DEBUG__ 分支里动态加载，发布构建不会包含这些标识。
import type { AccountLoginResult } from '@tandem/protocol'
import { workstationApi } from './api'
import { useAppStore } from '../store/useAppStore'
import { loadLocalHosts } from './localHosts'

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

/** 本机调试工作站的候选地址：本机 Host 内嵌的工作站优先；页面本身是工作站时用页面地址。 */
export async function localDebugWorkstationUrls(): Promise<string[]> {
  const origin = window.location.origin
  const urls: string[] = []
  const controls = loadLocalHosts().filter((h) => isLoopbackUrl(h.url))
  for (const host of controls) {
    try {
      const local = await workstationApi.localStatus(host)
      if (local.embedded.running) urls.push(...local.embedded.urls.filter(isLoopbackUrl))
      if (local.join?.url && isLoopbackUrl(local.join.url)) urls.push(local.join.url)
    } catch {
      /* 令牌失效或 Host 没起来 */
    }
  }
  // 页面本身就是工作站（http://127.0.0.1:8481）；页面由 Host 托管时不探测，避免 401 控制台噪声。
  if (isLoopbackUrl(origin) && !controls.some((h) => baseUrl(h.url) === origin)) urls.push(origin)
  return [...new Set(urls.map(baseUrl))]
}

/**
 * 调试版：页面在本机回环地址上打开时，自动登录本机工作站的调试账号。
 * Host 刚启动时内嵌工作站可能还没就绪，短时间重试。
 */
export async function tryDebugLocalAutoLogin(): Promise<boolean> {
  if (!isDebugAutoLoginEnabled()) return false
  if (useAppStore.getState().account) return false
  if (!isLoopbackUrl(window.location.origin)) return false
  const deadline = Date.now() + 8000
  for (;;) {
    for (const url of await localDebugWorkstationUrls()) {
      if (await debugLoginAt(url)) return true
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
}
