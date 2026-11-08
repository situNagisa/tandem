import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'

/**
 * 事件聚合行：行主体负责导航（点击打开对应会话/看板），右侧独立箭头只负责展开明细。
 * 收件箱「最近」等聚合列表统一使用，避免再把展开动作绑在整行上。
 */
export function AggregateRow({
  icon,
  title,
  titleText,
  meta,
  time,
  body,
  expandable = false,
  expanded = false,
  detailCount,
  onOpen,
  onToggle,
  testId = 'aggregate-row',
  className,
  iconClassName,
  children,
}: {
  icon: ReactNode
  title: ReactNode
  titleText?: string
  meta?: ReactNode
  time?: ReactNode
  body?: ReactNode
  expandable?: boolean
  expanded?: boolean
  detailCount?: number
  onOpen?: () => void
  onToggle?: () => void
  testId?: string
  className?: string
  iconClassName?: string
  children?: ReactNode
}) {
  return (
    <div data-testid={testId} className={className}>
      <div className="flex items-start rounded-lg transition-colors hover:bg-[var(--t-bg-hover)]">
        <button
          type="button"
          onClick={onOpen}
          disabled={!onOpen}
          data-testid="aggregate-open"
          title={titleText}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-2 py-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--t-accent-strong)] disabled:cursor-default"
        >
          <span
            className={cn(
              'mt-0.5 flex size-5 shrink-0 items-center justify-center',
              iconClassName ?? 'text-text-soft',
            )}
          >
            {icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">
                {title}
              </span>
              {time ? <span className="shrink-0 text-[12px] text-muted">{time}</span> : null}
            </span>
            {meta ? (
              <span className="mt-0.5 flex min-w-0 gap-1.5 text-[12px] text-muted">{meta}</span>
            ) : null}
            {body ? <span className="mt-0.5 block truncate text-[12px] text-muted">{body}</span> : null}
          </span>
        </button>
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? '收起明细' : `展开明细${detailCount ? `（${detailCount} 条）` : ''}`}
            data-testid="aggregate-toggle"
            className="mt-0.5 flex shrink-0 items-center gap-1 rounded-md px-2 py-2 text-[12px] text-muted outline-none transition-colors hover:bg-[var(--t-bg-active)] hover:text-text focus-visible:outline-2 focus-visible:outline-[var(--t-accent-strong)]"
          >
            {detailCount ? <span className="tabular-nums">{detailCount}</span> : null}
            <ChevronDown
              size={13}
              className={cn('transition-transform', expanded && 'rotate-180')}
            />
          </button>
        ) : null}
      </div>
      {expanded ? children : null}
    </div>
  )
}

/** 聚合行展开后的明细项：整条可点，跳到会话里对应的工具卡/回合。 */
export function AggregateDetailRow({
  icon,
  title,
  titleText,
  time,
  body,
  onOpen,
  testId = 'aggregate-detail',
}: {
  icon: ReactNode
  title: ReactNode
  titleText?: string
  time?: ReactNode
  body?: ReactNode
  onOpen?: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      data-testid={testId}
      title={titleText}
      className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left text-[12px] transition-colors hover:bg-[var(--t-bg-hover)] focus-visible:bg-[var(--t-bg-hover)] focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="mt-px shrink-0 text-text-tertiary">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-text-soft">{title}</span>
          {time ? <span className="ml-auto shrink-0 text-muted">{time}</span> : null}
        </span>
        {body ? <span className="mt-0.5 block truncate text-muted">{body}</span> : null}
      </span>
    </button>
  )
}
