import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { cn } from '../lib/cn'

export type ThinkingMode = 'show' | 'collapse' | 'hidden'

const THINKING_KEY = 'tandem.thinking.v1'
const MODE_ORDER: ThinkingMode[] = ['show', 'collapse', 'hidden']

export const THINKING_MODE_META: Record<
  ThinkingMode,
  { label: string; hint: string }
> = {
  show: { label: '显示', hint: '直接展开思考内容' },
  collapse: { label: '折叠', hint: '只显示一行，点开查看' },
  hidden: { label: '隐藏', hint: '完全不显示思考过程' },
}

function loadMode(): ThinkingMode {
  try {
    const raw = localStorage.getItem(THINKING_KEY)
    return raw === 'show' || raw === 'hidden' || raw === 'collapse' ? raw : 'collapse'
  } catch {
    return 'collapse'
  }
}

let currentMode: ThinkingMode = loadMode()
const listeners = new Set<() => void>()

export function setThinkingMode(mode: ThinkingMode): void {
  if (mode === currentMode) return
  currentMode = mode
  try {
    localStorage.setItem(THINKING_KEY, mode)
  } catch {
    /* localStorage 不可用时仅本次生效 */
  }
  listeners.forEach((listener) => listener())
}

export function nextThinkingMode(mode: ThinkingMode): ThinkingMode {
  return MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]
}

export function useThinkingMode(): ThinkingMode {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => currentMode,
    () => 'collapse' as ThinkingMode,
  )
}

/**
 * 思考过程：显示（展开）/ 折叠（一行）/ 隐藏，三种模式下都不渲染未打开的内容。
 * 历史消息没有耗时数据，按文本长度给出一个保守估计。
 */
export function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const mode = useThinkingMode()
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
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

  if (mode === 'hidden') return null
  if (!text && !streaming) return null

  const seconds = measured ?? Math.min(999, Math.max(1, Math.round(text.length / 55)))
  const expanded = mode === 'show' || open
  const showBody = expanded || mounted

  return (
    <div className="my-1" data-thinking={mode}>
      {mode === 'show' ? (
        <div className="tool-row cursor-default">
          <Brain size={14} className="shrink-0 text-text-secondary" />
          <span className={cn('min-w-0 truncate', streaming && 'shimmer-text')}>
            {streaming ? '思考中…' : `思考了 ${seconds}s`}
          </span>
        </div>
      ) : (
        <button
          onClick={() => {
            setMounted(true)
            setOpen((v) => !v)
          }}
          aria-expanded={open}
          className="tool-row"
        >
          <Brain size={14} className="shrink-0 text-text-secondary" />
          <span className={cn('min-w-0 truncate', streaming && 'shimmer-text')}>
            {streaming ? '思考中…' : `思考了 ${seconds}s`}
          </span>
          <ChevronRight
            size={12}
            className={cn('tool-chevron ml-auto shrink-0', open && 'opacity-70')}
          />
        </button>
      )}
      {mode === 'show' ? (
        <div className="mt-1 whitespace-pre-wrap break-words rounded-[10px] bg-[color-mix(in_srgb,var(--t-surface-2)_45%,transparent)] px-3.5 py-2.5 text-[13px] leading-[1.7] text-text-soft">
          {text || '…'}
        </div>
      ) : (
        showBody && (
          <div className="collapse-grid" data-open={expanded}>
            <div className="collapse-inner">
              <div className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] bg-[color-mix(in_srgb,var(--t-surface-2)_45%,transparent)] px-3.5 py-2.5 text-[13px] leading-[1.7] text-text-soft">
                {text || '…'}
              </div>
            </div>
          </div>
        )
      )}
    </div>
  )
}
