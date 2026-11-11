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
  // 不足 0.0001 的金额按最小显示单位取整，四舍五入会变成 $0.0000，看起来像没算出来（反馈1601#03）。
  if (usd > 0 && usd < 0.00005) return '<$0.0001'
  if (usd <= 0) return '$0'
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}

/** 逐轮用量里的紧凑金额：0 显示 $0，去掉末尾多余的 0。 */
export function formatCostCompact(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  const digits = usd >= 1 ? 2 : usd >= 0.01 ? 3 : 4
  return `$${usd.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`
}

export interface ByteFormatOptions {
  /** 单位前是否留空格。默认 true（文件预览/记忆）；工具卡片不留空格。 */
  space?: boolean
  /** KB 是否取整。默认 false（保留一位小数）；工具卡片取整。 */
  roundKb?: boolean
  /** 最大单位。'kb' 时超过 1 MB 仍按 KB 显示。默认 'mb'。 */
  maxUnit?: 'kb' | 'mb'
}

/** 文件大小：B / KB / MB。各调用点用参数保留原有空格、小数位与最大单位。 */
export function formatBytes(bytes: number, options: ByteFormatOptions = {}): string {
  const { space = true, roundKb = false, maxUnit = 'mb' } = options
  const sep = space ? ' ' : ''
  if (maxUnit === 'mb' && bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)}${sep}MB`
  }
  if (bytes >= 1024) {
    const kb = roundKb ? Math.round(bytes / 1024) : (bytes / 1024).toFixed(1)
    return `${kb}${sep}KB`
  }
  return `${bytes}${sep}B`
}

/** 时长：'human' 用中文单位（看板），'compact' 用 ms/s/m（评测）。 */
export function formatDuration(ms: number | undefined, style: 'human' | 'compact' = 'human'): string {
  if (style === 'compact') {
    if (!ms || !Number.isFinite(ms) || ms <= 0) return '—'
    if (ms < 1000) return `${Math.round(ms)}ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
    const minutes = Math.floor(ms / 60_000)
    const seconds = Math.round((ms % 60_000) / 1000)
    return `${minutes}m${seconds.toString().padStart(2, '0')}s`
  }
  if (!ms || ms < 1000) return '<1 秒'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`
}

export interface DateTimeOptions {
  /** 带年份（分享管理）。 */
  year?: boolean
  /** 带秒（网关令牌）。 */
  second?: boolean
  /** 无时间戳时的占位，默认 '—'。 */
  empty?: string
}

/** 设置页日期时间：MM/DD HH:mm，可按调用点带年份或秒。 */
export function formatDateTime(ts: number | undefined, options: DateTimeOptions = {}): string {
  if (!ts) return options.empty ?? '—'
  return new Intl.DateTimeFormat('zh-CN', {
    ...(options.year ? { year: 'numeric' as const } : {}),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(options.second ? { second: '2-digit' as const } : {}),
  }).format(ts)
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

/**
 * 消息时间（反馈16#01）：6 小时内用相对时间（刚刚 / x 分钟前 / x 小时前），
 * 今天更早 HH:mm，非今天 MM-DD HH:mm，跨年带年份。
 */
export function formatMessageTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  if (diff < 45_000) return '刚刚'
  if (diff < 6 * 3_600_000) {
    const minutes = Math.round(diff / 60_000)
    return minutes < 60 ? `${minutes} 分钟前` : `${Math.round(diff / 3_600_000)} 小时前`
  }
  const d = new Date(ts)
  const n = new Date(now)
  const time = formatTime(ts)
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  if (sameDay) return time
  const date = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (d.getFullYear() !== n.getFullYear()) return `${d.getFullYear()}-${date} ${time}`
  return `${date} ${time}`
}

/** 完整日期时间，用于消息时间悬停提示。 */
export function formatFullTime(ts: number): string {
  const d = new Date(ts)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${date} ${formatTime(ts)}:${String(d.getSeconds()).padStart(2, '0')}`
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
