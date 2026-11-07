import { useEffect, useState } from 'react'
import type { HostConfig } from './types'
import { api } from './api'

const MAX_CACHE = 60
const cache = new Map<string, string>()
const pending = new Map<string, Promise<string>>()
const order: string[] = []

function keyOf(host: HostConfig, sessionId: string, shotId: string): string {
  return `${host.id}:${sessionId}:${shotId}`
}

function store(key: string, url: string): string {
  cache.set(key, url)
  order.push(key)
  while (order.length > MAX_CACHE) {
    const oldest = order.shift()
    if (!oldest) break
    const old = cache.get(oldest)
    if (old) URL.revokeObjectURL(old)
    cache.delete(oldest)
  }
  return url
}

/** 通过带鉴权的 Host 请求取截图并转成 object URL（中继 Host 也能显示）。 */
export async function loadBrowserShot(
  host: HostConfig,
  sessionId: string,
  shotId: string,
): Promise<string> {
  const key = keyOf(host, sessionId, shotId)
  const cached = cache.get(key)
  if (cached) return cached
  const inflight = pending.get(key)
  if (inflight) return inflight
  const task = api
    .browserScreenshot(host, sessionId, shotId)
    .then((blob) => store(key, URL.createObjectURL(blob)))
    .finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}

/** 截图缩略图/面板共用：shotId 变化或 Host 切换时重新加载。 */
export function useBrowserShot(
  host: HostConfig | null | undefined,
  sessionId: string | null | undefined,
  shotId: string | null | undefined,
): { url: string | null; error: string | null } {
  const key = host && sessionId && shotId ? keyOf(host, sessionId, shotId) : ''
  const [state, setState] = useState<{ key: string; url: string | null; error: string | null }>(() => ({
    key: '',
    url: null,
    error: null,
  }))

  useEffect(() => {
    if (!host || !sessionId || !shotId) return
    let cancelled = false
    const cached = cache.get(key)
    if (cached) {
      setState({ key, url: cached, error: null })
      return
    }
    // Host 重启后截图只存在内存，请求可能长时间没有响应；超时后给出可读结论。
    const timer = window.setTimeout(() => {
      // 放弃这次挂起的请求，下一次「重新加载」会重新发起。
      pending.delete(key)
      if (!cancelled) setState({ key, url: null, error: '截图已失效（Host 可能已重启）' })
    }, 8000)
    loadBrowserShot(host, sessionId, shotId)
      .then((url) => {
        if (!cancelled) setState({ key, url, error: null })
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ key, url: null, error: err.message || '截图加载失败' })
      })
      .finally(() => window.clearTimeout(timer))
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [key, host?.id, sessionId, shotId])

  if (!key) return { url: null, error: null }
  return { url: state.key === key ? state.url : null, error: state.key === key ? state.error : null }
}
