import type { ReactNode } from 'react'

/**
 * 消息操作条上的用量行：只显示一行小字（本轮输入/输出/缓存/花费）。
 * 用户反馈 #7-03：本会话用量在右侧栏可见，不再提供悬停明细浮层。
 */
export function UsageLine({ children }: { children: ReactNode }) {
  return (
    <span
      data-usage-summary
      className="flex cursor-default items-center rounded px-1 py-0.5 font-mono text-[12px] tabular-nums text-muted"
    >
      {children}
    </span>
  )
}
