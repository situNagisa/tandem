import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { IconButton } from './Button'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  /** title 为节点时用于 dialog 的无障碍名称。 */
  ariaLabel?: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
  bodyClassName?: string
  align?: 'center' | 'top'
  /** 叠放层级；从设置页等已打开的弹层里再打开时调高。 */
  layer?: number
}

/** 嵌套 Modal（如设置里的删除确认）只让最上层响应 Esc，避免一次关掉两层。 */
const modalStack: symbol[] = []

export function Modal({
  open,
  onClose,
  title,
  ariaLabel,
  description,
  children,
  footer,
  className,
  bodyClassName,
  align = 'center',
  layer,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)

  // 打开前记住触发元素，关闭/卸载后把焦点还回去，避免焦点掉到 body。
  const focusReturnActiveRef = useRef(false)
  useEffect(() => {
    if (!open) return
    focusReturnActiveRef.current = true
    if (!returnFocusRef.current) {
      const active = document.activeElement
      returnFocusRef.current = active instanceof HTMLElement ? active : null
    }
    return () => {
      focusReturnActiveRef.current = false
      const target = returnFocusRef.current
      returnFocusRef.current = null
      if (!target?.isConnected) return
      window.setTimeout(() => {
        if (!focusReturnActiveRef.current && target.isConnected) target.focus()
      }, 0)
    }
  }, [open])

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
    const id = Symbol('modal')
    modalStack.push(id)
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== id) return
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const list = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.getClientRects().length > 0)
      if (list.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const active = document.activeElement as HTMLElement | null
      const first = list[0]
      const last = list[list.length - 1]
      // 焦点在面板本身（打开瞬间）或面板内不可 Tab 的元素上时，也要拉回循环。
      if (!active || !panel.contains(active) || !list.includes(active)) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
        return
      }
      if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      const index = modalStack.indexOf(id)
      if (index >= 0) modalStack.splice(index, 1)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const focusPanel = () => {
      const panel = panelRef.current
      if (!panel || panel.contains(document.activeElement)) return
      const el = panel.querySelector<HTMLElement>(
        'input:not([type="hidden"]), textarea, select, button[data-autofocus]',
      )
      ;(el ?? panel).focus()
    }
    // 先同步聚焦一次，避免调用方在打开后立刻读取焦点时还在等待定时器。
    focusPanel()
    const t = window.setTimeout(focusPanel, 30)
    return () => window.clearTimeout(t)
  }, [open])

  if (!mounted) return null

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/25 p-3 backdrop-blur-[2px] dark:bg-black/50',
        closing ? 'anim-fade-out pointer-events-none' : 'anim-fade-in',
        align === 'center' ? 'items-center sm:p-6' : 'items-start pt-[8vh] sm:pt-[12vh]',
      )}
      aria-hidden={closing || undefined}
      style={layer !== undefined ? { zIndex: layer } : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
        className={cn(
          'modal-panel my-auto flex max-h-[92dvh] flex-col overflow-hidden rounded-2xl border border-border bg-surface text-text shadow-[var(--t-shadow-lg)] outline-none',
          closing ? 'anim-scale-out' : 'anim-dialog',
          align === 'top' && 'my-0',
          className ?? 'max-w-lg',
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {(title || description) && (
          <div className="flex items-start gap-3 border-b border-border px-5 py-3.5">
            <div className="min-w-0 flex-1">
              {title && <h2 className="truncate text-[15px] font-medium tracking-[-0.01em]">{title}</h2>}
              {description && <p className="mt-0.5 text-[12px] leading-5 text-muted">{description}</p>}
            </div>
            <IconButton onClick={onClose} label="关闭" className="-mr-1 max-sm:size-11">
              <X size={16} />
            </IconButton>
          </div>
        )}
        <div className={cn('min-h-0 flex-1 overflow-y-auto', bodyClassName ?? 'p-5')}>{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border bg-bg/50 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
