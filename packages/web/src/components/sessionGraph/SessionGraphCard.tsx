import { useCallback, useMemo } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { Button } from '../ui/Button'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { useTurnNavStore } from '../../store/useTurnNavStore'
import { useSessionView } from '../session/SessionScope'
import { focusMessage } from '../../lib/jump'
import type { UiMessage } from '../../lib/types'
import { buildSessionGraph, turnsFromMessages } from './data'
import {
  graphCardHeight,
  layoutSessionGraph,
  type GraphNode,
} from './layout'
import { SessionGraphView } from './SessionGraphView'

/** 会话信息面板里的「会话图」卡片：数据来自当前会话的轮次、子代理树与分叉会话。 */
export function SessionGraphCard({
  full = false,
  onBack,
}: {
  full?: boolean
  onBack?: () => void
}) {
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const messages = useSessionView((s) => s?.messages) ?? []
  const subagents = useSessionView((s) => s?.subagents)
  const hostSessions = useAppStore((s) => (hostId ? s.runtimes[hostId]?.sessions : undefined))
  const openSession = useAppStore((s) => s.openSession)
  const openAgentSession = useUiStore((s) => s.openAgentSession)
  const closeAgentSession = useUiStore((s) => s.closeAgentSession)
  const agentSession = useUiStore((s) => s.agentSession)
  const activeTurn = useTurnNavStore((s) => s.active)

  const input = useMemo(() => {
    if (!sessionId) return null
    return buildSessionGraph({
      sessionId,
      ...(summary?.title ? { title: summary.title } : {}),
      messages,
      ...(subagents ? { subagents } : {}),
      ...(hostSessions ? { hostSessions } : {}),
    })
  }, [sessionId, summary?.title, messages, subagents, hostSessions])

  const layout = useMemo(() => (input ? layoutSessionGraph(input) : null), [input])

  const open = useCallback(
    (node: GraphNode) => {
      if (!hostId) return
      if (node.kind === 'fork' && node.forkSessionId) {
        if (node.forkSessionId !== sessionId) openSession(hostId, node.forkSessionId)
        return
      }
      if (node.subagentId) {
        openAgentSession(hostId, node.subagentId)
        return
      }
      if (node.turnId) {
        // 反馈1926#03：在子代理只读视图里点主线节点，先退回主会话再定位该轮。
        if (agentSession) closeAgentSession()
        focusMessage(node.turnId)
      }
    },
    [openAgentSession, closeAgentSession, agentSession, hostId, openSession, sessionId],
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
        </div>
      )}
      {layout.nodes.length === 0 ? (
        <EmptyState variant="plain" title={<>还没有用户轮次</>} />
      ) : (
        <SessionGraphView
          layout={layout}
          activeTurn={activeTurn}
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
  const layout = useMemo(() => layoutSessionGraph(input), [input])
  const open = useCallback(
    (node: GraphNode) => (onOpenProp ? onOpenProp(node) : focusMessage(node.id)),
    [onOpenProp],
  )
  if (layout.nodes.length === 0) return null
  return (
    <SessionGraphView
      layout={layout}
      onOpen={open}
      readOnly={!onOpenProp}
      height={height ?? graphCardHeight(layout.rows)}
    />
  )
}
