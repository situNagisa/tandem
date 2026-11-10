// 调试版专用：本机工作站测试账号的自动登录与开关。
// 只在 __TANDEM_DEBUG__ 分支里动态加载，发布构建不会包含这些标识。
import type { AccountLoginResult, WorkstationPublicStatus } from '@tandem/protocol'
import { ApiError, workstationApi } from './api'
import { readRaw, writeRaw } from './storage'
import { useAppStore } from '../store/useAppStore'
import { loadLocalHosts } from './localHosts'

const AUTOLOGIN_KEY = 'tandem.debug.account.autologin'

export function isDebugAutoLoginEnabled(): boolean {
  return readRaw(AUTOLOGIN_KEY) !== '0'
}

export function setDebugAutoLoginEnabled(on: boolean): void {
  writeRaw(AUTOLOGIN_KEY, on ? '1' : '0')
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

type Probe =
  | { state: 'ok'; status: WorkstationPublicStatus }
  // 4xx 表示这个地址不是（调试版）工作站，例如 Host 首页没有工作站状态接口。
  | { state: 'denied' }
  | { state: 'unavailable' }

async function probeWorkstation(raw: string): Promise<Probe> {
  const base = baseUrl(raw)
  if (!base || !isLoopbackUrl(base)) return { state: 'denied' }
  try {
    return { state: 'ok', status: await workstationApi.publicStatus(base) }
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) return { state: 'denied' }
    return { state: 'unavailable' }
  }
}

/** 只有「调试版工作站 + 客户端在回环」才提供入口。 */
export async function probeDebugWorkstation(raw: string): Promise<boolean> {
  const probe = await probeWorkstation(raw)
  return probe.state === 'ok' && !!probe.status.debug && probe.status.initialized
}

/** 'denied' 不要重试（地址不是调试工作站）；'unavailable' 可能只是还没启动。 */
async function attemptDebugLogin(raw: string): Promise<'ok' | 'denied' | 'unavailable'> {
  const base = baseUrl(raw)
  const probe = await probeWorkstation(base)
  if (probe.state !== 'ok') return probe.state
  if (!probe.status.debug || !probe.status.initialized) return 'denied'
  try {
    const res = await fetch(`${base}/api/debug/auto-login`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return 'denied'
    const result = (await res.json()) as AccountLoginResult
    if (!result?.accessToken || !result.account) return 'denied'
    useAppStore.getState().applyWorkstationLogin(base, result)
    return 'ok'
  } catch {
    return 'unavailable'
  }
}

/** 用调试账号登录指定工作站；失败返回 false，不抛错。 */
export async function debugLoginAt(raw: string): Promise<boolean> {
  return (await attemptDebugLogin(raw)) === 'ok'
}

/** 本机调试工作站的候选地址：只来自本机 Host（内嵌/已加入的工作站）。 */
export async function localDebugWorkstationUrls(): Promise<string[]> {
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
  return [...new Set(urls.map(baseUrl))]
}

/**
 * 调试版：页面在本机回环地址上打开时，自动登录本机工作站的调试账号。
 * Host 刚启动时内嵌工作站可能还没就绪，短时间重试；明确不是工作站的地址（4xx）不重试。
 */
export async function tryDebugLocalAutoLogin(): Promise<boolean> {
  if (!isDebugAutoLoginEnabled()) return false
  if (useAppStore.getState().account) return false
  if (!isLoopbackUrl(window.location.origin)) return false
  const deadline = Date.now() + 8000
  let delay = 300
  let originTried = false
  for (;;) {
    let retry = false
    const urls = await localDebugWorkstationUrls()
    for (const url of urls) {
      const state = await attemptDebugLogin(url)
      if (state === 'ok') return true
      if (state === 'unavailable') retry = true
    }
    // 有本机凭据但还没拿到工作站地址：内嵌工作站可能刚启动，继续等。
    if (!urls.length && loadLocalHosts().some((h) => baseUrl(h.url) === window.location.origin)) retry = true
    // 页面本身就是工作站（http://127.0.0.1:8481）时才用当前源；页面由 Host 托管时
    // 它没有工作站状态接口，401 之后继续探测只会刷屏。
    if (!retry && !originTried) {
      originTried = true
      const state = await attemptDebugLogin(window.location.origin)
      if (state === 'ok') return true
      if (state === 'unavailable') retry = true
    }
    if (!retry || Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(Math.round(delay * 1.6), 1500)
  }
}
