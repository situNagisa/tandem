import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
  bodyClassName?: string
  align?: 'center' | 'top'
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  bodyClassName,
  align = 'center',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)

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
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(
        'input:not([type="hidden"]), textarea, select, button[data-autofocus]',
      )
      el?.focus()
    }, 30)
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
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn(
          'my-auto flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface text-text shadow-[var(--t-shadow-lg)]',
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
            <button
              onClick={onClose}
              aria-label="关闭"
              className="-mr-1 flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text sm:size-8"
            >
              <X size={16} />
            </button>
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
