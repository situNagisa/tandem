import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '../lib/cn'
import { languageLabel, loadHighlighter } from '../lib/highlight'
import { copyText } from '../lib/clipboard'

const MAX_CHARS = 200_000

interface CodeBlockProps {
  code: string
  language?: string
  fileName?: string
  showHeader?: boolean
  maxHeight?: number
  placeholder?: string
  className?: string
}

export function CodeBlock({
  code,
  language,
  fileName,
  showHeader = true,
  maxHeight = 420,
  placeholder,
  className,
}: CodeBlockProps) {
  const [highlighted, setHighlighted] = useState<{ code: string; html: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)
  const shown = useMemo(
    () => (code.length > MAX_CHARS ? code.slice(0, MAX_CHARS) + '\n…（内容过长，已截断）' : code),
    [code],
  )

  useEffect(() => {
    if (!language) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      loadHighlighter()
        .then((hljs) => {
          if (cancelled || !hljs.getLanguage(language)) return
          try {
            const html = hljs.highlight(shown, { language, ignoreIllegals: true }).value
            if (!cancelled) setHighlighted({ code: shown, html })
          } catch {
            /* 高亮失败时保留纯文本 */
          }
        })
        .catch(() => {
          /* 忽略加载失败 */
        })
    }, 60)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [shown, language])

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const html = highlighted && highlighted.code === shown ? highlighted.html : null

  const copy = async () => {
    if (!(await copyText(code))) return
    setCopied(true)
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  const empty = !shown

  return (
    <div className={cn('chat-code', className)}>
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
      <pre style={{ maxHeight }}>
        {empty ? (
          <span className="italic text-muted">{placeholder ?? '（空）'}</span>
        ) : html ? (
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code>{shown}</code>
        )}
      </pre>
    </div>
  )
}
