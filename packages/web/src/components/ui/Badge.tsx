import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'

/**
 * 徽标/标签统一（打分卡 U3-B，2026-11-11 用户决定）：
 * 透明底 + 1px 边、4px 圆角、20px 高、11px 字。
 * 状态/演示一律中性描边（P02）；反馈标注用 annotation（--t-annotation）。
 */
export type BadgeTone = 'neutral' | 'success' | 'warn' | 'danger' | 'annotation'

export const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'border-border text-text-tertiary',
  success: 'border-success/45 text-success',
  warn: 'border-warning/45 text-warning',
  danger: 'border-danger/45 text-danger',
  annotation: 'border-annotation/45 text-annotation',
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  icon?: ReactNode
}

export function Badge({ tone = 'neutral', icon, className, children, ...rest }: BadgeProps) {
  return (
    <span
      data-badge=""
      data-tone={tone}
      className={cn(
        'inline-flex h-5 min-w-0 shrink-0 items-center gap-1 rounded-[4px] border bg-transparent px-1.5 text-[11px] font-medium leading-[1.2] whitespace-nowrap [&_svg]:size-3',
        BADGE_TONE_CLASS[tone],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </span>
  )
}
