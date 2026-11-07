/** 邀请链接：http://<host>:<port>/#invite=<一次性邀请码>。 */
export interface InviteTarget {
  baseUrl: string
  code: string
}

export function parseInviteLink(raw: string): InviteTarget | null {
  const text = raw.trim()
  if (!text) return null
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `http://${text}`)
  } catch {
    return null
  }
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''))
  const code = hash.get('invite') ?? u.searchParams.get('invite')
  if (!code) return null
  u.searchParams.delete('invite')
  u.hash = ''
  return { baseUrl: (u.origin + u.pathname).replace(/\/+$/, ''), code }
}

/** 当前页面地址里是否带邀请码（同事直接打开邀请链接）。 */
export function inviteFromLocation(): InviteTarget | null {
  if (typeof window === 'undefined') return null
  return parseInviteLink(window.location.href)
}
