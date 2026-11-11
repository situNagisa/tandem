import type { HostConfig } from './types'

export function isRelayHost(host: Pick<HostConfig, 'mode'>): boolean {
  return host.mode === 'relay'
}

/** 指纹统一成 64 位小写十六进制；支持带冒号 / sha256: 前缀的粘贴。 */
export function normalizeFingerprint(text: string): string {
  return text.toLowerCase().replace(/^sha256:/, '').replace(/[^0-9a-f]/g, '')
}

export function isValidFingerprint(text: string): boolean {
  return /^[0-9a-f]{64}$/.test(normalizeFingerprint(text))
}

/** 工作站上的主机根地址：<工作站地址>/h/<hostId> */
export function relayHostUrl(relayUrl: string, hostId: string): string {
  return `${relayUrl.replace(/\/+$/, '')}/h/${hostId}`
}

/** 工作站返回 502（主机不在线）时的固定提示。 */
export const HOST_NOT_ON_WORKSTATION = '主机未连上工作站'

export function relayErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err || '未知错误')
  // 工作站找不到主机上下文时返回 502「主机不在线」；这不是本机网络问题，重连也不会好。
  if (/主机不在线|HTTP 502/.test(msg)) return HOST_NOT_ON_WORKSTATION
  return msg
}
