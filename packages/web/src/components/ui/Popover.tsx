import { useCallback, useState, type ReactNode } from 'react'
import * as RPopover from '@radix-ui/react-popover'
import { cn } from '../../lib/cn'

interface PopoverProps {
  trigger: (state: { open: boolean; toggle: () => void; close: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right' | 'center'
  side?: 'bottom' | 'top'
  /** 面板是否带默认内边距；自定义菜单（如带搜索框）可设为 false。 */
  padded?: boolean
  panelClassName?: string
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
  const close = useCallback(() => setOpen(false), [setOpen])

  return (
    <RPopover.Root open={open} onOpenChange={setOpen}>
      <RPopover.Anchor asChild>
        <div className={cn('relative', className)}>
          {trigger({ open, toggle: () => setOpen(!open), close })}
        </div>
      </RPopover.Anchor>
      <RPopover.Portal>
        <RPopover.Content
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
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={cn(
            'popover-panel z-[80] outline-none',
            padded && 'p-1.5',
            panelClassName,
          )}
        >
          {children(close)}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}
