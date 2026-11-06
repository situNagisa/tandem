import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { cn } from '../../lib/cn'

/** 取服务端错误文案的第一句，并去掉「host 返回 500：」这类技术前缀。 */
function readableReason(error: string): string {
  const line = error.trim().split(/\r?\n/)[0] ?? ''
  const sentence = (line.split('。')[0] ?? line).trim()
  const readable = sentence
    .replace(/^.+?\s*返回\s*\d{3}\b[^：:]*[：:]\s*/, '')
    .trim()
  return readable || sentence || '回合未完成'
}

/** 回合出错：内联在消息流末尾的单行胶囊，技术细节收进「详情」。 */
export function TurnErrorNotice({
  error,
  running,
  onRetry,
}: {
  error: string
  running: boolean
  onRetry: () => void
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setOpen(false)
  }, [error])

  return (
    <div className="mt-3 flex max-w-full flex-col items-start gap-1.5" role="status">
      <div className="flex h-7 max-w-full items-center gap-2 rounded-full border border-border bg-surface/80 pl-2.5 pr-1">
        <TriangleAlert size={13} className="shrink-0 text-danger" aria-hidden />
        <span className="min-w-0 truncate text-[12px] text-text-soft" title="回合出错">
          {readableReason(error)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onRetry}
            disabled={running}
            className="h-6 rounded-full px-2 text-[11.5px] font-medium text-text transition-colors hover:bg-bg-hover disabled:pointer-events-none disabled:opacity-40"
          >
            重试
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={cn(
              'h-6 rounded-full px-2 text-[11.5px] transition-colors hover:bg-bg-hover hover:text-text',
              open ? 'text-text' : 'text-muted',
            )}
          >
            {open ? '收起' : '详情'}
          </button>
        </span>
      </div>
      {open && (
        <div className="max-h-44 w-full overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface px-3 py-2 text-[11.5px] leading-5 text-muted">
          {error}
        </div>
      )}
    </div>
  )
}
