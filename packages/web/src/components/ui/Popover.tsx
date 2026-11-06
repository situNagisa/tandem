import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
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
  /** 受控打开状态；不传时组件自行管理。 */
  open?: boolean
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
  open: openProp,
  onOpenChange,
}: PopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = openProp ?? internalOpen
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange],
  )
  const [mounted, setMounted] = useState(false)
  const [closing, setClosing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [setOpen])
  useClickOutside(ref, close, open)

  // 靠近视口边缘的触发器（如手机输入框里的模型按钮）会把面板顶出屏幕，
  // 打开后按实际宽度横向校准，保留 8px 安全边距。translate 独立于入场 scale。
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const el = panelRef.current
      const anchor = ref.current
      if (!el || !anchor) return
      el.style.translate = '0px 0px'
      // 用 offset 几何量而不是 getBoundingClientRect：入场动画带有 scale，
      // 直接量会在动画结束前误判边界。
      const anchorRect = anchor.getBoundingClientRect()
      const left = anchorRect.left + el.offsetLeft
      const right = left + el.offsetWidth
      const margin = 8
      let dx = 0
      if (left < margin) dx = margin - left
      else if (right > window.innerWidth - margin) {
        dx = window.innerWidth - margin - right
      }
      if (dx) el.style.translate = `${dx}px 0px`
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, mounted])

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    setClosing(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, 160)
    return () => window.clearTimeout(timer)
  }, [open, mounted])

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
      {trigger({ open, toggle: () => setOpen(!open), close })}
      {mounted && (
        <div
          ref={panelRef}
          role="menu"
          data-side={side}
          data-align={align}
          data-closing={closing || undefined}
          aria-hidden={closing || undefined}
          inert={closing}
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
