/** 把时间戳格式化为「今天 / 昨天 / 更早」分组，用于会话列表。 */
export function dayBucket(ts: number, now = Date.now()): '今天' | '昨天' | '更早' {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  if (ts >= today) return '今天'
  if (ts >= today - 86_400_000) return '昨天'
  return '更早'
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const v = n / 1000
    return `${v < 10 ? v.toFixed(1) : Math.round(v)}k`
  }
  return `${(n / 1_000_000).toFixed(2)}m`
}

export function formatCost(usd?: number): string {
  if (usd === undefined || !Number.isFinite(usd)) return '—'
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}

export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  if (diff < 45_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return sameYear
    ? `${d.getMonth() + 1} 月 ${d.getDate()} 日`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 更适合「基于 commit · 3 天前」的短相对时间（天级用 N 天前）。 */
export function formatAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  if (diff < 45_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.round(diff / 86_400_000)} 天前`
  return formatRelative(ts, now)
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 运行时长：32s / 1m 05s / 1h 02m。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

/** 消息耗时：12.3s；满 1 分钟用 1m 05s。 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0s'
  if (ms < 60_000) {
    const seconds = ms / 1000
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`
  }
  return formatElapsed(ms)
}

/** 兼容 Windows 与 POSIX 路径。 */
export function basename(path: string): string {
  if (!path) return ''
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed
}

export function dirname(path: string): string {
  if (!path) return ''
  const isWin = /^[a-zA-Z]:[\\/]/.test(path) || path.includes('\\')
  const sep = isWin ? '\\' : '/'
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (idx < 0) return ''
  const parent = trimmed.slice(0, idx)
  if (!parent) return sep
  if (/^[a-zA-Z]:$/.test(parent)) return parent + sep
  return parent
}

export function joinPath(base: string, name: string): string {
  if (!base) return name
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.replace(/[\\/]+$/, '') + sep + name
}

export function fileExt(path: string): string {
  const name = basename(path)
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : ''
}

/** 截断长字符串（按字符数），用于工具卡片摘要。 */
export function truncate(s: string, n = 72): string {
  if (!s) return ''
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}

export function firstLine(s: string, n = 80): string {
  return truncate((s ?? '').split('\n')[0] ?? '', n)
}

export function plural(n: number, unit: string): string {
  return `${n} ${unit}`
}

export const isMacPlatform =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)

export const modLabel = isMacPlatform ? '⌘' : 'Ctrl'
