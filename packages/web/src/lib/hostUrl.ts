/** 归一化用户输入的 Host 地址：补协议、去尾部斜杠、去 query/hash。 */
export function normalizeHostUrl(input: string): string {
  let s = input.trim()
  if (!s) throw new Error('Host 地址不能为空')
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  const u = new URL(s)
  u.hash = ''
  u.search = ''
  return (u.origin + u.pathname).replace(/\/+$/, '')
}

export function isSameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === window.location.origin
  } catch {
    return false
  }
}

/** 同源（例如开发环境经 Vite 代理）时使用相对路径；远程 Host 使用绝对地址。 */
export function requestBase(url: string): string {
  const base = normalizeHostUrl(url)
  if (isSameOrigin(base)) {
    const path = new URL(base).pathname.replace(/\/+$/, '')
    return path && path !== '/' ? path : ''
  }
  return base
}

export function websocketUrl(url: string, token: string): string {
  const base = normalizeHostUrl(url)
  const u = new URL(base)
  const proto = isSameOrigin(base)
    ? window.location.protocol === 'https:'
      ? 'wss:'
      : 'ws:'
    : u.protocol === 'https:'
      ? 'wss:'
      : 'ws:'
  const host = isSameOrigin(base) ? window.location.host : u.host
  const path = u.pathname.replace(/\/+$/, '')
  const prefix = path && path !== '/' ? path : ''
  return `${proto}//${host}${prefix}/ws?token=${encodeURIComponent(token)}`
}
