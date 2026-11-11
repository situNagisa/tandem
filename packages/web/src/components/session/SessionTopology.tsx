import { useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { buildSessionTopology } from '../sessionGraph/data'
import { graphCardHeight, layoutSessionTopology, type GraphNode } from '../sessionGraph/layout'
import { SessionGraphView } from '../sessionGraph/SessionGraphView'

/**
 * 侧栏会话行的悬停拓扑图：节点是会话（主会话、分叉、子代理），不含轮次与用量。
 * 布局与绘制直接复用右栏会话图（layoutSessionGraph 的拓扑模式）。
 */
export function SessionTopology({
  hostId,
  rootId,
  title,
  onNavigate,
}: {
  hostId: string
  rootId: string
  title?: string
  onNavigate?: () => void
}) {
  const sessions = useAppStore((s) => s.runtimes[hostId]?.sessions)
  const activeSessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const openSession = useAppStore((s) => s.openSession)
  const openAgentSession = useUiStore((s) => s.openAgentSession)

  const layout = useMemo(() => {
    const visible = (sessions ?? []).filter((session) => !session.archived)
    return layoutSessionTopology(
      buildSessionTopology({
        rootId,
        ...(title ? { title } : {}),
        sessions: visible,
        activeSessionId,
      }),
    )
  }, [sessions, rootId, title, activeSessionId])

  const open = (node: GraphNode) => {
    onNavigate?.()
    if (node.kind === 'fork' && node.forkSessionId) {
      openSession(hostId, node.forkSessionId)
      return
    }
    if (node.subagentId) {
      // 只读子会话读取的是当前会话（及其嵌套）的子代理：不在当前会话下时先打开它的父会话。
      const byId = new Map((sessions ?? []).map((session) => [session.id, session]))
      let cursor = node.subagentId
      let reachable = false
      for (let depth = 0; depth < 64; depth += 1) {
        const current = byId.get(cursor)
        const parent = current?.parentId
        if (!parent) break
        if (parent === activeSessionId) {
          reachable = true
          break
        }
        cursor = parent
      }
      if (reachable) openAgentSession(hostId, node.subagentId)
      else if (node.parentSessionId) openSession(hostId, node.parentSessionId)
      return
    }
    if (node.sessionId && node.sessionId !== activeSessionId) {
      openSession(hostId, node.sessionId)
    }
  }

  return (
    <div data-session-topology className="flex min-h-0 w-full flex-col">
      <SessionGraphView
        layout={layout}
        onOpen={open}
        height={graphCardHeight(layout.rows)}
        keyboard={false}
        className="w-full"
      />
    </div>
  )
}
