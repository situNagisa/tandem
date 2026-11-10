import type { ReactNode } from 'react'
import type { MemoryFile, Todo } from '@tandem/protocol'
import type { SessionSummary } from '@tandem/protocol'
import { prettyModel } from '../../lib/modelName'
import { formatCost, formatTokens } from '../../lib/format'
import type { GroupId } from './shared'

interface CardSummaryValues {
  planStatus: ReactNode
  todos: Todo[]
  completed: number
  agentCount: number
  turnCount: number
  forkCount: number
  usage: SessionSummary['usage'] | undefined
  subUsage: { cost: number }
  contextData: { noData: boolean; used: number; window: number; pct: number }
  fileChanges: Array<unknown>
  additions: number
  deletions: number
  memory: MemoryFile | null
  wikiEntry: { meta?: { pages?: unknown[] } | null } | undefined
  summary: SessionSummary | null
}

export function cardSummary(
  id: GroupId,
  values: CardSummaryValues,
): ReactNode {
  const {
    planStatus,
    todos,
    completed,
    agentCount,
    turnCount,
    forkCount,
    usage,
    subUsage,
    contextData,
    fileChanges,
    additions,
    deletions,
    memory,
    wikiEntry,
    summary,
  } = values
  switch (id) {
      case 'plan':
        return planStatus
      case 'todos':
        return todos.length ? `${completed}/${todos.length}` : '—'
      case 'agents':
        return String(agentCount)
      case 'graph':
        return `${turnCount} 轮 · ${agentCount} 子代理 · ${forkCount} 分叉`
      case 'usage': {
        const total = (usage?.costUsd ?? 0) + subUsage.cost
        return formatCost(total)
      }
      case 'context':
        return contextData.noData
          ? '—'
          : `${formatTokens(contextData.used)} / ${formatTokens(contextData.window)} · ${contextData.pct}%`
      case 'changes':
        return fileChanges.length
          ? `${fileChanges.length} 个文件 · +${additions} −${deletions}`
          : '—'
      case 'memory':
        return `${memory?.entries ?? 0} 条`
      case 'wiki':
        return `${wikiEntry?.meta?.pages?.length ?? 0} 页`
      case 'details':
        return summary?.model ? prettyModel(summary.model) : '—'
      default:
        return null
    }
  }

