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

function rowY(row: number): number {
  return row * GRAPH_ROW_H + GRAPH_ROW_H / 2
}

function nodeTooltip(node: GraphNode): string {
  if (node.kind === 'fork') {
    return `${node.label} · ${node.forkRelation === 'source' ? '原会话' : '分叉会话'} · 点击打开`
  }
  if (node.kind === 'subagent-turn' || node.kind === 'subagent') {
    return `${node.label} · 子代理会话 · 点击打开`
  }
  return node.label
}

/**
 * 正交圆角折线。分出：从父节点行直接向右拐进子分支的列，再竖直到分支末节点；
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
 * 连线层：可见线按悬停归属降亮/保持；每条线另有一份 12px 透明命中描边，
 * 悬停命中描边时高亮整条轨道并用标准 tooltip 显示归属会话名（反馈1926#10）。
 */
function EdgeLayer({
  layout,
  hoverOwner,
  onHover,
}: {
  layout: GraphLayout
  hoverOwner: string | null
  onHover: (owner: string | null) => void
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
          strokeWidth={12}
          strokeLinecap="round"
          pointerEvents="stroke"
          data-edge-hit
          data-edge-owner={edge.ownerId}
          data-edge-kind={edge.kind}
          data-tip={edge.label}
          data-tip-anchor="pointer"
          onPointerEnter={() => onHover(edge.ownerId)}
          onPointerLeave={() => onHover(null)}
        />
      ))}
    </svg>
  )
}

export interface SessionGraphViewProps {
  layout: GraphLayout
  /** 当前所在轮（1-based 主线轮号），节点外圈高亮。 */
  activeTurn?: number
  onOpen: (node: GraphNode) => void
  /** 只读：不提供跳转的鼠标指针提示。 */
  readOnly?: boolean
  /** 卡片内高度；'full' 占满父容器。 */
  height?: number | 'full'
  /** 悬停浮层里不接管键盘焦点（打开浮层时不抢焦点）。 */
  keyboard?: boolean
  className?: string
}

/**
 * 会话图渲染：固定行高 + 虚拟滚动只挂可见行；连线用整张 SVG 绘制。
 * 所有节点同一形状（8px 实心圆），颜色 = 泳道色；子代理始终展开并从最后一行汇回，
 * 分叉不合并、行尾写「分叉」。不显示轮次序号、token 或结果行（反馈1926）。
 */
export function SessionGraphView({
  layout,
  activeTurn,
  onOpen,
  readOnly = false,
  height = 168,
  keyboard = true,
  className,
}: SessionGraphViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 168 })
  const [selected, setSelected] = useState<string | null>(null)
  const [hoverOwner, setHoverOwner] = useState<string | null>(null)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [height])

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
        tabIndex={readOnly || !keyboard ? -1 : 0}
        role="tree"
        aria-label="会话图：按会话与分支浏览"
        onKeyDown={readOnly || !keyboard ? undefined : onKeyDown}
      >
        <div className="relative w-full" style={{ height: Math.max(1, layout.rows * GRAPH_ROW_H) }}>
          <EdgeLayer layout={layout} hoverOwner={hoverOwner} onHover={setHoverOwner} />
          {visibleNodes.map((node) => {
            const color = laneColor(node.lane)
            const isSelected = selected === node.key
            const isCurrent =
              node.current === true ||
              (node.kind === 'turn' && !!activeTurn && node.turnNo === activeTurn)
            const canOpen = !readOnly
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
                    (isSelected || (node.subagentId && hoverOwner === node.subagentId)) &&
                      'bg-[var(--t-bg-hover)]',
                    !canOpen && 'pointer-events-none',
                  )}
                  style={{ left: textX - 6, paddingLeft: 6 }}
                  role="treeitem"
                  aria-selected={isSelected}
                  data-tip={nodeTooltip(node)}
                  data-kind={node.kind}
                  data-lane={node.lane}
                  data-row={node.row}
                  data-graph-turn-id={node.kind === 'turn' ? node.id : undefined}
                  data-session-id={node.sessionId}
                  data-subagent-id={node.subagentId}
                  data-fork-id={node.forkSessionId}
                  data-active={isCurrent ? 'true' : undefined}
                  onClick={() => {
                    if (readOnly) return
                    setSelected(node.key)
                    onOpen(node)
                  }}
                >
                  <span
                    aria-hidden="true"
                    data-marker="circle"
                    className="absolute top-1/2 size-[8px] -translate-y-1/2 rounded-full"
                    style={{
                      left: laneColumnX(layout, node.lane) - 4 - (textX - 6),
                      backgroundColor: color,
                      boxShadow: isCurrent
                        ? '0 0 0 1.5px var(--t-surface), 0 0 0 3px var(--t-focus-ring)'
                        : undefined,
                    }}
                  />
                  {node.pinned && (
                    <Pin size={8} className="mr-1 shrink-0 text-muted" aria-label="已固定" />
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[13px] leading-5',
                      node.kind === 'turn' || node.kind === 'session'
                        ? 'text-text-soft'
                        : 'text-muted',
                      isCurrent && 'text-text',
                    )}
                  >
                    {node.label}
                  </span>
                  {node.kind === 'fork' && (
                    <span className="ml-1 shrink-0 text-[12px] text-muted">
                      {node.forkRelation === 'source' ? '原会话' : '分叉'}
                    </span>
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
