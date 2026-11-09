import type { ReactNode } from 'react'
import { formatDurationMs, formatFullTime, formatMessageTime } from '../../lib/format'
import { Tooltip } from '../ui/Tooltip'

/**
 * 消息操作条上的用量行：只显示一行小字（本轮输入/输出/缓存/花费）。
 * 用户反馈 #7-03：本会话用量在右侧栏可见，不再提供悬停明细浮层。
 */
export function UsageLine({
  children,
  kind = 'assistant',
}: {
  children: ReactNode
  /** 用户消息的用量行用独立标记，避免和 assistant 用量行的回归断言混用。 */
  kind?: 'assistant' | 'user'
}) {
  return (
    <span
      {...(kind === 'assistant' ? { 'data-usage-summary': true } : { 'data-user-usage': true })}
      className="inline-block cursor-default whitespace-nowrap rounded px-1 py-0.5 font-mono text-[12px] leading-4 tabular-nums text-muted"
    >
      {children}
    </span>
  )
}

/** 消息时间：常显，悬停显示完整日期时间与耗时。 */
export function MessageTime({
  createdAt,
  durationMs,
}: {
  createdAt?: number
  durationMs?: number
}) {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
  const tip = [
    formatFullTime(createdAt),
    typeof durationMs === 'number' ? `耗时 ${formatDurationMs(durationMs)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Tooltip label={tip} className="shrink-0">
      <span data-msg-time="">{formatMessageTime(createdAt)}</span>
    </Tooltip>
  )
}
