import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface EmptyStateProps {
  /** 30px 图标槽（实际 svg 建议 17–18px）。 */
  icon?: ReactNode
  title: ReactNode
  hint?: ReactNode
  /** 28px 高的动作按钮（通常传 Button）。 */
  action?: ReactNode
  /**
   * framed：独立空状态的虚线框（默认）。
   * plain：卡片内部的纯文字空态，不画框，避免右栏卡片被撑高。
   */
  variant?: 'framed' | 'plain'
  className?: string
}

/** 统一空状态（打分卡 U4-A）：虚线框、20px 内边距、30px 图标、13/12 两级文字。 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  variant = 'framed',
  className,
}: EmptyStateProps) {
  const plain = variant === 'plain'
  return (
    <div
      data-empty-state=""
      data-variant={variant}
      className={cn(
        'flex min-w-0 flex-col items-center justify-center text-center',
        plain
          ? 'gap-1 px-1 py-2 text-[12px] leading-5 text-muted'
          : 'rounded-[10px] border border-dashed border-border px-4 py-5',
        className,
      )}
    >
      {icon && !plain ? (
        <span className="flex size-[30px] items-center justify-center rounded-lg bg-[var(--t-bg-active)] text-text-soft [&_svg]:size-[18px]">
          {icon}
        </span>
      ) : null}
      <div className={cn(plain ? undefined : 'mt-2 text-[13px] font-medium text-text-soft')}>
        {title}
      </div>
      {hint ? (
        <p
          className={cn(
            'text-[12px] leading-[1.6] text-muted',
            plain ? 'mt-0.5' : 'mx-auto mt-1 max-w-[380px]',
          )}
        >
          {hint}
        </p>
      ) : null}
      {action ? (
        <div className={cn('flex items-center justify-center', plain ? 'mt-1.5' : 'mt-2.5')}>
          {action}
        </div>
      ) : null}
    </div>
  )
}
