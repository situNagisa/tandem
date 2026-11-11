import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import * as RPopover from '@radix-ui/react-popover'
import { cn } from '../../lib/cn'
import { portalLayer } from '../../lib/overlay'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import { popoverSurfaceClass } from './Popover'
import { TIP_SHOW_DELAY, TIP_SKIP_DELAY } from './Tooltip'

/** 与标准 tooltip 同一组延迟：悬停会话行 500ms 弹出，移开 300ms 收起。 */
export const HOVER_CARD_OPEN_DELAY = TIP_SHOW_DELAY
export const HOVER_CARD_CLOSE_DELAY = TIP_SKIP_DELAY

interface HoverCardProps {
  /** 触发元素（整行），外层包一个锚点 div，不改变行自身布局。 */
  children: ReactNode
  /** 浮层内容；`close` 用于点击条目后收起。 */
  content: (close: () => void) => ReactNode
  /** 浮层宽度；固定宽度保证展开/加载时弹层不跳。 */
  width?: number
  side?: 'right' | 'left' | 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  className?: string
  label: string
  disabled?: boolean
}

/**
 * 悬停浮层：Portal + 碰撞避让（复用 Radix Popover），移入浮层不消失，
 * 移出触发器与浮层后延迟收起；打开期间浮层外的标准 tooltip 暂停，避免两层叠在一起。
 */
export function HoverCard({
  children,
  content,
  width = 320,
  side = 'right',
  align = 'start',
  className,
  label,
  disabled = false,
}: HoverCardProps) {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const clearOpenTimer = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }
  const clearCloseTimer = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const closeNow = useCallback(() => {
    clearOpenTimer()
    clearCloseTimer()
    setOpen(false)
  }, [])

  useEffect(() => {
    if (disabled) closeNow()
  }, [disabled, closeNow])

  useEffect(
    () => () => {
      if (openTimer.current !== null) window.clearTimeout(openTimer.current)
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeNow()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, closeNow])

  const scheduleOpen = (pointerType: string) => {
    if (disabled || pointerType === 'touch') return
    clearCloseTimer()
    if (open || openTimer.current !== null) return
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      setOpen(true)
    }, HOVER_CARD_OPEN_DELAY)
  }
  const scheduleClose = (pointerType: string) => {
    if (pointerType === 'touch') return
    // 反馈模式（Ctrl+Shift+F）里捕获层盖住浮层，指针会离开触发元素：
    // 与菜单/Popover 的共享层规则一致，进入反馈模式后不因移开指针收起，浮层停住供圈选。
    if (useFeedbackStore.getState().active) return
    clearOpenTimer()
    if (closeTimer.current !== null) return
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, HOVER_CARD_CLOSE_DELAY)
  }

  return (
    <RPopover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : closeNow())} modal={false}>
      <RPopover.Anchor asChild>
        <div
          className={cn('relative', className)}
          onPointerEnter={(event) => scheduleOpen(event.pointerType)}
          onPointerLeave={(event) => scheduleClose(event.pointerType)}
          onPointerDown={closeNow}
        >
          {children}
        </div>
      </RPopover.Anchor>
      <RPopover.Portal>
        <RPopover.Content
          {...portalLayer('popover')}
          role="dialog"
          aria-label={label}
          data-side={side}
          data-align={align}
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={8}
          avoidCollisions
          sticky="always"
          hideWhenDetached
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={(event) => {
            if (event.pointerType === 'touch') return
            clearCloseTimer()
          }}
          onPointerLeave={(event) => scheduleClose(event.pointerType)}
          onInteractOutside={closeNow}
          className="z-[80] outline-none"
          style={{ width }}
        >
          <div
            ref={panelRef}
            className={cn(popoverSurfaceClass, 'flex min-h-0 w-full flex-col p-2')}
            data-hover-card
          >
            {content(closeNow)}
          </div>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}
