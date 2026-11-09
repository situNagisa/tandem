import { cn } from '../../lib/cn'
import { EmptyState } from '../ui/EmptyState'
import { formatTokens } from '../../lib/format'
import { quotaLine } from '../../lib/quota'
import {
  CONTEXT_PART_META,
  CONTEXT_PART_ORDER,
  ContextSpaceSection,
  jumpToMessage,
  useContextBreakdown,
} from '../chat/ContextMeter'

export type ContextBreakdownData = ReturnType<typeof useContextBreakdown>

/** 分类行：缺项的旧 Host 补 0，保持与 Claude Code /context 一致的顺序。 */
function contextRows(context: NonNullable<ContextBreakdownData['context']>, free: number) {
  const tokens = new Map(context.parts.map((part) => [part.kind, part.tokens]))
  return CONTEXT_PART_ORDER.map((kind) => ({
    kind,
    tokens: kind === 'free' ? free : Math.max(0, tokens.get(kind) ?? 0),
  }))
}

/** 右侧栏上下文卡片：与输入框上下文环同源，紧凑展示占用与分类（缓存指标只在用量卡）。 */
export function ContextCard({ data }: { data: ContextBreakdownData }) {
  const { context, noData, window, used, pct, turns } = data
  if (noData || !context) {
    return <EmptyState variant="plain" title={<>暂无上下文数据</>} />
  }
  const quota = quotaLine(context.quota)
  const free = Math.max(0, window - used)
  const rows = contextRows(context, free)
  const thresholdPct = context.autoCompact?.enabled
    ? Math.max(0, Math.min(100, Math.round(context.autoCompact.threshold * 100)))
    : null
  return (
    <div data-context-card>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[12px] tabular-nums text-text-soft">
          {formatTokens(used)} / {formatTokens(window)}
        </span>
        <span className="flex items-baseline gap-2">
          <span className="text-[12px] text-muted">{turns} 轮对话</span>
          <span className="font-mono text-[12px] tabular-nums text-muted">{pct}%</span>
        </span>
      </div>
      <div className="relative mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="flex h-full w-full gap-px">
          {rows.map((part) => {
            const width = (part.tokens / window) * 100
            if (width <= 0) return null
            const meta = CONTEXT_PART_META[part.kind]
            return (
              <div
                key={part.kind}
                data-tip={`${meta.label} ${formatTokens(part.tokens)}（${width < 1 ? '<1' : Math.round(width)}%）`}
                className="h-full shrink-0"
                style={{ width: `${width}%`, backgroundColor: meta.color }}
              />
            )
          })}
        </div>
        {thresholdPct !== null ? (
          <span
            data-context-threshold="true"
            data-tip={`自动压缩阈值 ${thresholdPct}%`}
            aria-hidden="true"
            className="absolute -top-0.5 -bottom-0.5 w-[2px] rounded-full bg-[var(--t-bg)] shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
            style={{ left: `calc(${thresholdPct}% - 1px)` }}
          />
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1" data-context-legend="true">
        {rows.map((part) => {
          const meta = CONTEXT_PART_META[part.kind]
          const empty = part.kind !== 'free' && part.tokens <= 0
          return (
            <div
              key={part.kind}
              className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4"
            >
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-[2px]"
                style={{
                  backgroundColor: meta.color,
                  opacity: empty ? 0.4 : 1,
                }}
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  empty || part.kind === 'free' ? 'text-muted' : 'text-text-soft',
                )}
              >
                {meta.label}
              </span>
              <span
                className={cn(
                  'shrink-0 font-mono tabular-nums',
                  empty || part.kind === 'free' ? 'text-muted' : 'text-text-soft',
                )}
              >
                {formatTokens(part.tokens)}
              </span>
            </div>
          )
        })}
      </div>
      {quota && (
        <div
          className="mt-2 border-t border-border pt-1.5 text-[12px] leading-4 text-muted"
          data-quota-line="context"
        >
          {quota}
        </div>
      )}
      <div className="mt-2 border-t border-border pt-1.5" data-context-top="card">
        <ContextSpaceSection
          turns={context.topTurns}
          legacyItems={context.topItems}
          totalTokens={used}
          onJump={(messageId) => jumpToMessage(messageId)}
        />
        {context.autoCompact ? (
          <div
            data-context-autocompact="true"
            className="mt-2 flex items-center gap-1.5 text-[12px] leading-4 text-muted"
          >
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-px shrink-0 bg-[var(--t-text-tertiary)]"
            />
            <span>
              {context.autoCompact.enabled
                ? `自动压缩：达到 ${thresholdPct ?? Math.round(context.autoCompact.threshold * 100)}% 时触发`
                : '自动压缩已关闭'}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
