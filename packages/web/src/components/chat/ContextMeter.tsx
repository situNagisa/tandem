// 上下文环与 /context 面板：按请求实际发送的组成展示 token 占用。
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { countTurns, isSystemInjectionText } from '@tandem/protocol'
import type { ContextBreakdown, ContextTopItem, ContextTurnItem } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { useSessionTarget, useSessionView } from '../session/SessionScope'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { formatTokens } from '../../lib/format'
import { readRaw, writeRaw } from '../../lib/storage'
import { Popover } from '../ui/Popover'
import { Tip } from '../ui/Tooltip'

export const CONTEXT_PART_ORDER = [
  'system',
  'tools',
  'mcp',
  'agents',
  'memory',
  'messages',
  'tool_results',
  'free',
] as const

export const CONTEXT_PART_META: Record<
  ContextBreakdown['parts'][number]['kind'],
  { label: string; color: string }
> = {
  system: { label: '系统提示', color: 'var(--ctx-system)' },
  tools: { label: '工具定义', color: 'var(--ctx-tools)' },
  mcp: { label: 'MCP 工具', color: 'var(--ctx-mcp)' },
  agents: { label: '自定义 agents', color: 'var(--ctx-agents)' },
  memory: { label: '记忆文件', color: 'var(--ctx-memory)' },
  messages: { label: '对话', color: 'var(--ctx-messages)' },
  tool_results: { label: '工具结果', color: 'var(--ctx-tool-results)' },
  free: { label: '剩余', color: 'var(--ctx-free)' },
}

function colorFor(rate: number): string {
  if (rate > 0.9) return 'var(--t-danger)'
  if (rate >= 0.7) return 'var(--t-status-warn)'
  return 'var(--t-text-secondary)'
}

/** 让消息列表把某条消息滚到视口中部（消息可能还没挂载，由 MessageList 负责补窗口）。 */
export function jumpToMessage(messageId: string): void {
  window.dispatchEvent(new CustomEvent('tandem-jump-message', { detail: { messageId } }))
}

const TOP_COLLAPSED_KEY = 'tandem.contextTopCollapsed.v1'

function loadTopCollapsed(): boolean {
  return readRaw(TOP_COLLAPSED_KEY) === '1'
}

/** 老 Host 只给逐条 topItems：按轮次合并成近似列表（只有最大 10 条，量级供参考）。 */
function turnsFromItems(items?: ContextTopItem[]): ContextTurnItem[] {
  if (!items || items.length === 0) return []
  const grouped = new Map<number, ContextTopItem[]>()
  for (const item of items) {
    // 老 Host 的逐条清单里，外部会话注入的系统提示不当作一轮（反馈16#05）。
    if (item.role === 'user' && item.kind === 'message' && isSystemInjectionText(item.preview)) {
      continue
    }
    const list = grouped.get(item.turn)
    if (list) list.push(item)
    else grouped.set(item.turn, [item])
  }
  return [...grouped.entries()]
    .map(([turn, list]) => {
      const sorted = [...list].sort((a, b) => b.tokens - a.tokens)
      return {
        turn,
        messageId: sorted[0]!.messageId,
        tokens: list.reduce((sum, item) => sum + item.tokens, 0),
        preview: sorted[0]!.preview,
        items: sorted.slice(0, 5),
      }
    })
    .sort((a, b) => b.tokens - a.tokens)
}

/**
 * 「最占空间」：以用户发言（轮次）为基本单位，按占用降序；点整行跳到该轮，
 * 右侧箭头展开该轮内最大的几项。整个区块可折叠，状态记在 localStorage。
 */
export function ContextSpaceSection({
  turns,
  legacyItems,
  onJump,
  totalTokens,
}: {
  turns?: ContextTurnItem[]
  legacyItems?: ContextTopItem[]
  onJump?: (messageId: string) => void
  /** 上下文已用 token，用来把每轮占比换算成小色条的深浅。 */
  totalTokens?: number
}) {
  const list = turns && turns.length > 0 ? turns : turnsFromItems(legacyItems)
  const total = totalTokens && totalTokens > 0 ? totalTokens : undefined
  const maxTurn = list.reduce((max, turn) => Math.max(max, turn.tokens), 0)
  const [collapsed, setCollapsed] = useState(loadTopCollapsed)
  const [expanded, setExpanded] = useState<string | null>(null)
  const jump = (messageId: string) => (onJump ? onJump(messageId) : jumpToMessage(messageId))
  const toggle = () => {
    setCollapsed((value) => {
      const next = !value
      writeRaw(TOP_COLLAPSED_KEY, next ? '1' : '0')
      return next
    })
  }
  return (
    <div>
      <button data-raw-button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        data-context-top-toggle="true"
        className="flex min-h-6 w-full min-w-0 items-center gap-1 rounded-md px-0.5 py-0.5 text-[12px] text-muted transition-colors hover:text-text"
      >
        <ChevronDown
          size={12}
          className={cn('shrink-0 transition-transform', collapsed && '-rotate-90')}
        />
        <span>最占空间</span>
        <span className="ml-auto shrink-0 tabular-nums">{list.length} 轮</span>
      </button>
      {collapsed ? null : list.length === 0 ? (
        <p className="px-1 py-0.5 text-[12px] text-muted">暂无占用明细（发送消息后显示）</p>
      ) : (
        <div className="mt-0.5 space-y-0.5">
          {list.map((turn) => {
            const open = expanded === turn.messageId
            const detail = turn.items.filter((item) => item.tokens > 0)
            const share = total ? turn.tokens / total : 0
            const strength = maxTurn > 0 ? turn.tokens / maxTurn : 0
            const title = `${turn.preview}（第 ${turn.turn} 轮，${formatTokens(turn.tokens)}${share > 0 ? ` · 占 ${share < 0.01 ? '<1' : Math.round(share * 100)}%` : ''}）`
            return (
              <div
                key={`${turn.turn}:${turn.messageId}`}
                data-context-turn="true"
                data-turn-number={turn.turn}
                data-message-id={turn.messageId}
              >
                <div className="group/row flex min-h-6 items-center rounded-md transition-colors hover:bg-[var(--t-bg-hover)]">
                  <button data-raw-button
                    type="button"
                    data-context-turn-open="true"
                    onClick={() => jump(turn.messageId)}
                    data-tip={title}
                    className="flex min-h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 pl-0.5 pr-1 text-left text-[12px] leading-4 text-text-soft"
                  >
                    <span
                      data-context-turn-share="true"
                      aria-hidden="true"
                      className="h-3.5 w-[3px] shrink-0 rounded-full bg-[var(--ctx-messages)]"
                      style={{ opacity: 0.3 + strength * 0.7 }}
                    />
                    <span className="min-w-0 flex-1 truncate">{turn.preview}</span>
                    <span className="w-9 shrink-0 text-right font-mono tabular-nums">
                      {formatTokens(turn.tokens)}
                    </span>
                  </button>
                  {detail.length > 1 ? (
                    <button data-raw-button
                      type="button"
                      data-context-turn-toggle="true"
                      aria-expanded={open}
                      aria-label={`${open ? '收起' : '展开'}第 ${turn.turn} 轮占用明细`}
                      onClick={() => setExpanded(open ? null : turn.messageId)}
                      className={cn(
                        'mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted transition-[opacity,background-color,color] hover:bg-[var(--t-bg-active)] hover:text-text group-focus-within/row:opacity-100 focus-visible:opacity-100',
                        open ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100',
                      )}
                    >
                      <ChevronDown
                        size={11}
                        className={cn('transition-transform', open && 'rotate-180')}
                      />
                    </button>
                  ) : null}
                </div>
                {open ? (
                  <div className="ml-1.5 border-l border-border pl-1">
                    {detail.map((item, index) => (
                      <button data-raw-button
                        key={`${item.messageId}-${item.kind}-${index}`}
                        type="button"
                        data-context-nested="true"
                        onClick={() => jump(item.messageId)}
                        data-tip={item.preview}
                        className="flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] leading-4 text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text-soft"
                      >
                        <span className="shrink-0">
                          {item.kind === 'tool_result'
                            ? item.tool
                              ? `${item.tool} 输出`
                              : '工具结果'
                            : '消息'}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{item.preview}</span>
                        <span className="w-9 shrink-0 text-right font-mono tabular-nums">
                          {formatTokens(item.tokens)}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AutoCompactLine({ context }: { context: ContextBreakdown }) {
  if (!context.autoCompact) return null
  return (
    <div className="mt-2 text-[12px] text-muted">
      {context.autoCompact.enabled
        ? `下次自动压缩将在约 ${Math.round(context.autoCompact.threshold * 100)}% 时触发`
        : '自动压缩已关闭'}
    </div>
  )
}

/** 上下文占用的共享数据源：输入框上下文环与右侧栏上下文卡片共用。 */
export function useContextBreakdown() {
  const hostId = useSessionView((s) => s?.hostId ?? null)
  const sessionId = useSessionView((s) => s?.sessionId ?? null)
  const live = useSessionView((s) => s?.summary?.context)
  const usage = useSessionView((s) => s?.summary?.usage)
  const messages = useSessionView((s) => s?.messages)
  const messageCount = messages?.length ?? 0
  const turns = useMemo(() => countTurns(messages ?? []), [messages])
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
    turns,
  }
}

export function ContextMeter({ compactDisabled }: { compactDisabled?: boolean }) {
  const { sessionId, context, usage, noData, window, used, rate, pct, turns } =
    useContextBreakdown()
  const openCompactConfirm = useUiStore((s) => s.openCompactConfirm)
  const scopeTarget = useSessionTarget()
  const activeHostId = useAppStore((s) => s.active?.hostId ?? null)
  const activeSessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const running = useSessionView((s) => s?.running ?? false)

  if (!sessionId) return null

  const stroke = colorFor(rate)
  const circumference = 2 * Math.PI * 6.5

  const compact = (close: () => void) => {
    if (running || compactDisabled) return
    close()
    const target =
      scopeTarget ??
      (activeHostId && activeSessionId
        ? { hostId: activeHostId, sessionId: activeSessionId }
        : null)
    if (target) openCompactConfirm(target)
  }

  return (
    <Popover
      align="right"
      side="top"
      padded={false}
      panelWidth="min(92vw, 352px)"
      panelClassName="p-3"
      trigger={({ toggle, open }) => (
        <button data-raw-button
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
              <span className="text-[12px] text-muted">{turns} 轮对话</span>
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
                    data-tip={`${meta.label} ${formatTokens(part.tokens)}`}
                    style={{
                      width: `${width}%`,
                      backgroundColor: meta.color,
                    }}
                    className={cn(part.kind === 'free' && 'bg-[var(--ctx-free)]')}
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
            <div className="mt-2.5 border-t border-border pt-2" data-context-top="popover">
              <ContextSpaceSection
                turns={context.topTurns}
                legacyItems={context.topItems}
                totalTokens={used}
                onJump={(messageId) => {
                  close()
                  jumpToMessage(messageId)
                }}
              />
              <AutoCompactLine context={context} />
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
              <button data-raw-button
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
