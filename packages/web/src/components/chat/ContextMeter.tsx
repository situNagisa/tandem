// 上下文环与 /context 面板：按请求实际发送的组成展示 token 占用。
import { useEffect, useState } from 'react'
import type { ContextBreakdown } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { formatTokens } from '../../lib/format'
import { Popover } from '../ui/Popover'
import { Tip } from '../ui/Tooltip'

export const CONTEXT_PART_META: Record<
  ContextBreakdown['parts'][number]['kind'],
  { label: string; color: string }
> = {
  system: { label: '系统提示', color: '#8d9db6' },
  tools: { label: '工具定义', color: '#9b8bb4' },
  mcp: { label: 'MCP 工具', color: '#7fa896' },
  memory: { label: '记忆文件', color: '#c3a878' },
  messages: { label: '对话', color: '#7c9fb3' },
  tool_results: { label: '工具结果', color: '#b08a80' },
  free: { label: '剩余', color: 'transparent' },
}

function colorFor(rate: number): string {
  if (rate > 0.9) return 'var(--t-danger)'
  if (rate >= 0.7) return '#d08a45'
  return 'var(--t-text-secondary)'
}

/** 上下文占用的共享数据源：输入框上下文环与右侧栏上下文卡片共用。 */
export function useContextBreakdown() {
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const live = useAppStore((s) => s.active?.summary?.context)
  const usage = useAppStore((s) => s.active?.summary?.usage)
  const messageCount = useAppStore((s) => s.active?.messages.length ?? 0)
  const [fetched, setFetched] = useState<ContextBreakdown | null>(null)

  useEffect(() => {
    setFetched(null)
    if (!hostId || !sessionId) return
    const host = useAppStore.getState().hosts.find((h) => h.id === hostId)
    if (!host) return
    let cancelled = false
    void api
      .context(host, sessionId)
      .then((value) => {
        if (!cancelled) setFetched(value)
      })
      .catch(() => {
        // 旧 Host 没有该接口时静默隐藏面板数据
      })
    return () => {
      cancelled = true
    }
  }, [hostId, sessionId])

  const context = live ?? fetched
  const usageTotal = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  // 新会话只有系统提示/工具的粗略估算，没有真实请求数据：显示静态空环，避免像加载中
  const noData = !context || (messageCount === 0 && usageTotal === 0)
  const window = Math.max(1, context?.contextWindow || 1)
  const used = noData ? 0 : Math.max(0, context?.usedTokens || 0)
  const rate = noData ? 0 : Math.min(1, used / window)
  return {
    sessionId,
    context,
    usage,
    noData,
    window,
    used,
    rate,
    pct: Math.round(rate * 100),
  }
}

export function ContextMeter({ compactDisabled }: { compactDisabled?: boolean }) {
  const { sessionId, context, usage, noData, window, used, rate, pct } =
    useContextBreakdown()
  const send = useAppStore((s) => s.send)
  const running = useAppStore((s) => s.active?.running ?? false)

  if (!sessionId) return null

  const stroke = colorFor(rate)
  const circumference = 2 * Math.PI * 6.5

  const compact = (close: () => void) => {
    if (running || compactDisabled) return
    if (send([{ type: 'text', text: '/compact' }])) close()
  }

  return (
    <Popover
      align="right"
      side="top"
      padded={false}
      panelClassName="w-[min(92vw,352px)] p-3"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={noData ? '暂无上下文数据' : `上下文 ${pct}%`}
          className="relative flex size-7 shrink-0 items-center justify-center rounded-md text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text max-sm:size-11"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" data-empty={noData || undefined}>
            <circle cx="9" cy="9" r="6.5" fill="none" stroke="var(--t-border)" strokeWidth="2.4" />
            {rate > 0 && (
              <circle
                cx="9"
                cy="9"
                r="6.5"
                fill="none"
                stroke={stroke}
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeDasharray={`${circumference * rate} ${circumference}`}
                transform="rotate(-90 9 9)"
              />
            )}
          </svg>
          {!open && (
            <Tip
              label={
                noData
                  ? '暂无上下文数据'
                  : `上下文 ${pct}% · ${formatTokens(used)} / ${formatTokens(window)}`
              }
              side="top"
            />
          )}
        </button>
      )}
    >
      {(close) => {
        if (noData || !context) {
          return (
            <div className="flex items-baseline gap-2 text-[12px]">
              <span className="font-medium text-text">上下文</span>
              <span className="text-muted">暂无上下文数据</span>
              <span className="ml-auto font-mono text-[12px] tabular-nums text-muted">0%</span>
            </div>
          )
        }
        const parts = context.parts.filter((part) => part.kind !== 'free')
        const free = Math.max(0, window - used)
        const rows = [...parts, { kind: 'free' as const, tokens: free }]
        return (
          <div>
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-[12px] font-medium text-text">上下文</span>
              <span className="font-mono text-[12px] tabular-nums text-text-soft">
                {formatTokens(used)} / {formatTokens(window)}
              </span>
              <span className="ml-auto text-[12px] tabular-nums text-muted">{pct}%</span>
            </div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
              {rows.map((part) => {
                const width = (part.tokens / window) * 100
                if (width <= 0) return null
                const meta = CONTEXT_PART_META[part.kind]
                return (
                  <div
                    key={part.kind}
                    title={`${meta.label} ${formatTokens(part.tokens)}`}
                    style={{
                      width: `${width}%`,
                      backgroundColor: meta.color,
                      opacity: part.kind === 'free' ? 1 : 0.88,
                    }}
                    className={cn(part.kind === 'free' && 'bg-[var(--t-surface-2)]')}
                  />
                )
              })}
            </div>
            <div className="mt-2.5 space-y-1">
              {rows.map((part) => {
                const meta = CONTEXT_PART_META[part.kind]
                const share = window > 0 ? (part.tokens / window) * 100 : 0
                return (
                  <div key={part.kind} className="flex items-center gap-2 text-[12px] leading-4">
                    <span
                      className="size-2 shrink-0 rounded-[2px] border border-border/60"
                      style={{
                        backgroundColor: part.kind === 'free' ? 'transparent' : meta.color,
                      }}
                    />
                    <span className={cn('min-w-0 flex-1', part.kind === 'free' ? 'text-muted' : 'text-text-soft')}>
                      {meta.label}
                    </span>
                    <span className="font-mono tabular-nums text-text">{formatTokens(part.tokens)}</span>
                    <span className="w-9 text-right font-mono tabular-nums text-muted">
                      {share < 1 && share > 0 ? '<1' : Math.round(share)}%
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-2 text-[12px] text-muted">
              <span>
                缓存命中率{' '}
                <span className="font-mono tabular-nums text-text-soft">
                  {context.cacheHitRate !== undefined ? `${Math.round(context.cacheHitRate * 100)}%` : '—'}
                </span>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                读{' '}
                <span className="font-mono tabular-nums text-text-soft">
                  {formatTokens(usage?.cacheReadTokens ?? 0)}
                </span>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                写{' '}
                <span className="font-mono tabular-nums text-text-soft">
                  {formatTokens(usage?.cacheWriteTokens ?? 0)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => compact(close)}
                disabled={running || compactDisabled}
                className="ml-auto rounded-md px-1.5 py-0.5 text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:pointer-events-none disabled:opacity-40"
              >
                压缩上下文（/compact）
              </button>
            </div>
          </div>
        )
      }}
    </Popover>
  )
}
