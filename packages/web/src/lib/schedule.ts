/** 定时任务 cron 的人类可读描述与常用预设（仅展示；调度以 Host 为准）。 */

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

const pad = (n: number): string => String(n).padStart(2, '0')

function timeLabel(hour: string, minute: string): string {
  return `${pad(Number(hour))}:${pad(Number(minute))}`
}

/** 解析简单 5 段表达式，返回中文描述；复杂表达式原样回退。 */
export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/).filter(Boolean)
  if (fields.length !== 5) {
    return fields.length < 5 ? '无法识别的 cron 表达式' : expr
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string]
  if (month !== '*' || dom !== '*') {
    if (dom !== '*' && month === '*' && dow === '*' && /^\d+$/.test(dom) && /^\d+$/.test(hour) && /^\d+$/.test(minute)) {
      return `每月 ${Number(dom)} 日 ${timeLabel(hour, minute)}`
    }
    return expr
  }
  if (dow !== '*') {
    if (!/^\d+$/.test(hour) || !/^\d+$/.test(minute)) return expr
    const time = timeLabel(hour, minute)
    if (dow === '1-5') return `每个工作日 ${time}`
    if (dow === '0,6' || dow === '6,0') return `每个周末 ${time}`
    if (/^[0-7]$/.test(dow)) return `每周${WEEKDAYS[Number(dow) % 7]} ${time}`
    return expr
  }
  if (minute === '*' && hour === '*') return '每分钟'
  if (minute.startsWith('*/') && hour === '*') return `每 ${Number(minute.slice(2))} 分钟`
  if (hour === '*' && /^\d+$/.test(minute)) return `每小时第 ${Number(minute)} 分`
  if (/^\d+$/.test(hour) && /^\d+$/.test(minute)) return `每天 ${timeLabel(hour, minute)}`
  return expr
}

export const CRON_PRESETS = [
  { id: 'daily', label: '每天 09:00', cron: '0 9 * * *' },
  { id: 'weekdays', label: '每个工作日 09:00', cron: '0 9 * * 1-5' },
  { id: 'hourly', label: '每小时整点', cron: '0 * * * *' },
  { id: 'every10', label: '每 10 分钟', cron: '*/10 * * * *' },
  { id: 'custom', label: '自定义', cron: '' },
] as const

export function presetFor(cron: string): string {
  return CRON_PRESETS.find((preset) => preset.cron === cron)?.id ?? 'custom'
}

/** 下次运行：刚刚 / 3 分钟后 / 今天 09:00 / 明天 09:00 / 6 月 1 日 09:00。 */
export function formatNextRun(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '—'
  const diff = ts - now
  if (diff <= 0) return '即将运行'
  if (diff < 60_000) return '不到 1 分钟后'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟后`
  const date = new Date(ts)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const today = new Date(now)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  if (sameDay) return `今天 ${time}`
  const tomorrow = new Date(now)
  tomorrow.setDate(today.getDate() + 1)
  if (
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate()
  ) {
    return `明天 ${time}`
  }
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`
}

export function formatRunAt(ts: number): string {
  const date = new Date(ts)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
