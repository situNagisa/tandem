import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { cn } from '../lib/cn'

/**
 * 思考过程折叠为一行；流式时显示“思考中…”，结束后显示耗时。
 * 历史消息没有耗时数据，按文本长度给出一个保守估计。
 */
export function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const startedAt = useRef<number | null>(streaming ? Date.now() : null)
  const [measured, setMeasured] = useState<number | null>(null)

  useEffect(() => {
    if (streaming) {
      startedAt.current ??= Date.now()
      setMeasured(null)
      return
    }
    if (startedAt.current != null) {
      setMeasured(Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)))
      startedAt.current = null
    }
  }, [streaming])

  if (!text && !streaming) return null

  const seconds = measured ?? Math.min(999, Math.max(1, Math.round(text.length / 55)))

  return (
    <div className="my-1">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="tool-row"
      >
        <Brain
          size={14}
          className={cn('shrink-0', streaming ? 'text-accent' : 'text-muted')}
        />
        <span className={cn('min-w-0 truncate', streaming && 'shimmer-text')}>
          {streaming ? '思考中…' : `思考了 ${seconds}s`}
        </span>
        <ChevronRight size={12} className="tool-chevron ml-auto shrink-0" />
      </button>
      <div className="collapse-grid" data-open={open}>
        <div className="collapse-inner">
          <div className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] bg-[color-mix(in_srgb,var(--t-surface-2)_45%,transparent)] px-3.5 py-2.5 text-[13px] leading-[1.7] text-text-soft">
            {text || '…'}
          </div>
        </div>
      </div>
    </div>
  )
}
