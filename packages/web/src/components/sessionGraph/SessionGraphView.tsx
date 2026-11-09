import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Pin } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatDurationMs, formatTokens } from '../../lib/format'
import {
  GRAPH_ROW_H,
  graphTextX,
  laneX,
  type GraphEdge,
  type GraphLayout,
  type GraphNode,
} from './layout'

const LANE_COLORS = 8

function laneColor(lane: number): string {
  return `var(--graph-lane-${lane % LANE_COLORS})`
}

function nodeTooltip(node: GraphNode): string {
  const parts: string[] = [node.label]
  const usage = node.usage
  if (usage) {
    const tokens =
      (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0)
    if (tokens > 0) {
      parts.push(
        `${formatTokens(tokens)} tok（输入 ${formatTokens(usage.inputTokens ?? 0)} / 输出 ${formatTokens(usage.outputTokens ?? 0)}）`,
      )
    }
    if ((usage.durationMs ?? 0) > 0) parts.push(`耗时 ${formatDurationMs(usage.durationMs!)}`)
    if (typeof usage.costUsd === 'number' && usage.costUsd > 0) {
      parts.push(`$${usage.costUsd.toFixed(4)}`)
    }
  }
  if (node.kind === 'subagent' && node.childCount) parts.push(`含 ${node.childCount} 个嵌套子代理`)
  if (node.kind === 'fork') parts.push('分叉会话 · 点击打开')
  return parts.join(' · ')
}

function nodeMeta(node: GraphNode): string {
  if (node.kind === 'subagent') return node.meta ?? ''
  if (node.kind === 'fork') return ''
  const usage = node.usage
  if (!usage) return ''
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  const bits: string[] = []
  if (tokens > 0) bits.push(formatTokens(tokens))
  if ((usage.durationMs ?? 0) > 0) bits.push(formatDurationMs(usage.durationMs!))
  return bits.join(' · ')
}

/**
 * 连线段：泳道是固定 x 的竖线；分出/合并只在父节点旁走一小段 45° 折线，
 * 之后竖直贯穿分支节点，终点落在节点圆心上（不做整条贝塞尔曲线）。
 */
function edgePath(edge: GraphEdge): string {
  const x1 = laneX(edge.fromLane) + 4
  const y1 = edge.fromRow * GRAPH_ROW_H + GRAPH_ROW_H / 2
  const x2 = laneX(edge.toLane) + 4
  const y2 = edge.toRow * GRAPH_ROW_H + GRAPH_ROW_H / 2
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  const dx = Math.abs(x2 - x1)
  if (x2 > x1) {
    // 分出：父节点旁一小段 45° 斜线到新泳道，再竖直向下到分支最后一个节点。
    if (y1 + dx <= y2) return `M ${x1} ${y1} L ${x2} ${y1 + dx} L ${x2} ${y2}`
    return `M ${x1} ${y1} L ${x2} ${y2}`
  }
  // 合并：分支竖直走到目标主线节点上方，再用 45° 斜线折回节点，不覆盖主线。
  if (y2 - dx >= y1) return `M ${x1} ${y1} L ${x1} ${y2 - dx} L ${x2} ${y2}`
  return `M ${x1} ${y1} L ${x2} ${y2}`
}

function edgeColor(edge: GraphEdge): string {
  if (edge.kind === 'main') return laneColor(0)
  // 分支线取更靠右的泳道色：分出时是子泳道，合并时也是子泳道（主线是 lane 0）。
  return laneColor(Math.max(edge.fromLane, edge.toLane))
}

function EdgeLayer({ layout }: { layout: GraphLayout }) {
  return (
    <svg
      className="pointer-events-none absolute inset-x-0 top-0 overflow-visible"
      width="100%"
      height={Math.max(1, layout.rows * GRAPH_ROW_H)}
      aria-hidden="true"
      data-session-graph-edges
    >
      {layout.edges.map((edge, index) => {
        const merge = edge.kind === 'subagent' && edge.toLane === 0 && edge.toRow > edge.fromRow
        return (
          <path
            key={index}
            d={edgePath(edge)}
            fill="none"
            stroke={edgeColor(edge)}
            strokeWidth={edge.kind === 'subagent' ? 1.15 : 1.5}
            strokeOpacity={edge.kind === 'subagent' ? 0.72 : 0.9}
            strokeLinecap="round"
            data-kind={edge.kind}
            data-from-lane={edge.fromLane}
            data-to-lane={edge.toLane}
            data-from-row={edge.fromRow}
            data-to-row={edge.toRow}
            strokeLinejoin="round"
            {...(merge ? { 'data-merge': '1' } : {})}
          />
        )
      })}
    </svg>
  )
}

export interface SessionGraphViewProps {
  layout: GraphLayout
  /** 当前所在轮（1-based 主线轮号），节点外圈高亮。 */
  activeTurn?: number
  expanded: Record<string, boolean>
  onToggleSubagent?: (id: string) => void
  onOpen: (node: GraphNode) => void
  /** 只读：不提供展开/跳转的鼠标指针提示。 */
  readOnly?: boolean
  /** 卡片内高度；'full' 占满父容器。 */
  height?: number | 'full'
  className?: string
}

/**
 * 会话图渲染：固定行高 + 虚拟滚动只挂可见行；连线用整张 SVG 绘制。
 * 所有节点同一形状（8px 实心圆），颜色 = 泳道色；子代理合并线带 data-merge，分叉不合并。
 */
export function SessionGraphView({
  layout,
  activeTurn,
  expanded,
  onToggleSubagent,
  onOpen,
  readOnly = false,
  height = 168,
  className,
}: SessionGraphViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 168 })
  const [selected, setSelected] = useState<string | null>(null)

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
  const textX = graphTextX(layout.lanes)
  const startRow = Math.max(0, Math.floor(viewport.top / GRAPH_ROW_H) - overscan)
  const endRow = Math.min(
    layout.rows - 1,
    Math.ceil((viewport.top + viewport.height) / GRAPH_ROW_H) + overscan,
  )
  const visibleNodes = useMemo(
    () => layout.nodes.filter((node) => node.row >= startRow && node.row <= endRow),
    [layout.nodes, startRow, endRow],
  )

  const open = useCallback((node: GraphNode) => onOpen(node), [onOpen])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (layout.nodes.length === 0) return
    const currentIndex = Math.max(
      0,
      layout.nodes.findIndex((node) => node.key === selected),
    )
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next =
        event.key === 'ArrowDown'
          ? Math.min(layout.nodes.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1)
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
        open(node)
      }
    }
  }

  return (
    <div className={cn('session-graph flex min-h-0 flex-col', className)} data-session-graph>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none focus-visible:ring-1 focus-visible:ring-[var(--t-focus-ring)] focus-visible:ring-inset"
        style={height === 'full' ? { height: '100%' } : { height }}
        tabIndex={readOnly ? -1 : 0}
        role="tree"
        aria-label="会话图：按轮次与分支浏览"
        onKeyDown={readOnly ? undefined : onKeyDown}
      >
        <div className="relative w-full" style={{ height: Math.max(1, layout.rows * GRAPH_ROW_H) }}>
          <EdgeLayer layout={layout} />
          {visibleNodes.map((node) => {
            const color = laneColor(node.lane)
            const isSelected = selected === node.key
            const isCurrent = node.kind === 'turn' && !!activeTurn && node.turnNo === activeTurn
            const canExpand = node.kind === 'subagent' && node.collapsed
            return (
              <div
                key={node.key}
                className="absolute inset-x-0"
                style={{ top: node.row * GRAPH_ROW_H, height: GRAPH_ROW_H }}
              >
                <div
                  className={cn(
                    'group/node relative flex h-full min-w-0 items-center rounded-[5px] pr-1 transition-colors',
                    !readOnly && 'cursor-pointer hover:bg-[var(--t-bg-hover)]',
                    isSelected && 'bg-[var(--t-bg-hover)]',
                  )}
                  style={{ paddingLeft: textX }}
                  role="treeitem"
                  aria-selected={isSelected}
                  aria-label={nodeTooltip(node)}
                  data-tip={nodeTooltip(node)}
                  data-kind={node.kind}
                  data-lane={node.lane}
                  data-row={node.row}
                  data-turn-id={node.kind === 'turn' ? node.id : undefined}
                  data-subagent-id={node.subagentId}
                  data-fork-id={node.forkSessionId}
                  data-active={isCurrent ? 'true' : undefined}
                  onClick={() => {
                    setSelected(node.key)
                    if (!readOnly) open(node)
                  }}
                >
                  <span
                    aria-hidden="true"
                    data-marker="circle"
                    className="absolute top-1/2 size-[8px] -translate-y-1/2 rounded-full"
                    style={{
                      left: laneX(node.lane),
                      backgroundColor: color,
                      boxShadow: isCurrent
                        ? '0 0 0 1.5px var(--t-surface), 0 0 0 3px var(--t-focus-ring)'
                        : undefined,
                    }}
                  />
                  {node.kind === 'subagent' && (
                    <button
                      type="button"
                      aria-label={expanded[node.subagentId ?? ''] ? '收起子代理' : '展开子代理'}
                      aria-expanded={!!expanded[node.subagentId ?? '']}
                      data-expand-subagent={node.subagentId}
                      className="mr-1 flex size-3.5 shrink-0 items-center justify-center rounded text-[10px] text-muted transition-colors hover:bg-[var(--t-bg-active)] hover:text-text"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (node.subagentId) onToggleSubagent?.(node.subagentId)
                      }}
                    >
                      ▸
                    </button>
                  )}
                  {node.kind === 'subagent-turn' && (
                    <span className="mr-1 shrink-0 text-[10px] text-muted">└</span>
                  )}
                  {node.pinned && (
                    <Pin
                      size={8}
                      className="mr-1 shrink-0 text-muted"
                      aria-label="已固定"
                    />
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[12px] leading-4',
                      node.kind === 'turn' ? 'text-text-soft' : 'text-muted',
                      isCurrent && 'text-text',
                    )}
                  >
                    {node.kind === 'turn' && (
                      <span className="mr-1 font-mono tabular-nums text-muted">{node.turnNo}</span>
                    )}
                    {node.label}
                  </span>
                  {nodeMeta(node) && (
                    <span className="ml-1.5 shrink-0 font-mono text-[10.5px] tabular-nums text-muted">
                      {nodeMeta(node)}
                    </span>
                  )}
                  {node.kind === 'fork' ? (
                    <span className="ml-1 shrink-0 text-[10.5px] text-muted">分叉</span>
                  ) : canExpand && node.childCount ? (
                    <span className="ml-1 shrink-0 text-[10px] text-muted">+{node.childCount}</span>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="mt-1 flex shrink-0 items-center gap-2 border-t border-border pt-1.5 text-[10.5px] text-muted">
        <span className="flex items-center gap-1">
          <span className="size-[7px] rounded-full" style={{ background: laneColor(0) }} /> 主线
        </span>
        <span className="flex items-center gap-1">
          <svg width="14" height="6" aria-hidden="true">
            <path d="M1 5 C3 1, 11 1, 13 5" fill="none" stroke={laneColor(1)} strokeWidth="1.2" strokeDasharray="3 2" />
          </svg>
          子代理（合并）
        </span>
        <span className="flex items-center gap-1">
          <svg width="14" height="6" aria-hidden="true">
            <path d="M1 5 C3 1, 11 1, 13 5" fill="none" stroke={laneColor(2)} strokeWidth="1.5" />
          </svg>
          分叉（不合并）
        </span>
      </div>
    </div>
  )
}
