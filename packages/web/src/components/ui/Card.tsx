import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** 语义标签；右栏与设置页默认 section。 */
  as?: 'section' | 'div' | 'article'
}

/**
 * 统一卡片：12px 圆角、16/18 内边距、无阴影（打分卡 U2-A）。
 * 宽度由容器决定（block + w-full），展开/折叠只改高度。
 */
export function Card({ as: Tag = 'section', className, children, ...rest }: CardProps) {
  return (
    <Tag
      data-card=""
      className={cn('w-full min-w-0 rounded-xl border border-border bg-surface px-[18px] py-4', className)}
      {...rest}
    >
      {children}
    </Tag>
  )
}
