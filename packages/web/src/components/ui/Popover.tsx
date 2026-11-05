import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useClickOutside } from '../../lib/hooks'
import { cn } from '../../lib/cn'

interface PopoverProps {
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  side?: 'bottom' | 'top'
  panelClassName?: string
  className?: string
}

/** 轻量下拉：点击外部或 Esc 关闭。 */
export function Popover({
  trigger,
  children,
  align = 'left',
  side = 'bottom',
  panelClassName,
  className,
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useClickOutside(ref, close, open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div ref={ref} className={cn('relative', className)}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          className={cn(
            'anim-slide-up absolute z-50 overflow-hidden rounded-xl border border-border bg-surface p-1.5 shadow-[0_14px_40px_-14px_rgba(30,24,18,0.4)]',
            side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
            align === 'left' ? 'left-0' : 'right-0',
            panelClassName,
          )}
          role="menu"
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}
