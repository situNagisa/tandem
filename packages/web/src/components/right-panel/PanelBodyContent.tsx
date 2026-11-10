import { Circle, CircleCheck, CircleDot } from 'lucide-react'
import type { MemoryFile, SessionSummary, Todo } from '@tandem/protocol'
import type { ConnectionState } from '../../lib/types'
import { prettyModel } from '../../lib/modelName'
import { quotaLine } from '../../lib/quota'
import { cn } from '../../lib/cn'
import { formatCost, formatTokens } from '../../lib/format'
import { EmptyState } from '../ui/EmptyState'
import { Button } from '../ui/Button'
import { Markdown } from '../Markdown'
import { Spinner } from '../ui/Spinner'
import { AgentsCard } from './AgentsCard'
import { ContextCard } from './ContextCard'
import { WikiCard } from './WikiCard'
import { SessionGraphCard } from '../sessionGraph/SessionGraphCard'
import type { useContextBreakdown } from '../chat/ContextMeter'
import { CHANGE_MARK, type GroupId } from './shared'
import { PanelDetails } from './PanelDetails'

interface PanelBodyContentProps {
  id: GroupId
  memoryLoading: boolean
  memory: MemoryFile | null
  memoryPreview: string[]
  openMemoryEditor: (target: { scope: 'global' | 'project'; project?: string }) => void
  plan: { content: string } | null
  todos: Todo[]
  progress: number
  usageHasData: boolean
  usage: SessionSummary['usage'] | undefined
  summary: SessionSummary | null
  subUsage: { count: number; cost: number; tokens: number; byModel: Array<[string, { cost: number }]> }
  reviewUsage: NonNullable<SessionSummary['aiReviewUsage']> | undefined
  keyUsage: string | null
  fileChanges: Array<{ path: string; status: string; additions: number; deletions: number }>
  additions: number
  deletions: number
  contextData: ReturnType<typeof useContextBreakdown>
  profileName: string | null
  profilesLoaded: boolean
  copyCwd: () => void
  copied: boolean
  hostStatus: ConnectionState
  host: { name: string } | null
  openSettings: (tab: 'secrets') => void
}

export function PanelBodyContent({
  id,
  memoryLoading,
  memory,
  memoryPreview,
  openMemoryEditor,
  plan,
  todos,
  progress,
  usageHasData,
  usage,
  summary,
  subUsage,
  reviewUsage,
  keyUsage,
  fileChanges,
  additions,
  deletions,
  contextData,
  profileName,
  profilesLoaded,
  copyCwd,
  copied,
  hostStatus,
  host,
  openSettings,
}: PanelBodyContentProps) {
  const TODO_ICONS = {
    completed: CircleCheck,
    in_progress: CircleDot,
    pending: Circle,
  } as const
    if (id === 'memory') {
      if (memoryLoading && !memory) {
        return (
          <p className="flex items-center gap-1.5 text-[12px] text-muted">
            <Spinner size={11} /> 读取中…
          </p>
        )
      }
      return (
        <div>
          {memoryPreview.length > 0 ? (
            <ul className="space-y-1 text-[12px] leading-[18px] text-text-soft">
              {memoryPreview.map((line, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--t-text-tertiary)]" />
                  <span className="min-w-0 truncate">{line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState variant="plain" title={<>暂无记忆。输入「#记住 …」或让 agent 记录长期事实。</>} />
          )}
          <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-1.5 text-[12px]">
            <span className="text-muted">共 {memory?.entries ?? 0} 条</span>
            <Button size="inline" variant="ghost" onClick={() => openMemoryEditor({ scope: 'global' })}>
              全局记忆
            </Button>
          </div>
        </div>
      )
    }
    if (id === 'plan') {
      if (!plan) return <EmptyState variant="plain" title={<>暂无计划</>} />
      return (
        <div className="max-h-[180px] overflow-y-auto rounded-md border border-border/70 bg-bg/25 px-2.5 py-2 text-[13px] leading-[18px]">
          <Markdown text={plan.content} />
        </div>
      )
    }
    if (id === 'agents') {
      return <AgentsCard />
    }
    if (id === 'graph') {
      return <SessionGraphCard />
    }
    if (id === 'wiki') {
      return <WikiCard />
    }
    if (id === 'context') {
      return <ContextCard data={contextData} />
    }
    if (id === 'todos') {
      if (todos.length === 0) return <EmptyState variant="plain" title={<>暂无待办</>} />
      return (
        <>
          <div className="mb-2 h-0.5 overflow-hidden rounded-full bg-[var(--t-bg-active)]/60">
            <div
              className="h-full rounded-full bg-[var(--t-text-tertiary)]/70 transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <ul className="space-y-1.5">
            {todos.map((t, i) => {
              const Icon = TODO_ICONS[t.status] ?? Circle
              return (
                <li key={i} className="flex items-start gap-2 text-[12px] leading-[18px]">
                  <Icon
                    size={12}
                    className={cn(
                      'mt-[3px] shrink-0',
                      t.status === 'in_progress' ? 'text-text-secondary' : 'text-muted',
                    )}
                  />
                  <span
                    className={cn(
                      'min-w-0',
                      t.status === 'completed'
                        ? 'text-muted line-through'
                        : t.status === 'in_progress'
                          ? 'text-text'
                          : 'text-text-soft',
                    )}
                  >
                    {t.content}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )
    }
    if (id === 'usage') {
      if (!usageHasData) {
        return <EmptyState variant="plain" title={<>暂无用量</>} />
      }
      const cacheRead = usage?.cacheReadTokens ?? 0
      const cacheWrite = usage?.cacheWriteTokens ?? 0
      const inputTotal = (usage?.inputTokens ?? 0) + cacheRead + cacheWrite
      const hitRate = inputTotal > 0 ? cacheRead / inputTotal : undefined
      const stats = [
        { label: '输入', value: formatTokens(usage?.inputTokens ?? 0) },
        { label: '输出', value: formatTokens(usage?.outputTokens ?? 0) },
        { label: '缓存读', value: formatTokens(cacheRead) },
        { label: '缓存写', value: formatTokens(cacheWrite) },
      ]
      const quota = quotaLine(summary?.quota)
      return (
        <div>
          <div className="text-[12px] text-muted">总花费</div>
          <div className="mt-0.5 font-mono text-[19px] leading-6 tabular-nums text-text">
            {formatCost(usage?.costUsd)}
          </div>
          {summary?.autoRoute && (summary.routeSavings?.savedUsd ?? 0) > 0 && (
            <div className="mt-1 text-[12px] leading-4 text-muted" data-route-savings>
              自动路由节省约 {formatCost(summary.routeSavings?.savedUsd)}
              {summary.routeSavings?.baselineModel
                ? `（对比全程使用强力档 ${prettyModel(summary.routeSavings.baselineModel)}）`
                : '（对比全程使用强力档）'}
            </div>
          )}
          {summary?.routeSavings?.byRole && (
            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[12px] leading-4 text-muted" data-route-roles>
              {Object.entries(summary.routeSavings.byRole).map(([role, value]) => (
                <span key={role}>
                  {role === 'planner'
                    ? '规划'
                    : role === 'executor'
                      ? '执行'
                      : role === 'specialist'
                        ? '专长'
                        : '审查'}{' '}
                  {formatCost(value.costUsd)}
                  {value.savedUsd > 0 ? ` · 省 ${formatCost(value.savedUsd)}` : ''}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
            {stats.map((s) => (
              <div key={s.label} className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="text-[12px] text-muted">{s.label}</span>
                <span className="truncate font-mono text-[13px] tabular-nums text-text-soft">
                  {s.value}
                </span>
              </div>
            ))}
          </div>
          {quota && (
            <div
              className="mt-2 border-t border-border pt-1.5 text-[12px] leading-4 text-muted"
              data-quota-line="usage"
            >
              {quota}
            </div>
          )}
          {subUsage.count > 0 && (
            <div className="mt-2 space-y-1 border-t border-border pt-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] text-muted">
                  子代理（{subUsage.count}）
                </span>
                <span className="font-mono text-[13px] tabular-nums text-text-soft">
                  {formatCost(subUsage.cost)} · {formatTokens(subUsage.tokens)} tok
                </span>
              </div>
              {subUsage.byModel.map(([model, item]) => (
                <div key={model} className="flex min-w-0 items-baseline justify-between gap-2 pl-2">
                  <span className="min-w-0 truncate font-mono text-[12px] text-muted" data-tip={model}>
                    {model}
                  </span>
                  <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted">
                    {formatCost(item.cost)}
                  </span>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] text-muted">合计</span>
                <span className="font-mono text-[13px] tabular-nums text-text">
                  {formatCost((usage?.costUsd ?? 0) + subUsage.cost)}
                </span>
              </div>
            </div>
          )}
          {reviewUsage && (
            <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-1.5">
              <span className="text-[12px] text-muted">AI 评审</span>
              <span className="font-mono text-[13px] tabular-nums text-text-soft">
                {formatCost(reviewUsage.costUsd)} ·{' '}
                {formatTokens(reviewUsage.inputTokens + reviewUsage.outputTokens)} tok
              </span>
            </div>
          )}
          {keyUsage && (
            <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-1.5">
              <span className="shrink-0 text-[12px] text-muted">Key</span>
              <span className="min-w-0 truncate font-mono text-[13px] tabular-nums text-text-soft">
                {keyUsage}
              </span>
            </div>
          )}
          <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-1.5">
            <span className="text-[12px] text-muted">缓存命中率</span>
            <span className="font-mono text-[13px] tabular-nums text-text-soft">
              {hitRate !== undefined ? `${Math.round(hitRate * 100)}%` : '—'}
            </span>
          </div>
        </div>
      )
    }
    if (id === 'changes') {
      if (fileChanges.length === 0) {
        return <EmptyState variant="plain" title={<>暂无改动</>} />
      }
      return (
        <>
          <div className="mb-1.5 flex items-baseline gap-2 text-[12px] text-text-soft">
            <span className="tabular-nums">{fileChanges.length} 个文件</span>
            <span className="flex-1" />
            <span className="font-mono text-[12px] tabular-nums text-muted">
              +{additions} −{deletions}
            </span>
          </div>
          <div className="space-y-px">
            {fileChanges.slice(0, 4).map((f) => (
              <div key={f.path} className="flex min-w-0 items-center gap-1.5 text-[12px] leading-[17px]">
                <span className="w-2.5 shrink-0 font-mono text-[12px] text-muted">
                  {CHANGE_MARK[f.status] ?? 'M'}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-text-soft" data-tip={f.path}>
                  {f.path}
                </span>
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted">
                  +{f.additions} −{f.deletions}
                </span>
              </div>
            ))}
            {fileChanges.length > 4 && (
              <div className="pt-0.5 text-[12px] text-muted">还有 {fileChanges.length - 4} 个文件</div>
            )}
          </div>
        </>
      )
    }
  return (
    <PanelDetails
      summary={summary}
      profileName={profileName}
      profilesLoaded={profilesLoaded}
      copyCwd={copyCwd}
      copied={copied}
      hostStatus={hostStatus}
      host={host}
      openSettings={openSettings}
    />
  )
}
