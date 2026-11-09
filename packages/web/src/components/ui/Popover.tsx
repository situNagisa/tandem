import { useCallback, useRef, useState, type ReactNode } from 'react'
import * as RPopover from '@radix-ui/react-popover'
import { cn } from '../../lib/cn'
import { portalLayer } from '../../lib/overlay'
import { useFeedbackStore } from '../../store/useFeedbackStore'

/** 弹层表面样式（尺寸、圆角、阴影、动画）唯一来源；自定义定位的 Rich Popover 也复用它。 */
export const popoverSurfaceClass = 'popover-panel'

interface PopoverProps {
  trigger: (state: { open: boolean; toggle: () => void; close: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right' | 'center'
  side?: 'bottom' | 'top' | 'right' | 'left'
  /** 面板是否带默认内边距；自定义菜单（如带搜索框）可设为 false。 */
  padded?: boolean
  panelClassName?: string
  /**
   * 面板固定宽度（CSS 值）。宽度必须落在 Radix 的外层 Content 上：
   * 内层 `.popover-panel` 的 `w-full` 在 auto 宽的外层里会退化成内容宽，
   * 展开/折叠明细时整个弹层跟着变宽变窄（反馈16#06 / R49）。
   */
  panelWidth?: string | number
  className?: string
  /** 受控打开状态；不传时组件自行管理。 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * 统一弹出层：Radix Popover 负责 Portal 与边界避让（翻转 + 平移），
 * 侧栏、输入框附近的菜单都不会被滚动容器裁切。
 */
export function Popover({
  trigger,
  children,
  align = 'left',
  side = 'bottom',
  padded = true,
  panelClassName,
  panelWidth,
  className,
  open: openProp,
  onOpenChange,
}: PopoverProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  // 从一个弹层直接点另一个触发器时，旧弹层关闭后不能把焦点抢回自己的触发器，
  // 否则新弹层刚挂载就收到 focus-outside 又立刻收起（反馈 #04）。
  const pointerDownOutside = useRef(false)
  const [internalOpen, setInternalOpen] = useState(false)
  const open = openProp ?? internalOpen
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange],
  )
  const close = useCallback(() => setOpen(false), [setOpen])

  return (
    <RPopover.Root open={open} onOpenChange={setOpen} modal={false}>
      <RPopover.Anchor asChild>
        <div ref={anchorRef} className={cn('relative', className)}>
          {trigger({ open, toggle: () => setOpen(!open), close })}
        </div>
      </RPopover.Anchor>
      <RPopover.Portal>
        <RPopover.Content
          {...portalLayer('popover')}
          role="menu"
          data-side={side}
          data-align={align}
          side={side}
          align={align === 'right' ? 'end' : align === 'center' ? 'center' : 'start'}
          sideOffset={8}
          collisionPadding={8}
          avoidCollisions
          sticky="always"
          hideWhenDetached
          onOpenAutoFocus={(e) => {
            pointerDownOutside.current = false
            e.preventDefault()
          }}
          onCloseAutoFocus={(e) => {
            // 点外部（通常是另一个弹层触发器）关闭时不要还原焦点，
            // 焦点留在用户刚点的位置，新弹层才能保持打开（反馈 #04）。
            if (pointerDownOutside.current) {
              pointerDownOutside.current = false
              e.preventDefault()
              return
            }
            // Anchor 是包裹 div，Radix 默认把焦点还给不可聚焦的 div，会掉到 body。
            const target = anchorRef.current?.querySelector<HTMLElement>(
              'input, textarea, [contenteditable="true"], button, a[href], [tabindex]:not([tabindex="-1"])',
            )
            if (target) {
              e.preventDefault()
              target.focus()
            }
          }}
          onPointerDownOutside={(e) => {
            if (useFeedbackStore.getState().active) {
              e.preventDefault()
              return
            }
            pointerDownOutside.current = true
          }}
          onFocusOutside={(e) => {
            if (useFeedbackStore.getState().active) e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (useFeedbackStore.getState().active) {
              e.preventDefault()
              return
            }
            // 不论是点外部还是焦点被另一个弹层拿走，关闭时都不要还原焦点。
            pointerDownOutside.current = true
          }}
          className="z-[80] outline-none"
          style={panelWidth !== undefined ? { width: panelWidth } : undefined}
        >
          {/* 反馈14#01/#02（R52 复发）：动画放到内层，外层保留 Radix 的定位 transform。 */}
          <div
            className={cn(
              popoverSurfaceClass,
              'flex min-h-0 w-full flex-col',
              padded && 'p-1.5',
              panelClassName,
            )}
          >
            {children(close)}
          </div>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}
