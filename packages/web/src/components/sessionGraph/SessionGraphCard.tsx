import { useCallback, useEffect, useMemo, useState } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { Button } from '../ui/Button'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { useTurnNavStore } from '../../store/useTurnNavStore'
import { useSessionView } from '../session/SessionScope'
import { usageByTurn } from '../../lib/turnUsage'
import { focusMessage } from '../../lib/jump'
import type { UiMessage } from '../../lib/types'
import { buildSessionGraph, turnsFromMessages } from './data'
import {
  graphCardHeight,
  graphSummaryLabel,
  layoutSessionGraph,
  type GraphNode,
  type GraphUsage,
} from './layout'
import { SessionGraphView } from './SessionGraphView'

function usageMapOf(
  messages: UiMessage[],
  subagents: Parameters<typeof usageByTurn>[1],
  sessionId: string | undefined,
): Map<string, GraphUsage | undefined> {
  const result = new Map<string, GraphUsage | undefined>()
  if (!sessionId) return result
  for (const [id, usage] of usageByTurn(messages, subagents, sessionId)) {
    result.set(id, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: usage.costUsd,
      durationMs: (usage.durationMs ?? 0) + (usage.toolDurationMs ?? 0) || undefined,
    })
  }
  return result
}

/** 会话信息面板里的「会话图」卡片：数据来自当前会话的轮次、子代理树与分叉会话。 */
export function SessionGraphCard({
  full = false,
  onExpand,
  onBack,
}: {
  full?: boolean
  onExpand?: () => void
  onBack?: () => void
}) {
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const messages = useSessionView((s) => s?.messages) ?? []
  const subagents = useSessionView((s) => s?.subagents)
  const hostSessions = useAppStore((s) => (hostId ? s.runtimes[hostId]?.sessions : undefined))
  const openSession = useAppStore((s) => s.openSession)
  const focusAgent = useUiStore((s) => s.focusAgent)
  const activeTurn = useTurnNavStore((s) => s.active)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  useEffect(() => setExpanded({}), [sessionId])

  const input = useMemo(() => {
    if (!sessionId) return null
    return buildSessionGraph({
      sessionId,
      ...(summary?.title ? { title: summary.title } : {}),
      messages,
      ...(subagents ? { subagents } : {}),
      ...(hostSessions ? { hostSessions } : {}),
      turnUsage: usageMapOf(messages, subagents, sessionId),
    })
  }, [sessionId, summary?.title, messages, subagents, hostSessions])

  const layout = useMemo(
    () => (input ? layoutSessionGraph({ ...input, expanded }) : null),
    [input, expanded],
  )

  const toggleSubagent = useCallback((id: string) => {
    setExpanded((current) => ({ ...current, [id]: !current[id] }))
  }, [])

  const open = useCallback(
    (node: GraphNode) => {
      if (!hostId) return
      if (node.kind === 'fork' && node.forkSessionId) {
        if (node.forkSessionId !== sessionId) openSession(hostId, node.forkSessionId)
        return
      }
      if (node.turnId) focusMessage(node.turnId)
      if (node.subagentId) {
        // 先跳到父轮（让 Task 卡片挂载），再打开内嵌子代理视图。
        window.setTimeout(() => focusAgent(node.subagentId!), node.turnId ? 420 : 0)
      }
    },
    [focusAgent, hostId, openSession, sessionId],
  )

  if (!layout) {
    return <p className="text-[12px] text-muted">打开会话后显示会话图</p>
  }

  return (
    <div className={full ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      {full && (
        <div className="mb-2 flex shrink-0 items-baseline gap-2">
          <Button size="inline" variant="ghost" onClick={onBack}>
            ← 返回
          </Button>
          <span className="text-[12px] text-text-soft">会话图</span>
          <span className="text-[11px] text-muted">{graphSummaryLabel(layout)}</span>
        </div>
      )}
      {!full && (
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-[11px] text-muted">{graphSummaryLabel(layout)}</span>
          {onExpand && (
            <Button size="inline" variant="ghost" onClick={onExpand}>
              展开
            </Button>
          )}
        </div>
      )}
      {layout.counts.turns === 0 ? (
        <EmptyState variant="plain" title={<>还没有用户轮次</>} />
      ) : (
        <SessionGraphView
          layout={layout}
          activeTurn={activeTurn}
          expanded={expanded}
          onToggleSubagent={toggleSubagent}
          onOpen={open}
          height={full ? 'full' : graphCardHeight(layout.rows)}
          className={full ? 'flex-1' : undefined}
        />
      )}
    </div>
  )
}

/** 外部会话只读预览：只画主线轮次（原日志里没有子代理/分叉关联信息）。 */
export function ReadOnlySessionGraph({
  messages,
  title,
  onOpen: onOpenProp,
  height,
}: {
  messages: UiMessage[]
  title?: string
  onOpen?: (node: GraphNode) => void
  height?: number
}) {
  const [expanded] = useState<Record<string, boolean>>({})
  const input = useMemo(() => {
    const parts = turnsFromMessages(messages)
    return {
      sessionId: 'external',
      ...(title ? { title } : {}),
      turns: parts.turns,
      subagents: [],
      forks: [],
    }
  }, [messages, title])
  const layout = useMemo(() => layoutSessionGraph({ ...input, expanded }), [input, expanded])
  const open = useCallback(
    (node: GraphNode) => (onOpenProp ? onOpenProp(node) : focusMessage(node.id)),
    [onOpenProp],
  )
  if (layout.counts.turns === 0) return null
  return (
    <SessionGraphView
      layout={layout}
      expanded={expanded}
      onOpen={open}
      readOnly={!onOpenProp}
      height={height ?? graphCardHeight(layout.rows)}
    />
  )
}
