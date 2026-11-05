import { useEffect, useMemo, useState } from 'react'
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

  const html = highlighted && highlighted.code === shown ? highlighted.html : null

  const copy = async () => {
    if (await copyText(code)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }
  }

  const empty = !shown

  return (
    <div className={cn('overflow-hidden rounded-xl border border-border bg-surface', className)}>
      {showHeader && (
        <div className="flex h-8 items-center gap-2 border-b border-border/80 bg-surface-2/40 px-3">
          {fileName ? (
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-soft">
              {fileName}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium uppercase tracking-wide text-muted">
              {languageLabel(language)}
            </span>
          )}
          {fileName && (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
              {languageLabel(language)}
            </span>
          )}
          <button
            onClick={copy}
            aria-label="复制代码"
            title="复制"
            className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
          >
            {copied ? <Check size={12.5} className="text-success" /> : <Copy size={12.5} />}
          </button>
        </div>
      )}
      <pre
        className="overflow-auto bg-surface-2/20 p-3 font-mono text-[12.5px] leading-[1.65] text-text"
        style={{ maxHeight }}
      >
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
