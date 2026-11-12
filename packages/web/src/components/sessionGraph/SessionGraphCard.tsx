import { useCallback, useMemo } from 'react'
import type { SessionGraphTree } from '@tandem/protocol'
import { EmptyState } from '../ui/EmptyState'
import { Button } from '../ui/Button'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { useTurnNavStore } from '../../store/useTurnNavStore'
import { useSessionView } from '../session/SessionScope'
import { focusMessage } from '../../lib/jump'
import type { UiMessage } from '../../lib/types'
import { graphFromMessages, graphFromTree } from './data'
import { graphCardHeight, layoutSessionGraph, type GraphNode } from './layout'
import { SessionGraphView } from './SessionGraphView'
import { useSessionGraphTree } from './useGraphTree'

function relationOf(tree: SessionGraphTree | null, sessionId: string): 'root' | 'fork' | 'subagent' {
  return tree?.sessions.find((session) => session.id === sessionId)?.kind ?? 'fork'
}

/** 会话信息面板里的「会话图」卡片：整棵树共用一张拓扑，当前会话的祖先链是主线。 */
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
  const openSession = useAppStore((s) => s.openSession)
  const openAgentSession = useUiStore((s) => s.openAgentSession)
  const closeAgentSession = useUiStore((s) => s.closeAgentSession)
  const agentSession = useUiStore((s) => s.agentSession)
  const activeTurn = useTurnNavStore((s) => s.active)
  const running = summary?.status === 'running'
  const waiting = summary?.status === 'waiting_permission'
  const tree = useSessionGraphTree(hostId, sessionId)

  const input = useMemo(() => {
    if (!tree || !sessionId) return null
    return graphFromTree(tree, sessionId)
  }, [tree, sessionId])

  const layout = useMemo(() => (input ? layoutSessionGraph(input) : null), [input])

  const openSessionNode = useCallback(
    (targetId: string) => {
      if (!hostId || !targetId || targetId === sessionId) return
      if (relationOf(tree, targetId) === 'subagent') openAgentSession(hostId, targetId)
      else openSession(hostId, targetId)
    },
    [hostId, sessionId, tree, openAgentSession, openSession],
  )

  const open = useCallback(
    (node: GraphNode) => {
      if (!hostId) return
      if (node.sessionId !== sessionId) {
        openSessionNode(node.sessionId)
        return
      }
      if (node.turnId) {
        // 反馈1926#03：在子代理只读视图里点主线节点，先退回主会话再定位该轮。
        if (agentSession) closeAgentSession()
        focusMessage(node.turnId)
      }
    },
    [agentSession, closeAgentSession, hostId, openSessionNode, sessionId],
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
          running={running}
          waiting={waiting}
          onOpen={open}
          onOpenSession={openSessionNode}
          height={full ? 'full' : graphCardHeight(layout.rows)}
          className={full ? 'flex-1' : undefined}
        />
      )}
    </div>
  )
}

/** 只读会话图（外部会话、子代理内嵌视图）：只有一条链，点节点定位该轮。 */
export function ReadOnlySessionGraph({
  messages,
  title,
  sessionId = 'external',
  pinned,
  onOpen: onOpenProp,
  height,
}: {
  messages: UiMessage[]
  title?: string
  sessionId?: string
  pinned?: string[]
  onOpen?: (node: GraphNode) => void
  height?: number
}) {
  const input = useMemo(
    () => graphFromMessages(messages, { sessionId, ...(title ? { title } : {}), ...(pinned ? { pinned } : {}) }),
    [messages, sessionId, title, pinned],
  )
  const layout = useMemo(() => layoutSessionGraph(input), [input])
  const open = useCallback(
    (node: GraphNode) => {
      if (onOpenProp) {
        onOpenProp(node)
        return
      }
      // 反馈0220#01：外部会话等只读视图的节点点击也要能定位该轮。
      focusMessage(node.turnId)
    },
    [onOpenProp],
  )
  if (layout.nodes.length === 0) return null
  return (
    <SessionGraphView
      layout={layout}
      onOpen={open}
      height={height ?? graphCardHeight(layout.rows)}
    />
  )
}
