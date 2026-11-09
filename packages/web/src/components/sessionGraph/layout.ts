/**
 * 会话图布局：把「主线轮次 + 子代理分支 + 分叉分支」排成纵向泳道。
 * 纯函数、无 DOM：输入会话树，输出每个节点的 (lane, row) 与连线段。
 *
 * 约定：
 * - 主线固定在 lane 0，每个用户轮一行，自上而下。
 * - 子代理从发起它的轮分到新泳道，完成后合并回主线的下一行（虚线）。
 * - 分叉从分叉点分到新泳道，不合并；节点即分支末端标签（实线菱形）。
 * - 行高固定由渲染层决定（28px）；这里只给行号。
 */

export interface GraphUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
  durationMs?: number
}

export interface GraphTurn {
  id: string
  /** 1-based 轮号。 */
  no: number
  preview: string
  usage?: GraphUsage
  pinned?: boolean
  /** 本轮里 Task 工具的 tool_use id，用来把子代理挂回准确的行。 */
  taskToolIds?: string[]
  /** 本轮 Task 的 description，用于旧数据没有 tool_use id 时按标题兜底匹配。 */
  taskTitles?: string[]
}

export interface GraphSubagent {
  id: string
  title: string
  /** 发起该子代理的轮次 id（父会话或父代理的某一轮）。 */
  turnId?: string
  createdAt: number
  /** 消息步数（用户/助手/工具合计），收起时展示。 */
  steps: number
  status?: string
  usage?: GraphUsage
  turns: GraphTurn[]
  children: GraphSubagent[]
}

export interface GraphFork {
  id: string
  title: string
  /** 分叉点所在的轮次 id（由调用方把消息 id 映射到用户轮）。 */
  turnId?: string
  createdAt: number
}

export interface GraphInput {
  sessionId: string
  title?: string
  turns: GraphTurn[]
  subagents: GraphSubagent[]
  forks: GraphFork[]
  /** 已展开的子代理 id；缺省全部收起为一个节点。 */
  expanded?: Record<string, boolean>
}

export type GraphNodeKind = 'turn' | 'subagent' | 'subagent-turn' | 'subagent-result' | 'fork'

export interface GraphNode {
  key: string
  kind: GraphNodeKind
  lane: number
  row: number
  /** 对应消息 id / 子代理 id / 分叉会话 id。 */
  id: string
  /** 主线轮次 id（子代理节点指向发起它的轮，便于先跳到父轮）。 */
  turnId?: string
  turnNo?: number
  label: string
  meta?: string
  subagentId?: string
  forkSessionId?: string
  pinned?: boolean
  /** 当前展开的子代理（收起节点可再点开）。 */
  collapsed?: boolean
  childCount?: number
  usage?: GraphUsage
}

export type GraphEdgeKind = 'main' | 'subagent' | 'fork'

export interface GraphEdge {
  fromLane: number
  fromRow: number
  toLane: number
  toRow: number
  kind: GraphEdgeKind
}

export interface GraphLayout {
  nodes: GraphNode[]
  edges: GraphEdge[]
  rows: number
  lanes: number
  /** 每条泳道的类型，渲染层用它给相邻泳道分配中性灰度。 */
  laneKinds: Array<'main' | 'subagent' | 'fork'>
  counts: { turns: number; subagents: number; forks: number }
}

/** 一行的高度（px）：渲染层与虚拟滚动共用。 */
export const GRAPH_ROW_H = 28
/** 相邻泳道的水平间距（px）：图区宽度 = 泳道数 × 14px。 */
export const GRAPH_LANE_GAP = 14
/** 主线泳道在左侧留白内的 x 偏移（px）。 */
export const GRAPH_LANE_X0 = 7

/** 卡片内会话图高度：轮数少时不空大片，超过上限后固定高度、内部滚动（反馈16#09）。 */
export const GRAPH_CARD_MIN_ROWS = 3
export const GRAPH_CARD_MAX_ROWS = 12
export const GRAPH_CARD_MAX_HEIGHT = 360

export function graphCardHeight(rows: number): number {
  const min = GRAPH_ROW_H * GRAPH_CARD_MIN_ROWS
  const max = Math.min(GRAPH_ROW_H * GRAPH_CARD_MAX_ROWS, GRAPH_CARD_MAX_HEIGHT)
  return Math.min(max, Math.max(min, Math.max(1, rows) * GRAPH_ROW_H))
}

export function laneX(lane: number): number {
  return GRAPH_LANE_X0 + lane * GRAPH_LANE_GAP
}

/** 节点文字统一从这个 x 开始：图区宽度 = 泳道数 × 14px（在最后一个泳道右侧留 7px）。 */
export function graphTextX(lanes: number): number {
  return GRAPH_LANE_X0 + Math.max(1, lanes) * GRAPH_LANE_GAP + 7
}

function countSubagents(list: GraphSubagent[]): number {
  let n = 0
  for (const sub of list) {
    n += 1 + countSubagents(sub.children)
  }
  return n
}

export function layoutSessionGraph(input: GraphInput): GraphLayout {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const laneKinds: Array<'main' | 'subagent' | 'fork'> = ['main']
  let nextLane = 1
  let rows = 0
  let cursor = 0

  const turns = input.turns
  const expanded = input.expanded ?? {}
  const mainTurns = new Map(turns.map((turn) => [turn.id, turn]))
  const forksByTurn = new Map<string, GraphFork[]>()
  for (const fork of input.forks) {
    const key = fork.turnId && mainTurns.has(fork.turnId) ? fork.turnId : turns[turns.length - 1]?.id
    if (!key) continue
    const list = forksByTurn.get(key) ?? []
    list.push(fork)
    forksByTurn.set(key, list)
  }
  const subsByTurn = new Map<string, GraphSubagent[]>()
  for (const sub of input.subagents) {
    const key = sub.turnId && mainTurns.has(sub.turnId) ? sub.turnId : turns[0]?.id
    if (!key) continue
    const list = subsByTurn.get(key) ?? []
    list.push(sub)
    subsByTurn.set(key, list)
  }

  const takeLane = (kind: 'subagent' | 'fork'): number => {
    const lane = nextLane
    nextLane += 1
    laneKinds[lane] = kind
    return lane
  }

  /**
   * 铺一个子代理分支。返回分支最后一行（合并线的起点行）。
   * 收起时只放一个节点；展开时逐轮 + 结果节点，孙代理再向右分层。
   */
  const laySubagent = (sub: GraphSubagent, lane: number, startRow: number): number => {
    const isOpen = !!expanded[sub.id]
    if (!isOpen) {
      nodes.push({
        key: `sub:${sub.id}`,
        kind: 'subagent',
        lane,
        row: startRow,
        id: sub.id,
        ...(sub.turnId ? { turnId: sub.turnId } : {}),
        label: sub.title || '子代理',
        meta: `${sub.steps} 步`,
        subagentId: sub.id,
        collapsed: true,
        ...(sub.children.length ? { childCount: sub.children.length } : {}),
        ...(sub.usage ? { usage: sub.usage } : {}),
      })
      return startRow
    }

    let row = startRow
    for (const turn of sub.turns) {
      nodes.push({
        key: `subt:${sub.id}:${turn.id}`,
        kind: 'subagent-turn',
        lane,
        row,
        id: turn.id,
        ...(sub.turnId ? { turnId: sub.turnId } : {}),
        turnNo: turn.no,
        label: turn.preview || `第 ${turn.no} 步`,
        subagentId: sub.id,
        ...(turn.pinned ? { pinned: true } : {}),
        ...(turn.usage ? { usage: turn.usage } : {}),
      })
      let end = row
      let childCursor = row + 1
      for (const child of sub.children) {
        const attachHere = child.turnId
          ? child.turnId === turn.id
          : turn === sub.turns[0]
        if (!attachHere) continue
        const childLane = takeLane('subagent')
        const childEnd = laySubagent(child, childLane, childCursor)
        // 分出后一条竖线贯穿该分支的所有节点，再折回父泳道（合并）。
        edges.push({ fromLane: lane, fromRow: row, toLane: childLane, toRow: childEnd, kind: 'subagent' })
        edges.push({ fromLane: childLane, fromRow: childEnd, toLane: lane, toRow: childEnd + 1, kind: 'subagent' })
        childCursor = Math.max(childCursor, childEnd + 1)
        if (childEnd > end) end = childEnd
      }
      row = Math.max(row + 1, childCursor, end + 1)
    }

    // 子代理至少用一行；没有多轮时也要有一个结果节点（设计决定 #3）。
    if (sub.turns.length === 0) {
      nodes.push({
        key: `subt:${sub.id}:prompt`,
        kind: 'subagent-turn',
        lane,
        row,
        id: sub.id,
        ...(sub.turnId ? { turnId: sub.turnId } : {}),
        label: sub.title || '子代理任务',
        subagentId: sub.id,
      })
      row += 1
    }
    nodes.push({
      key: `subr:${sub.id}`,
      kind: 'subagent-result',
      lane,
      row,
      id: sub.id,
      ...(sub.turnId ? { turnId: sub.turnId } : {}),
      label: '结果已返回',
      subagentId: sub.id,
    })
    return row
  }

  const mainRows: number[] = []
  let mainEndRow = 0
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!
    const turnRow = cursor
    mainRows.push(turnRow)
    mainEndRow = turnRow
    nodes.push({
      key: `turn:${turn.id}`,
      kind: 'turn',
      lane: 0,
      row: turnRow,
      id: turn.id,
      turnId: turn.id,
      turnNo: turn.no,
      label: turn.preview || `第 ${turn.no} 轮`,
      ...(turn.pinned ? { pinned: true } : {}),
      ...(turn.usage ? { usage: turn.usage } : {}),
    })
    rows = Math.max(rows, turnRow + 1)

    let branchEnd = turnRow
    let branchCursor = turnRow + 1
    const mergeEdges: Array<{ lane: number; row: number }> = []

    for (const sub of subsByTurn.get(turn.id) ?? []) {
      const lane = takeLane('subagent')
      const end = laySubagent(sub, lane, branchCursor)
      edges.push({ fromLane: 0, fromRow: turnRow, toLane: lane, toRow: end, kind: 'subagent' })
      mergeEdges.push({ lane, row: end })
      branchEnd = Math.max(branchEnd, end)
      // 同一轮派出的多个分支各占一段行，避免窄面板里文字互相压住。
      branchCursor = Math.max(branchCursor + 1, end + 1)
    }

    for (const fork of forksByTurn.get(turn.id) ?? []) {
      const lane = takeLane('fork')
      nodes.push({
        key: `fork:${fork.id}`,
        kind: 'fork',
        lane,
        row: branchCursor,
        id: fork.id,
        turnId: turn.id,
        label: fork.title || '分叉',
        forkSessionId: fork.id,
      })
      edges.push({ fromLane: 0, fromRow: turnRow, toLane: lane, toRow: branchCursor, kind: 'fork' })
      branchEnd = Math.max(branchEnd, branchCursor)
      branchCursor += 1
    }

    const nextRow = branchEnd > turnRow ? branchCursor : turnRow + 1
    // 子代理完成后合并回主线：连到下一轮所在行（虚线），表示结果返回。
    for (const merge of mergeEdges) {
      if (nextRow > merge.row) {
        edges.push({ fromLane: merge.lane, fromRow: merge.row, toLane: 0, toRow: nextRow, kind: 'subagent' })
      }
    }
    if (index === turns.length - 1 && mergeEdges.length) mainEndRow = Math.max(mainEndRow, nextRow)
    cursor = nextRow
    rows = Math.max(rows, nextRow)
  }

  // 主线：一条从上到下的竖线，贯穿所有主线节点（节点圆心都在线上）。
  if (mainRows.length) {
    edges.unshift({ fromLane: 0, fromRow: mainRows[0]!, toLane: 0, toRow: mainEndRow, kind: 'main' })
  }

  // 空会话也保留一行，便于显示空态说明。
  if (rows === 0) rows = 1

  return {
    nodes,
    edges,
    rows,
    lanes: Math.max(1, nextLane),
    laneKinds,
    counts: {
      turns: turns.length,
      subagents: countSubagents(input.subagents),
      forks: input.forks.length,
    },
  }
}

/** 收起标题行的一句话：`12 轮 · 3 子代理 · 1 分叉`。 */
export function graphSummaryLabel(layout: GraphLayout): string {
  const parts = [`${layout.counts.turns} 轮`]
  if (layout.counts.subagents > 0) parts.push(`${layout.counts.subagents} 子代理`)
  if (layout.counts.forks > 0) parts.push(`${layout.counts.forks} 分叉`)
  return parts.join(' · ')
}
