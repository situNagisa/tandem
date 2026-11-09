// 本机 Host 凭据（地址 + 主 token）。登录门开启时它们不进入工作台的主机列表，
// 只用于本机管理：「添加这台电脑」、启动本机内嵌工作站、调试版自动登录。
import type { HostConfig } from './types'
import { readJson, sanitizeHosts, writeJson } from './storage'

const KEY = 'tandem.localhosts.v1'

export function loadLocalHosts(): HostConfig[] {
  return sanitizeHosts(readJson<unknown>(KEY, []))
}

export function saveLocalHosts(list: HostConfig[]): void {
  writeJson(KEY, list)
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** 按地址 origin 合并写入（同一个 Host 只保留最新 token）。 */
export function stashLocalHosts(incoming: HostConfig[]): HostConfig[] {
  if (incoming.length === 0) return loadLocalHosts()
  const next = loadLocalHosts()
  for (const host of incoming) {
    const index = next.findIndex((h) => originOf(h.url) === originOf(host.url))
    if (index >= 0) next[index] = { ...next[index]!, ...host, id: next[index]!.id }
    else next.push(host)
  }
  saveLocalHosts(next)
  return next
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '')
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}

/** 当前页面所在 Host 的凭据（页面由该 Host 托管并带 ?token= 打开过）；没有则返回 undefined。 */
export function findLocalControl(origin: string = window.location.origin): HostConfig | undefined {
  return loadLocalHosts().find((h) => (h.mode ?? 'direct') === 'direct' && originOf(h.url) === origin)
}

/** 页面是否在本机回环地址上打开：此时页面所在 Host 就是「这台电脑」。 */
export function pageIsLoopback(): boolean {
  try {
    return isLoopbackHostname(window.location.hostname)
  } catch {
    return false
  }
}
