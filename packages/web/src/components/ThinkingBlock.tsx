import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '../lib/cn'

export function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming)
  const touched = useRef(false)

  useEffect(() => {
    if (!touched.current) setOpen(streaming)
  }, [streaming])

  if (!text && !streaming) return null

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-border/70 bg-surface-2/25">
      <button
        onClick={() => {
          touched.current = true
          setOpen((v) => !v)
        }}
        className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left"
        aria-expanded={open}
      >
        {streaming ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
        ) : (
          <Brain size={13} className="shrink-0 text-muted" />
        )}
        <span
          className={cn(
            'text-[12px] font-medium',
            streaming ? 'shimmer-text' : 'text-text-soft',
          )}
        >
          {streaming ? '正在思考…' : '思考过程'}
        </span>
        <span className="flex-1" />
        <ChevronRight
          size={13}
          className={cn('shrink-0 text-muted transition-transform duration-150', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div className="max-h-80 overflow-y-auto border-t border-border/60 px-3.5 py-2.5 text-[12.5px] leading-6 text-text-soft">
          <div className="whitespace-pre-wrap break-words">{text || '…'}</div>
        </div>
      )}
    </div>
  )
}
