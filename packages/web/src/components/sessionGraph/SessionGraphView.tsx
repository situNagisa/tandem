import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Pin } from 'lucide-react'
import { cn } from '../../lib/cn'
import {
  GRAPH_ROW_H,
  columnX,
  graphTextX,
  type GraphEdge,
  type GraphLayout,
  type GraphNode,
} from './layout'

/** 主线用 lane-0；分支在 lane-1..7 内循环，不与主线同色。 */
function laneColor(lane: number): string {
  return `var(--graph-lane-${lane === 0 ? 0 : 1 + ((lane - 1) % 7)})`
}

function laneColumnX(layout: GraphLayout, lane: number): number {
  return columnX(layout.columnOf[lane]!)
}

const EDGE_RADIUS = 6
/**
 * 连线透明命中描边的宽度：线中心两侧各 6.5px（线外 6px 内悬停都能命中）。
 * 相邻泳道隔 14px，两边命中带之间留 1px 空隙，tip 不会串到隔壁会话。
 */
const EDGE_HIT_WIDTH = 13
/** 节点圆点的命中半径（px）：圆点只有 8px，命中区放大到 20px。 */
const NODE_HIT_SIZE = 20

function rowY(row: number): number {
  return row * GRAPH_ROW_H + GRAPH_ROW_H / 2
}

function nodeTooltip(node: GraphNode, compact: boolean): string {
  const tag =
    node.relation === 'subagent' ? '子代理会话' : node.relation === 'fork' ? '分叉会话' : '会话'
  if (compact) {
    if (node.attachPoint) return `${node.sessionTitle} · ${node.label}`
    return node.sessionTitle
  }
  if (node.relation !== 'root') return `${node.label} · ${node.sessionTitle}`
  return `${node.label} · ${tag}`
}

/**
 * 正交圆角折线。分出：从父节点行直接向右拐进子分支的列，再竖直到分支端点；
 * 汇回：竖直到目标行，圆角折回父泳道节点。圆角方向随上下行变化（时间倒序后分支向上）。
 */
function edgePath(edge: GraphEdge, x: (lane: number) => number): string {
  const x1 = x(edge.fromLane)
  const y1 = rowY(edge.fromRow)
  const x2 = x(edge.toLane)
  const y2 = rowY(edge.toRow)
  const r = EDGE_RADIUS
  const sign = y2 >= y1 ? 1 : -1
  if (x2 > x1) return `M ${x1} ${y1} H ${x2 - r} Q ${x2} ${y1} ${x2} ${y1 + sign * r} V ${y2}`
  if (x2 < x1) return `M ${x1} ${y1} V ${y2 - sign * r} Q ${x1} ${y2} ${x1 - r} ${y2} H ${x2}`
  return `M ${x1} ${y1} V ${y2}`
}

function edgeColor(edge: GraphEdge): string {
  if (edge.kind === 'main') return laneColor(0)
  // 分支线取更靠右的泳道色：分出时是子泳道，汇回时也是子泳道（主线是 lane 0）。
  return laneColor(Math.max(edge.fromLane, edge.toLane))
}

/**
 * 连线层：可见线按悬停归属降亮/保持；每条线另有一份 14px 透明命中描边，
 * 悬停命中描边时高亮该会话的整条轨道并用标准 tooltip 显示会话名（反馈1926#10）；
 * 点线打开该线归属的会话（反馈0220#07）。
 */
function EdgeLayer({
  layout,
  hoverOwner,
  onHover,
  onOpenSession,
}: {
  layout: GraphLayout
  hoverOwner: string | null
  onHover: (owner: string | null) => void
  onOpenSession: (sessionId: string) => void
}) {
  const x = (lane: number) => laneColumnX(layout, lane)
  return (
    <svg
      className="pointer-events-none absolute inset-x-0 top-0 overflow-visible"
      width="100%"
      height={Math.max(1, layout.rows * GRAPH_ROW_H)}
      aria-hidden="true"
      data-session-graph-edges
    >
      {layout.edges.map((edge, index) => {
        const active = hoverOwner === null || hoverOwner === edge.ownerId
        return (
          <path
            key={index}
            d={edgePath(edge, x)}
            fill="none"
            stroke={edgeColor(edge)}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={active ? 1 : 0.22}
            data-kind={edge.kind}
            data-edge-owner={edge.ownerId}
            data-from-lane={edge.fromLane}
            data-to-lane={edge.toLane}
            data-from-row={edge.fromRow}
            data-to-row={edge.toRow}
            {...(hoverOwner === edge.ownerId ? { 'data-hovered': 'true' } : {})}
            {...(edge.merge ? { 'data-merge': '1' } : {})}
            style={{ transition: 'opacity 120ms' }}
          />
        )
      })}
      {layout.edges.map((edge, index) => (
        <path
          key={`hit-${index}`}
          d={edgePath(edge, x)}
          fill="none"
          stroke="transparent"
          strokeWidth={EDGE_HIT_WIDTH}
          strokeLinecap="round"
          pointerEvents="stroke"
          data-edge-hit
          data-edge-owner={edge.ownerId}
          data-edge-kind={edge.kind}
          data-from-lane={edge.fromLane}
          data-to-lane={edge.toLane}
          data-from-row={edge.fromRow}
          data-to-row={edge.toRow}
          {...(edge.merge ? { 'data-merge': '1' } : {})}
          data-tip={edge.label}
          data-tip-anchor="pointer"
          onPointerEnter={() => onHover(edge.ownerId)}
          onPointerLeave={() => onHover(null)}
          onClick={() => onOpenSession(edge.ownerId)}
        />
      ))}
    </svg>
  )
}

export interface SessionGraphViewProps {
  layout: GraphLayout
  /** 当前所在轮（1-based 主线轮号），节点外圈高亮。 */
  activeTurn?: number
  /** 当前会话正在运行（服务端树里的状态可能晚一拍）：最新主线的轮节点外圈呼吸。 */
  running?: boolean
  /** 当前会话在等待用户输入（服务端树里的状态可能晚一拍）：最新主线轮显示等待标记。 */
  waiting?: boolean
  onOpen: (node: GraphNode) => void
  /** 点连线：打开该线归属的会话。 */
  onOpenSession?: (sessionId: string) => void
  /** 只读：不提供跳转的鼠标指针提示。 */
  readOnly?: boolean
  /** 紧凑模式（侧栏悬停浮层）：不显示轮次标题，只显示会话名。 */
  compact?: boolean
  /** 卡片内高度；'full' 占满父容器。 */
  height?: number | 'full'
  /** 悬停浮层里不接管键盘焦点（打开浮层时不抢焦点）。 */
  keyboard?: boolean
  className?: string
}

/**
 * 会话图渲染：固定行高 + 虚拟滚动只挂可见行；连线用整张 SVG 绘制。
 * 所有节点同一形状（8px 实心圆），颜色 = 泳道色；主线是一条直线上去。
 * 悬停名称行/连线高亮该会话的节点与轨道，点节点或线打开对应会话。
 */
export function SessionGraphView({
  layout,
  activeTurn,
  running = false,
  waiting = false,
  onOpen,
  onOpenSession,
  readOnly = false,
  compact = false,
  height = 168,
  keyboard = true,
  className,
}: SessionGraphViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 168 })
  const [selected, setSelected] = useState<string | null>(null)
  const [hoverOwner, setHoverOwner] = useState<string | null>(null)
  /** 指针所在的那个轮节点：同线整条高亮之外，它自己再放大一档并加外圈（反馈1110）。 */
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [height])

  /** 每个会话最新一轮的轮号：运行中的会话只在这一轮上显示动画。 */
  const latestTurnOf = useMemo(() => {
    const map = new Map<string, number>()
    for (const node of layout.nodes) {
      map.set(node.sessionId, Math.max(map.get(node.sessionId) ?? 0, node.turnNo))
    }
    return map
  }, [layout.nodes])
  const overscan = 6
  const textX = graphTextX(layout.columns)
  const startRow = Math.max(0, Math.floor(viewport.top / GRAPH_ROW_H) - overscan)
  const endRow = Math.min(
    layout.rows - 1,
    Math.ceil((viewport.top + viewport.height) / GRAPH_ROW_H) + overscan,
  )
  const visibleNodes = useMemo(
    () => layout.nodes.filter((node) => node.row >= startRow && node.row <= endRow),
    [layout.nodes, startRow, endRow],
  )

  const openSession = (sessionId: string) => {
    if (readOnly) return
    if (sessionId) onOpenSession?.(sessionId)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (layout.nodes.length === 0) return
    const currentIndex = layout.nodes.findIndex((node) => node.key === selected)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const base = currentIndex < 0 ? 0 : currentIndex
      const next =
        event.key === 'ArrowDown'
          ? Math.min(layout.nodes.length - 1, base + 1)
          : Math.max(0, base - 1)
      const node = layout.nodes[next]!
      setSelected(node.key)
      scrollRef.current?.scrollTo({
        top: Math.max(0, node.row * GRAPH_ROW_H - (viewport.height / 2 - GRAPH_ROW_H / 2)),
        behavior: 'auto',
      })
      return
    }
    if (event.key === 'Enter' && selected) {
      const node = layout.nodes.find((item) => item.key === selected)
      if (node) {
        event.preventDefault()
        onOpen(node)
      }
    }
  }

  return (
    <div className={cn('session-graph flex min-h-0 flex-col', className)} data-session-graph>
      <div
        ref={scrollRef}
        className="min-h-0 overflow-y-auto overflow-x-hidden outline-none focus-visible:ring-1 focus-visible:ring-[var(--t-focus-ring)] focus-visible:ring-inset"
        style={height === 'full' ? { maxHeight: 'calc(100% - 26px)' } : { height }}
        data-graph-height={height === 'full' ? 'full' : height}
        data-graph-count={layout.nodes.length}
        data-graph-rows={layout.rows}
        tabIndex={readOnly || !keyboard ? -1 : 0}
        role="tree"
        aria-label="会话图：按会话与分支浏览"
        onKeyDown={readOnly || !keyboard ? undefined : onKeyDown}
      >
        <div className="relative w-full" style={{ height: Math.max(1, layout.rows * GRAPH_ROW_H) }}>
          <EdgeLayer
            layout={layout}
            hoverOwner={hoverOwner}
            onHover={setHoverOwner}
            onOpenSession={openSession}
          />
          {visibleNodes.map((node) => {
            const color = laneColor(node.lane)
            const isSelected = selected === node.key
            const isCurrentTurn =
              node.current && node.kind === 'turn' && !!activeTurn && node.turnNo === activeTurn
            const isHoveredNode = hoveredNode === node.key
            // 任何正在运行/等待输入的会话（主会话/分叉/子代理）都在自己最新一轮上标记；
            // 当前会话的状态以传进来的实时值为准（服务端树晚一拍）。
            const isLatestOfSession = node.turnNo === latestTurnOf.get(node.sessionId)
            const isWaiting = (node.waiting || (waiting && !!node.current)) && isLatestOfSession
            const isRunning =
              !isWaiting && (node.running || (running && !!node.current)) && isLatestOfSession
            const dotSize = isHoveredNode ? 10 : 8
            const canOpen = !readOnly
            const showName = compact && node.sessionLabel
            const label = compact
              ? showName
                ? node.sessionTitle
                : ''
              : node.label
            return (
              <div
                key={node.key}
                className="pointer-events-none absolute inset-x-0"
                style={{ top: node.row * GRAPH_ROW_H, height: GRAPH_ROW_H }}
              >
                <div
                  className={cn(
                    'group/node pointer-events-auto absolute inset-y-0 right-0 flex min-w-0 items-center rounded-[5px] pr-1 transition-colors',
                    canOpen && 'cursor-pointer hover:bg-[var(--t-bg-hover)]',
                    isSelected && 'bg-[var(--t-bg-hover)]',
                    !canOpen && 'pointer-events-none',
                  )}
                  style={{ left: textX - 6, paddingLeft: 6 }}
                  role="treeitem"
                  aria-selected={isSelected}
                  data-tip={nodeTooltip(node, compact)}
                  data-kind={node.kind}
                  data-lane={node.lane}
                  data-row={node.row}
                  data-graph-turn-id={node.id}
                  data-session-id={node.sessionId}
                  data-subagent-id={node.subagentId}
                  data-fork-id={node.forkSessionId}
                  data-trunk={node.trunk ? 'true' : undefined}
                  data-session-label={node.sessionLabel ? 'true' : undefined}
                  data-attach-point={node.attachPoint ? 'true' : undefined}
                  data-active={isCurrentTurn ? 'true' : undefined}
                  data-running={isRunning ? 'true' : undefined}
                  data-waiting={isWaiting ? 'true' : undefined}
                  data-hovered={isHoveredNode ? 'true' : undefined}
                  data-row-hovered={isHoveredNode ? 'true' : undefined}
                  onPointerEnter={() => {
                    setHoverOwner(node.sessionId)
                    setHoveredNode(node.key)
                  }}
                  onPointerLeave={() => {
                    setHoverOwner(null)
                    setHoveredNode(null)
                  }}
                  onClick={() => {
                    if (readOnly) return
                    setSelected(node.key)
                    onOpen(node)
                  }}
                >
                  {isRunning && (
                    <span
                      aria-hidden="true"
                      data-marker-ring="running"
                      className="running-dot absolute top-1/2 size-[14px] -translate-y-1/2 rounded-full border-[1.5px]"
                      style={{
                        left: laneColumnX(layout, node.lane) - 7 - (textX - 6),
                        borderColor: color,
                      }}
                    />
                  )}
                  {/* 圆点命中区：8px 圆点放大到 20px，点圆点也能打开该会话。 */}
                  <span
                    aria-hidden="true"
                    data-node-hit
                    className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{
                      left: laneColumnX(layout, node.lane) - (textX - 6),
                      width: NODE_HIT_SIZE,
                      height: NODE_HIT_SIZE,
                    }}
                  />
                  {isWaiting && (
                    <span
                      aria-hidden="true"
                      data-marker-ring="waiting"
                      data-tip="等待你的输入/审批"
                      className="running-dot absolute top-1/2 z-[1] size-2 -translate-y-1/2 rounded-full bg-accent"
                      style={{ left: laneColumnX(layout, node.lane) - 4 - (textX - 6) }}
                    />
                  )}
                  <span
                    aria-hidden="true"
                    data-marker="circle"
                    className="absolute top-1/2 -translate-y-1/2 rounded-full"
                    style={{
                      left: laneColumnX(layout, node.lane) - dotSize / 2 - (textX - 6),
                      width: dotSize,
                      height: dotSize,
                      backgroundColor: color,
                      boxShadow: isHoveredNode
                        ? `0 0 0 1.5px var(--t-surface), 0 0 0 3px ${color}`
                        : isCurrentTurn || (compact && node.current)
                          ? '0 0 0 1.5px var(--t-surface), 0 0 0 3px var(--t-focus-ring)'
                          : undefined,
                    }}
                  />
                  {node.pinned && label ? (
                    <Pin size={8} className="mr-1 shrink-0 text-muted" aria-label="已固定" />
                  ) : null}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[13px] leading-5',
                      node.relation === 'root' ? 'text-text-soft' : 'text-muted',
                      node.current && 'text-text',
                    )}
                  >
                    {label}
                  </span>
                  {!compact && node.kind === 'fork' && node.sessionLabel && (
                    <span className="ml-1 shrink-0 text-[12px] text-muted">分叉</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
