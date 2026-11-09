import { cn } from '../../lib/cn'
import { formatTokens } from '../../lib/format'
import { quotaLine } from '../../lib/quota'
import { CONTEXT_PART_META, ContextSpaceSection, jumpToMessage, useContextBreakdown } from '../chat/ContextMeter'

export function ContextCard() {
  const { context, noData, window, used, pct, turns } = useContextBreakdown()
  if (noData || !context) {
    return <p className="text-[12px] leading-4 text-muted">暂无上下文数据</p>
  }
  const quota = quotaLine(context.quota)
  const parts = context.parts.filter((part) => part.kind !== 'free')
  const free = Math.max(0, window - used)
  const rows = [...parts, { kind: 'free' as const, tokens: free }]
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[12px] tabular-nums text-text-soft">
          {formatTokens(used)} / {formatTokens(window)}
        </span>
        <span className="flex items-baseline gap-2">
          <span className="text-[12px] text-muted">{turns} 轮对话</span>
          <span className="font-mono text-[12px] tabular-nums text-muted">{pct}%</span>
        </span>
      </div>
      <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
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
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {rows.map((part) => {
          const meta = CONTEXT_PART_META[part.kind]
          return (
            <div
              key={part.kind}
              className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4"
            >
              <span
                className="size-1.5 shrink-0 rounded-[2px] border border-border/60"
                style={{ backgroundColor: part.kind === 'free' ? 'transparent' : meta.color }}
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  part.kind === 'free' ? 'text-muted' : 'text-text-soft',
                )}
              >
                {meta.label}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-text-soft">
                {formatTokens(part.tokens)}
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-1.5 text-[12px]">
        <span className="text-muted">缓存命中率</span>
        <span className="font-mono tabular-nums text-text-soft">
          {context.cacheHitRate !== undefined
            ? `${Math.round(context.cacheHitRate * 100)}%`
            : '—'}
        </span>
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
          onJump={(messageId) => jumpToMessage(messageId)}
        />
        {context.autoCompact ? (
          <div className="mt-2 text-[12px] text-muted">
            {context.autoCompact.enabled
              ? `下次自动压缩将在约 ${Math.round(context.autoCompact.threshold * 100)}% 时触发`
              : '自动压缩已关闭'}
          </div>
        ) : null}
      </div>
    </div>
  )
}

