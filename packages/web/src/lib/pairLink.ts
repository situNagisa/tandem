import type { RelayPairInfo } from '@tandem/protocol'
import { isValidFingerprint, normalizeFingerprint, relayHostUrl } from './relay'

/** 直连：http(s)://host/?token=...；中继：https://relay/h/<hostId>/#pair=<base64url json>。 */
export type PairTarget =
  | { kind: 'direct'; url: string; token: string }
  | {
      kind: 'relay'
      url: string
      relayUrl: string
      hostId: string
      token: string
      fingerprint: string
    }

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(text: string): string {
  const s = text.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''
  const bin = atob(s + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** 从 relay.pairInfo() 生成可被 Web / App 解析的配对链接。 */
export function buildRelayPairLink(relay: RelayPairInfo, token: string): string {
  const base = relay.url.replace(/\/+$/, '')
  const suffix = `/h/${relay.hostId}`
  const relayUrl = base.endsWith(suffix) ? base.slice(0, -suffix.length) : base
  const payload = {
    relayUrl,
    hostId: relay.hostId,
    token,
    fingerprint: relay.fingerprint,
  }
  return `${base}/#pair=${b64urlEncode(JSON.stringify(payload))}`
}

/** 返回 null 表示不是配对链接；格式错误时抛出可展示的中文错误。 */
export function parsePairLink(raw: string): PairTarget | null {
  const text = raw.trim()
  if (!text) return null
  let u: URL
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : 'http://' + text
    u = new URL(candidate)
  } catch {
    throw new Error('链接格式不正确')
  }

  const hash = new URLSearchParams(u.hash.replace(/^#/, ''))
  const encoded = hash.get('pair') ?? u.searchParams.get('pair')
  if (encoded) {
    let data: unknown
    try {
      data = JSON.parse(b64urlDecode(encoded))
    } catch {
      throw new Error('配对链接内容损坏，无法解析')
    }
    const obj = data as Partial<Record<'relayUrl' | 'hostId' | 'token' | 'fingerprint', unknown>>
    if (
      typeof obj.relayUrl !== 'string' ||
      typeof obj.hostId !== 'string' ||
      typeof obj.token !== 'string' ||
      typeof obj.fingerprint !== 'string'
    ) {
      throw new Error('配对链接缺少 relayUrl / hostId / token / fingerprint')
    }
    if (!/^https?:\/\//i.test(obj.relayUrl)) throw new Error('配对链接里的中继地址无效')
    if (!isValidFingerprint(obj.fingerprint)) {
      throw new Error('配对链接里的 Host 公钥指纹无效（应为 64 位十六进制）')
    }
    const relayUrl = obj.relayUrl.replace(/\/+$/, '')
    return {
      kind: 'relay',
      url: relayHostUrl(relayUrl, obj.hostId),
      relayUrl,
      hostId: obj.hostId,
      token: obj.token,
      fingerprint: normalizeFingerprint(obj.fingerprint),
    }
  }

  const token = u.searchParams.get('token') ?? ''
  u.searchParams.delete('token')
  u.hash = ''
  const url = (u.origin + u.pathname).replace(/\/+$/, '')
  return { kind: 'direct', url, token }
}
