import type { RoutePreference } from '@tandem/protocol'
import { api } from './api'
import type { HostConfig } from './types'

/** 全局取向默认（设置 → 模型路由的 preference）；按 Host 缓存并通知已挂载的输入框。 */
const cache = new Map<string, RoutePreference>()
const listeners = new Set<() => void>()

export function cachedRouteBias(hostId: string): RoutePreference | undefined {
  return cache.get(hostId)
}

export function rememberRouteBias(hostId: string, bias: RoutePreference): void {
  cache.set(hostId, bias)
  for (const listener of listeners) listener()
}

export function subscribeRouteBias(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function loadRouteBias(host: HostConfig): Promise<RoutePreference> {
  const cached = cache.get(host.id)
  if (cached) return Promise.resolve(cached)
  return api.settings(host).then((settings) => {
    const preference = settings.modelRouting?.preference ?? 'balanced'
    rememberRouteBias(host.id, preference)
    return preference
  })
}
