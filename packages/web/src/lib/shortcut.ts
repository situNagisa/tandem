import { modLabel } from './format'

/** 快捷键规格：mod 表示平台主键（macOS ⌘ / 其他 Ctrl），其余按字面。 */
export interface KeySpec {
  mod: boolean
  alt: boolean
  shift: boolean
  key: string
}

const RESERVED = new Set([
  'mod+c',
  'mod+v',
  'mod+x',
  'mod+a',
  'mod+z',
  'mod+shift+z',
  'mod+y',
  'mod+k',
])

const ORDER = ['mod', 'alt', 'shift'] as const

export function parseShortcut(spec: string): KeySpec | null {
  if (!spec) return null
  const parts = spec.toLowerCase().split('+').filter(Boolean)
  const key = parts.pop()
  if (!key) return null
  return {
    mod: parts.includes('mod'),
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    key,
  }
}

export function formatShortcut(spec: string): string {
  const parsed = parseShortcut(spec)
  if (!parsed) return ''
  const parts: string[] = []
  if (parsed.mod) parts.push(modLabel)
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key)
  return parts.join(' + ')
}

export function matchShortcut(event: KeyboardEvent, spec: string): boolean {
  const parsed = parseShortcut(spec)
  if (!parsed) return false
  const primary = event.metaKey || event.ctrlKey
  if (parsed.mod !== primary) return false
  if (parsed.alt !== event.altKey) return false
  if (parsed.shift !== event.shiftKey) return false
  return event.key.toLowerCase() === parsed.key
}

/** 把 keydown 转成规格；不合法（无修饰键、单独修饰键、系统保留组合）返回 null。 */
export function shortcutFromEvent(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase()
  if (!key || key === 'control' || key === 'meta' || key === 'shift' || key === 'alt') return null
  if (!/^[a-z0-9]$/.test(key) && !/^f([1-9]|1[0-2])$/.test(key)) return null
  if (!event.metaKey && !event.ctrlKey) return null
  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push('mod')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  parts.push(key)
  const spec = parts.join('+')
  return RESERVED.has(spec) ? null : spec
}

export function shortcutOrder(spec: string): number {
  const parsed = parseShortcut(spec)
  if (!parsed) return ORDER.length
  return ORDER.filter((part) => parsed[part]).length
}
