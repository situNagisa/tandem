import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'

/**
 * 侧面板统一布局：顶部固定工具条 + 可伸缩内容区。
 * 内容一律从工具条下方贴顶开始，横向溢出由内容自己决定滚动或换行。
 */
export function PanelBar({
  icon,
  title,
  actions,
  children,
  className,
  autoHeight = false,
}: {
  icon?: ReactNode
  title?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  /** 多行工具条（如 Wiki 页头）用，最小高度仍为 48px。 */
  autoHeight?: boolean
}) {
  return (
    <div
      data-panel-bar=""
      className={cn(
        'flex shrink-0 items-center gap-2 border-b border-border/70 px-3',
        autoHeight ? 'min-h-12' : 'h-12',
        className,
      )}
    >
      {icon ? <span className="flex shrink-0 items-center text-text-soft">{icon}</span> : null}
      {title ? <h2 className="shrink-0 text-[13px] font-semibold">{title}</h2> : null}
      {children}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  )
}

/** 面板剩余空间：min-h-0 才能让内部滚动区正确收缩；默认贴顶、不额外居中。 */
export function PanelBody({
  children,
  className,
  scroll = false,
  row = false,
  ...rest
}: {
  children?: ReactNode
  className?: string
  scroll?: boolean
  /** 左右分栏（文件树 + 预览）时用 row。 */
  row?: boolean
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      data-panel-body=""
      className={cn(
        'flex min-h-0 flex-1',
        row ? 'flex-row' : 'flex-col',
        scroll ? 'overflow-y-auto overflow-x-hidden' : 'overflow-hidden',
        className,
      )}
    >
      {children}
    </div>
  )
}
