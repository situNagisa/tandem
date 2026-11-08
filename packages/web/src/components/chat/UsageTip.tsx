import { useState, type ReactNode } from 'react'
import type { Usage } from '@tandem/protocol'
import { formatCost } from '../../lib/format'
import { Popover } from '../ui/Popover'

const COLUMNS = ['输入', '输出', '缓存读', '缓存写', '花费'] as const

function token(value?: number): string {
  return Math.round(value ?? 0).toLocaleString('en-US')
}

function rowValues(usage: Usage | undefined): string[] {
  return [
    token(usage?.inputTokens),
    token(usage?.outputTokens),
    token(usage?.cacheReadTokens),
    token(usage?.cacheWriteTokens),
    formatCost(usage?.costUsd),
  ]
}

/**
 * 消息操作条上的用量：悬停展开小表格（本轮 / 本会话 × 输入 / 输出 / 缓存读 / 缓存写 / 花费）。
 * 使用统一 Popover（Portal + 边界避让），不改动 ui/Tooltip 的纯文本接口。
 */
export function UsageTip({
  usage,
  sessionUsage,
  children,
}: {
  usage: Usage
  sessionUsage?: Usage
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const rows: Array<{ label: string; values: string[] }> = [
    { label: '本轮', values: rowValues(usage) },
    { label: '本会话', values: rowValues(sessionUsage ?? usage) },
  ]

  return (
    <Popover
      align="right"
      side="top"
      padded={false}
      open={open}
      onOpenChange={setOpen}
      className="ml-auto"
      trigger={() => (
        <span
          tabIndex={0}
          data-usage-summary
          aria-label="用量明细"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          className="flex cursor-default items-center rounded px-1 py-0.5 font-mono text-[12px] tabular-nums text-muted outline-none transition-colors hover:text-text-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--t-focus-ring)]"
        >
          {children}
        </span>
      )}
    >
      {() => (
        <div className="p-2" data-usage-table>
          <table className="border-separate border-spacing-x-3 border-spacing-y-1 text-[12px] tabular-nums">
            <thead>
              <tr>
                <th aria-hidden className="w-10" />
                {COLUMNS.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="text-right text-[12px] font-normal text-text-tertiary"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row" className="text-left text-[12px] font-normal text-text-tertiary">
                    {row.label}
                  </th>
                  {row.values.map((value, index) => (
                    <td
                      key={COLUMNS[index]}
                      className="text-right font-mono text-[12px] text-text-soft"
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Popover>
  )
}
