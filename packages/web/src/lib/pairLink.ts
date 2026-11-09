/** 直连：http(s)://host/?token=...。 */
export type PairTarget = { kind: 'direct'; url: string; token: string }

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
  if (hash.has('pair') || u.searchParams.has('pair')) {
    throw new Error('配对链接已失效，请直接用主机地址与 Token 添加')
  }

  const token = u.searchParams.get('token') ?? ''
  u.searchParams.delete('token')
  u.hash = ''
  const url = (u.origin + u.pathname).replace(/\/+$/, '')
  return { kind: 'direct', url, token }
}
