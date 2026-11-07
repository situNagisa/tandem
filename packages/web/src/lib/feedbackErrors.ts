/** 反馈模式采集的全局错误（环形缓冲，最近 50 条）。在 main.tsx 最早安装。 */
import { recordFeedbackTrace } from './feedbackTrace'

export interface FeedbackErrorEntry {
  time: number
  source: 'console.error' | 'window.onerror' | 'unhandledrejection'
  message: string
  stack?: string
}

const MAX_ERRORS = 50
const SESSION_KEY = 'tandem.feedbackErrors.v1'
const entries: FeedbackErrorEntry[] = []
let installed = false

function push(entry: FeedbackErrorEntry): void {
  entries.push(entry)
  recordFeedbackTrace('error', `${entry.source}: ${entry.message}`)
  if (entries.length > MAX_ERRORS) entries.splice(0, entries.length - MAX_ERRORS)
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(entries))
  } catch {
    /* 隐私模式或配额不足时只保留内存副本 */
  }
}

function loadFromSession(): void {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as FeedbackErrorEntry[]
    if (!Array.isArray(saved)) return
    entries.push(
      ...saved
        .filter((entry) => entry && typeof entry.message === 'string')
        .slice(-MAX_ERRORS),
    )
  } catch {
    /* 忽略损坏的缓存 */
  }
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (value === null || value === undefined) return String(value)
  try {
    const json = JSON.stringify(value)
    return json.length > 4000 ? `${json.slice(0, 4000)}…` : json
  } catch {
    return Object.prototype.toString.call(value)
  }
}

export function installFeedbackErrorBuffer(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const marker = window as Window & { __tandemFeedbackErrorsInstalled?: boolean }
  if (marker.__tandemFeedbackErrorsInstalled) return
  marker.__tandemFeedbackErrorsInstalled = true
  loadFromSession()

  const originalError = console.error
  console.error = (...args: unknown[]) => {
    try {
      push({
        time: Date.now(),
        source: 'console.error',
        message: args.map(safeString).join(' ').slice(0, 8000),
      })
    } catch {
      /* 采集失败不影响原日志 */
    }
    originalError.apply(console, args)
  }

  window.addEventListener('error', (event) => {
    push({
      time: Date.now(),
      source: 'window.onerror',
      message: String(event.message || event.error || '未知脚本错误').slice(0, 8000),
      stack: event.error instanceof Error ? event.error.stack?.slice(0, 8000) : undefined,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    push({
      time: Date.now(),
      source: 'unhandledrejection',
      message: safeString(reason).slice(0, 8000),
      stack: reason instanceof Error ? reason.stack?.slice(0, 8000) : undefined,
    })
  })
}

export function getFeedbackErrors(): FeedbackErrorEntry[] {
  return entries.slice()
}
