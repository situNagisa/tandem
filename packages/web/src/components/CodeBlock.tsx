import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeftRight, Check, Copy } from 'lucide-react'
import { cn } from '../lib/cn'
import { languageLabel, loadHighlighter } from '../lib/highlight'
import { copyText } from '../lib/clipboard'
import { useHorizontalOverflow } from '../lib/hooks'

const MAX_CHARS = 200_000
const HIGHLIGHT_CACHE_MAX = 80
const highlightCache = new Map<string, { code: string; html: string }>()
let highlightCacheChars = 0

function hashText(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function cacheKey(language: string, code: string): string {
  return `${language}:${code.length}:${hashText(code)}`
}

function readCache(key: string, code: string): string | undefined {
  const hit = highlightCache.get(key)
  if (!hit || hit.code !== code) return undefined
  // LRU：命中后移到末尾
  highlightCache.delete(key)
  highlightCache.set(key, hit)
  return hit.html
}

function writeCache(key: string, code: string, html: string): void {
  if (html.length > 300_000) return
  const prev = highlightCache.get(key)
  if (prev) highlightCacheChars -= prev.html.length
  highlightCache.set(key, { code, html })
  highlightCacheChars += html.length
  while (highlightCache.size > HIGHLIGHT_CACHE_MAX || highlightCacheChars > 2_000_000) {
    const first = highlightCache.keys().next().value
    if (first == null) break
    highlightCacheChars -= highlightCache.get(first)?.html.length ?? 0
    highlightCache.delete(first)
  }
}


type IdleDeadline = { didTimeout: boolean; timeRemaining: () => number }
const highlightQueue: Array<() => void> = []
let highlightScheduled = false

function scheduleHighlight(job: () => void): void {
  highlightQueue.push(job)
  if (highlightScheduled) return
  highlightScheduled = true
  const pump = () => {
    highlightScheduled = false
    const next = highlightQueue.shift()
    if (!next) return
    next()
    if (highlightQueue.length) {
      highlightScheduled = true
      schedulePump()
    }
  }
  const schedulePump = () => {
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: (d: IdleDeadline) => void, opts?: { timeout: number }) => number
    }).requestIdleCallback
    if (ric) ric.call(window, pump, { timeout: 1200 })
    else window.setTimeout(pump, 80)
  }
  schedulePump()
}

interface CodeBlockProps {
  code: string
  language?: string
  fileName?: string
  showHeader?: boolean
  maxHeight?: number | null
  placeholder?: string
  className?: string
  /** 流式代码尚未稳定：先显示纯文本，结束后再高亮。 */
  streaming?: boolean
  /** 文件预览：左侧行号与可定位的目标行区间。 */
  lineNumbers?: boolean
  highlightRange?: { start: number; end: number }
  scrollToLine?: number
  /** 撑满父容器，由内部滚动（文件预览面板用）。 */
  fill?: boolean
}

export function CodeBlock({
  code,
  language,
  fileName,
  showHeader = true,
  maxHeight = 420,
  placeholder,
  className,
  streaming = false,
  lineNumbers = false,
  highlightRange,
  scrollToLine,
  fill = false,
}: CodeBlockProps) {
  const [highlighted, setHighlighted] = useState<{ code: string; html: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)
  const shown = useMemo(
    () => (code.length > MAX_CHARS ? code.slice(0, MAX_CHARS) + '\n…（内容过长，已截断）' : code),
    [code],
  )
  const key = language ? cacheKey(language, shown) : ''
  const html = highlighted && highlighted.code === shown ? highlighted.html : null
  const { ref: preRef, canLeft, canRight, update: updateOverflow } = useHorizontalOverflow<HTMLPreElement>([
    shown,
    html,
  ])
  const scrollBoxRef = useRef<HTMLDivElement>(null)
  const lineCount = useMemo(() => (shown ? shown.split('\n').length : 0), [shown])

  // 文件预览打开时滚到目标行（上方留约 1/3 视口）。
  useEffect(() => {
    if (!lineNumbers || !scrollToLine) return
    const el = scrollBoxRef.current
    if (!el) return
    const raf = window.requestAnimationFrame(() => {
      el.scrollTop = Math.max(0, 12 + (scrollToLine - 1) * 20 - el.clientHeight / 3)
    })
    return () => window.cancelAnimationFrame(raf)
  }, [lineNumbers, scrollToLine, shown])

  useEffect(() => {
    if (!language || streaming) return
    const cached = key ? readCache(key, shown) : undefined
    if (cached) {
      setHighlighted({ code: shown, html: cached })
      return
    }
    let cancelled = false
    let observer: IntersectionObserver | null = null

    const run = () => {
      if (cancelled) return
      loadHighlighter()
        .then((hljs) => {
          if (cancelled || !hljs.getLanguage(language)) return
          try {
            const html = hljs.highlight(shown, { language, ignoreIllegals: true }).value
            if (cancelled) return
            writeCache(key, shown, html)
            setHighlighted({ code: shown, html })
          } catch {
            /* 高亮失败时保留纯文本 */
          }
        })
        .catch(() => {
          /* 忽略加载失败 */
        })
    }

    // 视口外的代码块不解析：长会话打开时只高亮看得见的几块。
    if (typeof IntersectionObserver !== 'undefined') {
      const el = preRef.current
      if (!el) return
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return
          observer?.disconnect()
          observer = null
          scheduleHighlight(run)
        },
        { rootMargin: '400px 0px' },
      )
      observer.observe(el)
    } else {
      scheduleHighlight(run)
    }

    return () => {
      cancelled = true
      observer?.disconnect()
    }
  }, [shown, language, key, streaming])

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const copy = async () => {
    if (!(await copyText(code))) return
    setCopied(true)
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  const empty = !shown

  return (
    <div className={cn('chat-code', fill && 'file-code-fill', className)}>
      {showHeader && (
        <div className="chat-code-head">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">
            {fileName || languageLabel(language)}
          </span>
          {fileName && (
            <span className="shrink-0 text-[10.5px] text-muted">{languageLabel(language)}</span>
          )}
          <button
            onClick={copy}
            aria-label={copied ? '已复制' : '复制代码'}
            title={copied ? '已复制' : '复制'}
            className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text-soft"
          >
            {copied ? (
              <Check size={13} className="text-success" />
            ) : (
              <Copy size={12.5} className="opacity-80" />
            )}
          </button>
        </div>
      )}
      <div className={cn('x-scroll-wrap', fill && 'flex min-h-0 flex-1 flex-col')}>
        {lineNumbers ? (
          <div
            ref={scrollBoxRef}
            className="file-code-scroll"
            style={fill ? { height: '100%' } : maxHeight != null ? { maxHeight } : undefined}
          >
            <div className="file-code-grid">
              {highlightRange && (
                <div
                  className="file-code-range"
                  aria-hidden
                  style={{
                    top: 12 + (highlightRange.start - 1) * 20,
                    height: Math.max(1, highlightRange.end - highlightRange.start + 1) * 20,
                  }}
                />
              )}
              <div className="file-code-gutter" aria-hidden>
                {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
              </div>
              <pre ref={preRef}>
                {empty ? (
                  <span className="italic text-muted">{placeholder ?? '（空）'}</span>
                ) : html ? (
                  <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
                ) : (
                  <code>{shown}</code>
                )}
              </pre>
            </div>
          </div>
        ) : (
          <pre ref={preRef} onScroll={updateOverflow} style={maxHeight != null ? { maxHeight } : undefined}>
            {empty ? (
              <span className="italic text-muted">{placeholder ?? '（空）'}</span>
            ) : html ? (
              <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <code>{shown}</code>
            )}
          </pre>
        )}
        <div className="x-scroll-fade" data-visible={canRight} aria-hidden />
        {canLeft || canRight ? (
          <div className="x-scroll-foot">
            <ArrowLeftRight size={10} /> 左右滑动查看
          </div>
        ) : null}
      </div>
    </div>
  )
}
