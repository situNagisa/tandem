import { useEffect, useState } from 'react'
import { E2EChannel } from '@tandem/protocol/e2e'
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

/** E2E 主机的隧道根地址：<工作站地址>/h/<hostId> */
export function relayHostUrl(relayUrl: string, hostId: string): string {
  return `${relayUrl.replace(/\/+$/, '')}/h/${hostId}`
}

const channels = new Map<string, E2EChannel>()

/** 每台 Host 复用一个 E2E 会话（握手有成本，WS 与 REST 可共用）。 */
export function relayChannel(host: HostConfig): E2EChannel {
  if (!host.fingerprint) throw new Error('缺少 Host 公钥指纹，无法建立加密连接')
  const key = `${host.url}|${normalizeFingerprint(host.fingerprint)}`
  let channel = channels.get(key)
  if (!channel) {
    channel = new E2EChannel({ baseUrl: host.url, fingerprint: host.fingerprint })
    channels.set(key, channel)
  }
  return channel
}

export function relayErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err || '未知错误')
  if (/指纹/.test(msg)) return `安全警告：${msg}`
  if (/^安全警告/.test(msg)) return msg
  return `端到端加密连接失败：${msg}`
}

let supportProbe: Promise<boolean> | null = null

/** 浏览器是否支持 E2E 所需的 WebCrypto X25519 / Ed25519。 */
export function detectRelayCryptoSupport(): Promise<boolean> {
  supportProbe ??= (async () => {
    try {
      const subtle = globalThis.crypto?.subtle
      if (!subtle) return false
      await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
      await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
      return true
    } catch {
      return false
    }
  })()
  return supportProbe
}

export const RELAY_UNSUPPORTED_MESSAGE =
  '当前浏览器不支持端到端加密连接。请升级到 Chrome 137+ / Firefox 129+ / Safari 17+，或使用桌面端。'

/** null 表示还在检测。 */
export function useRelayCryptoSupport(): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void detectRelayCryptoSupport().then((ok) => {
      if (alive) setSupported(ok)
    })
    return () => {
      alive = false
    }
  }, [])
  return supported
}
