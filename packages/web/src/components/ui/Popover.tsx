import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useClickOutside } from '../../lib/hooks'
import { cn } from '../../lib/cn'

interface PopoverProps {
  trigger: (state: { open: boolean; toggle: () => void; close: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  side?: 'bottom' | 'top'
  /** 面板是否带默认内边距；自定义菜单（如带搜索框）可设为 false。 */
  padded?: boolean
  panelClassName?: string
  className?: string
  onOpenChange?: (open: boolean) => void
}

/** 轻量下拉：点击外部或 Esc 关闭，统一使用 chat.css 中的 popover-panel 视觉。 */
export function Popover({
  trigger,
  children,
  align = 'left',
  side = 'bottom',
  padded = true,
  panelClassName,
  className,
  onOpenChange,
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useClickOutside(ref, close, open)

  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

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
      {trigger({ open, toggle: () => setOpen((v) => !v), close })}
      {open && (
        <div
          role="menu"
          data-side={side}
          data-align={align}
          className={cn(
            'popover-panel absolute z-50',
            padded && 'p-1.5',
            side === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2',
            align === 'left' ? 'left-0' : 'right-0',
            panelClassName,
          )}
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}
