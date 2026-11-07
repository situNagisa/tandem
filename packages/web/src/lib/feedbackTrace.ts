/** 反馈模式的操作轨迹：内存环形缓冲，记录最近 200 条可复现的操作。 */
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { cssSelectorFor, visibleTextSnippet } from './feedbackCapture'

export type FeedbackTraceKind = 'click' | 'key' | 'route' | 'ws' | 'toast'

export interface FeedbackTraceEntry {
  time: number
  kind: FeedbackTraceKind
  detail: string
}

const MAX_TRACE = 200
const entries: FeedbackTraceEntry[] = []
let installed = false

export function recordFeedbackTrace(kind: FeedbackTraceKind, detail: string): void {
  entries.push({ time: Date.now(), kind, detail: detail.replace(/\s+/g, ' ').trim().slice(0, 300) })
  if (entries.length > MAX_TRACE) entries.splice(0, entries.length - MAX_TRACE)
}

/** 反馈前 60 秒（默认）的操作轨迹。 */
export function getFeedbackTrace(windowMs = 60_000): FeedbackTraceEntry[] {
  const since = Date.now() - windowMs
  return entries.filter((entry) => entry.time >= since).map((entry) => ({ ...entry }))
}

const FUNCTION_KEYS = new Set([
  'Escape',
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'F5',
  'F11',
])

function keyDetail(event: KeyboardEvent): string | null {
  if (event.isComposing) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.metaKey) parts.push('Meta')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  const key = event.key
  // 组合键只记录按键名；普通可打印字符（输入内容）一律不记录。
  if (parts.length > 0) {
    const name = key.length === 1 ? key.toUpperCase() : key
    return [...parts, name].join('+')
  }
  if (FUNCTION_KEYS.has(key)) return key
  return null
}

/** 在 main.tsx 最早安装：只采集，不拦截任何事件。 */
export function installFeedbackTrace(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener(
    'click',
    (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('[data-feedback-ui]')) return
      const clickable = target.closest(
        'button, a[href], [role="button"], [role="menuitem"], [role="tab"], input, textarea, select',
      )
      const element = clickable ?? target
      const text = visibleTextSnippet(element).slice(0, 80)
      const selector = cssSelectorFor(element).slice(0, 160)
      recordFeedbackTrace('click', `${selector}${text ? ` 「${text}」` : ''}`)
    },
    true,
  )

  window.addEventListener(
    'keydown',
    (event) => {
      const detail = keyDetail(event)
      if (detail) recordFeedbackTrace('key', detail)
    },
    true,
  )

  window.addEventListener('hashchange', () => {
    recordFeedbackTrace('route', window.location.hash || '#/')
  })
  recordFeedbackTrace('route', window.location.hash || '#/')

  let prevRuntimes = useAppStore.getState().runtimes
  useAppStore.subscribe((state) => {
    const next = state.runtimes
    if (next === prevRuntimes) return
    for (const [hostId, runtime] of Object.entries(next)) {
      const before = prevRuntimes[hostId]?.status
      if (before && before !== runtime.status) {
        const name = runtime.info?.name ?? hostId
        recordFeedbackTrace('ws', `${name}: ${before} → ${runtime.status}`)
      }
    }
    prevRuntimes = next
  })

  let prevToasts = useUiStore.getState().toasts
  useUiStore.subscribe((state) => {
    if (state.toasts === prevToasts) return
    const known = new Set(prevToasts.map((toast) => toast.id))
    for (const toast of state.toasts) {
      if (known.has(toast.id)) continue
      recordFeedbackTrace('toast', `[${toast.kind}] ${toast.text}`)
    }
    prevToasts = state.toasts
  })
}
