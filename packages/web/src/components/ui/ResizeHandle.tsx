import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '../../lib/cn'

export interface ResizeHandleProps {
  /** 当前宽度（拖动开始时作为起点）。 */
  value: number
  min: number
  max: number
  /** 手柄所在边：left 向左拖增大，right 向右拖增大。 */
  edge?: 'left' | 'right'
  onChange: (value: number) => void
  /** 松手/双击后提交（持久化）。 */
  onCommit?: (value: number) => void
  /** 双击复位到的宽度。 */
  resetValue?: number
  label?: string
  disabled?: boolean
  /** 放在 flex 行内（如文件树分隔）而不是绝对定位在面板边缘。 */
  inline?: boolean
  className?: string
}

/**
 * 可拖宽的垂直分界线：面板宽度调整共用这一处实现（#03 R01）。
 * 拖动期间只回调 onChange；松手或双击才 onCommit，避免每帧写 localStorage。
 */
export function ResizeHandle({
  value,
  min,
  max,
  edge = 'left',
  onChange,
  onCommit,
  resetValue,
  label = '调整面板宽度',
  disabled,
  inline,
  className,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false)

  const clampWidth = (width: number) => Math.round(Math.min(max, Math.max(min, width)))

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = value
    let last = startWidth
    setDragging(true)
    const move = (ev: PointerEvent) => {
      last = clampWidth(startWidth + (edge === 'left' ? startX - ev.clientX : ev.clientX - startX))
      onChange(last)
    }
    const up = () => {
      setDragging(false)
      onCommit?.(last)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-tip="拖动调整宽度，双击复位"
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={start}
      onDoubleClick={() => {
        if (disabled || resetValue === undefined) return
        const next = clampWidth(resetValue)
        onChange(next)
        onCommit?.(next)
      }}
      className={cn(
        'group z-10 cursor-col-resize touch-none transition-colors hover:bg-[var(--t-border-strong)]/30',
        inline ? 'relative h-auto w-1 shrink-0' : 'absolute top-0 h-full w-1.5',
        !inline && (edge === 'left' ? 'left-0' : 'right-0'),
        disabled && 'pointer-events-none',
        className,
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute inset-y-0 w-px bg-transparent transition-colors duration-150',
          edge === 'left' ? 'left-0' : 'right-0',
          dragging ? 'bg-accent' : 'group-hover:bg-border-strong',
        )}
      />
    </div>
  )
}
