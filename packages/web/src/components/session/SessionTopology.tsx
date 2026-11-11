import { useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { graphFromTree } from '../sessionGraph/data'
import { graphCardHeight, layoutSessionGraph, type GraphNode } from '../sessionGraph/layout'
import { SessionGraphView } from '../sessionGraph/SessionGraphView'
import { useSessionGraphTree } from '../sessionGraph/useGraphTree'

/**
 * 侧栏会话行的悬停拓扑图：与右栏会话图同一张图（同一套布局与绘制组件），
 * 紧凑模式不显示轮次标题、只在每个会话起点显示会话名；
 * 保留分叉点/派出点，能看出从哪一轮分叉出去、子代理挂在哪一轮。
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
  const activeSessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const openSession = useAppStore((s) => s.openSession)
  const openAgentSession = useUiStore((s) => s.openAgentSession)
  const sessions = useAppStore((s) => s.runtimes[hostId]?.sessions)
  // 按悬停的这棵树取拓扑（正在查看的会话可能在另一棵树里）。
  const tree = useSessionGraphTree(hostId, rootId)

  const currentInTree = useMemo(
    () => tree?.sessions.some((session) => session.id === activeSessionId) ?? false,
    [tree, activeSessionId],
  )
  const trunkId = currentInTree && activeSessionId ? activeSessionId : rootId

  const layout = useMemo(() => {
    if (!tree) return null
    return layoutSessionGraph(graphFromTree(tree), { compact: true, trunkId })
  }, [tree, trunkId])

  const open = (node: GraphNode) => {
    onNavigate?.()
    if (!node.sessionId || node.sessionId === activeSessionId) return
    if (node.relation === 'subagent') {
      // 只读子会话读取的是当前会话（及其嵌套）的子代理：不在当前会话下时先打开它的父会话。
      const byId = new Map((sessions ?? []).map((session) => [session.id, session]))
      const treeParent = tree?.sessions.find((session) => session.id === node.sessionId)?.parentId
      let cursor: string | undefined = node.sessionId
      let reachable = false
      for (let depth = 0; depth < 64 && cursor; depth += 1) {
        const current = byId.get(cursor)
        const parent = current?.parentId
        if (!parent) break
        if (parent === activeSessionId) {
          reachable = true
          break
        }
        cursor = parent
      }
      if (reachable) openAgentSession(hostId, node.sessionId)
      else openSession(hostId, treeParent ?? node.sessionId)
      return
    }
    openSession(hostId, node.sessionId)
  }

  if (!layout) {
    return <p className="px-1 py-1 text-[12px] text-muted">{title || '会话'}</p>
  }

  return (
    <div data-session-topology className="flex min-h-0 w-full flex-col">
      <SessionGraphView
        layout={layout}
        onOpen={open}
        onOpenSession={(sessionId) => {
          if (sessionId === activeSessionId) return
          const relation = tree?.sessions.find((session) => session.id === sessionId)?.kind
          if (relation === 'subagent') openAgentSession(hostId, sessionId)
          else openSession(hostId, sessionId)
        }}
        height={graphCardHeight(layout.rows)}
        compact
        keyboard={false}
        className="w-full"
      />
    </div>
  )
}
