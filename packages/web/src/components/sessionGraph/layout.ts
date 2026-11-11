/**
 * 会话图布局：把「主线轮次 + 子代理分支 + 分叉分支」排成纵向泳道。
 * 纯函数、无 DOM：输入会话树，输出每个节点的 (lane, row) 与连线段。
 *
 * 约定：
 * - 主线固定在第 0 列，每个用户轮一行；时间倒序：最新一轮在最上。
 * - 子代理始终展开，从发起它的轮分到新泳道，最后一行汇回父会话（不合并成结果行）。
 * - 分叉从分叉点分到新泳道，不合并，末端节点即分支名。
 * - 行号在布局末尾统一翻转（见 flipRow），因此分支视觉上向上延伸。
 * - 行高固定由渲染层决定（28px）；这里只给行号与列号。
 */

export interface GraphTurn {
  id: string
  /** 1-based 轮号（只用于定位当前轮，不在节点上显示）。 */
  no: number
  preview: string
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
  status?: string
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
}

export type GraphNodeKind = 'turn' | 'subagent-turn' | 'fork'

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
  subagentId?: string
  forkSessionId?: string
  pinned?: boolean
}

export type GraphEdgeKind = 'main' | 'subagent' | 'fork'

export interface GraphEdge {
  fromLane: number
  fromRow: number
  toLane: number
  toRow: number
  kind: GraphEdgeKind
  /** 归属会话：主线=当前会话，子代理=该子代理，分叉=分叉会话；悬停时整条轨道一起高亮。 */
  ownerId: string
  /** 悬停 tooltip 显示的会话名。 */
  label: string
  /** 子代理汇回父会话的那一段。 */
  merge?: boolean
}

export interface GraphLayout {
  nodes: GraphNode[]
  edges: GraphEdge[]
  rows: number
  lanes: number
  /** 泳道号 → 横向列号（列复用后的位置；颜色仍按泳道号）。 */
  columnOf: number[]
  columns: number
  /** 每条泳道的类型。 */
  laneKinds: Array<'main' | 'subagent' | 'fork'>
}

/** 一行的高度（px）：渲染层与虚拟滚动共用。 */
export const GRAPH_ROW_H = 28
/** 相邻列的水平间距（px）：列宽固定，节点与连线都落在列中心。 */
export const GRAPH_COLUMN_GAP = 12
/** 第 0 列（主线）中心的 x 偏移（px）。 */
export const GRAPH_COLUMN_X0 = 8

/** 卡片内会话图高度：轮数少时不空大片，超过上限后固定高度、内部滚动（反馈16#09）。 */
export const GRAPH_CARD_MIN_ROWS = 3
export const GRAPH_CARD_MAX_ROWS = 12
export const GRAPH_CARD_MAX_HEIGHT = 360

export function graphCardHeight(rows: number): number {
  const min = GRAPH_ROW_H * GRAPH_CARD_MIN_ROWS
  const max = Math.min(GRAPH_ROW_H * GRAPH_CARD_MAX_ROWS, GRAPH_CARD_MAX_HEIGHT)
  return Math.min(max, Math.max(min, Math.max(1, rows) * GRAPH_ROW_H))
}

export function columnX(column: number): number {
  return GRAPH_COLUMN_X0 + column * GRAPH_COLUMN_GAP
}

/** 节点文字统一从这个 x 开始：列数 × 12px，最后一列中心右侧留 12px。 */
export function graphTextX(columns: number): number {
  return GRAPH_COLUMN_X0 + Math.max(1, columns) * GRAPH_COLUMN_GAP
}

interface PackedChildren {
  offset: Map<number, number>
  width: number
}

/**
 * 泳道 → 列。每个分支占一段连续列（自身在最左，子分支依次向右），
 * 与其它分支行区间相交的不共用列；行区间不相交的分支复用同一段列。
 * 这样分出/汇回的水平线只会穿过同一轮分出的分支在该行的转折点，不会横穿别的竖线。
 */
function assignColumns(
  nodes: GraphNode[],
  edges: GraphEdge[],
  lanes: number,
): { columnOf: number[]; columns: number } {
  const span = new Map<number, [number, number]>()
  const touch = (lane: number, row: number) => {
    const s = span.get(lane)
    span.set(lane, s ? [Math.min(s[0], row), Math.max(s[1], row)] : [row, row])
  }
  for (const node of nodes) touch(node.lane, node.row)
  const childrenOf = new Map<number, number[]>()
  for (const edge of edges) {
    if (edge.kind === 'main') continue
    touch(edge.fromLane, edge.fromRow)
    touch(edge.fromLane, edge.toRow)
    touch(edge.toLane, edge.fromRow)
    touch(edge.toLane, edge.toRow)
    if (edge.toLane > edge.fromLane) {
      childrenOf.set(edge.fromLane, [...(childrenOf.get(edge.fromLane) ?? []), edge.toLane])
    }
  }

  const packs = new Map<number, PackedChildren>()
  const blockWidth = (lane: number): number => 1 + packOf(lane).width
  const packOf = (parent: number): PackedChildren => {
    const cached = packs.get(parent)
    if (cached) return cached
    const sorted = [...(childrenOf.get(parent) ?? [])].sort((a, b) => {
      const [alo, ahi] = span.get(a)!
      const [blo, bhi] = span.get(b)!
      return alo - blo || ahi - bhi || a - b
    })
    const offset = new Map<number, number>()
    let width = 0
    for (const lane of sorted) {
      const [lo, hi] = span.get(lane)!
      const w = blockWidth(lane)
      let off = 0
      for (const [other, oo] of offset) {
        const [olo, ohi] = span.get(other)!
        if (olo > hi || lo > ohi) continue
        off = Math.max(off, oo + blockWidth(other))
      }
      offset.set(lane, off)
      width = Math.max(width, off + w)
    }
    const packed = { offset, width }
    packs.set(parent, packed)
    return packed
  }

  const columnOf = Array.from({ length: lanes }, () => 0)
  const place = (lane: number, column: number) => {
    columnOf[lane] = column
    const { offset } = packOf(lane)
    for (const child of childrenOf.get(lane) ?? []) place(child, column + 1 + offset.get(child)!)
  }
  place(0, 0)
  return { columnOf, columns: packOf(0).width + 1 }
}

/** 一个分支占用的行：last 是分支泳道最后一个自有节点行，next 是分支块之后的第一行。 */
interface BranchSpan {
  last: number
  next: number
}

export function layoutSessionGraph(input: GraphInput): GraphLayout {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const laneKinds: Array<'main' | 'subagent' | 'fork'> = ['main']
  let nextLane = 1
  let rows = 0
  let cursor = 0

  const mainTitle = input.title?.trim() || '当前会话'
  const turns = input.turns
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
   * 铺一个子代理分支。子代理始终展开：逐轮放节点，孙代理再向右分层。
   * 返回分支最后一行与块结束行；汇回线从最后一行接回父泳道。
   */
  const laySubagent = (sub: GraphSubagent, lane: number, startRow: number): BranchSpan => {
    const label = sub.title || '子代理'
    let row = startRow
    let last = startRow
    if (sub.turns.length === 0) {
      nodes.push({
        key: `subt:${sub.id}:prompt`,
        kind: 'subagent-turn',
        lane,
        row,
        id: sub.id,
        ...(sub.turnId ? { turnId: sub.turnId } : {}),
        label,
        subagentId: sub.id,
      })
      return { last: row, next: row + 1 }
    }

    for (const turn of sub.turns) {
      nodes.push({
        key: `subt:${sub.id}:${turn.id}`,
        kind: 'subagent-turn',
        lane,
        row,
        id: turn.id,
        ...(sub.turnId ? { turnId: sub.turnId } : {}),
        label: turn.preview || '（无文字）',
        subagentId: sub.id,
        ...(turn.pinned ? { pinned: true } : {}),
      })
      last = row
      let childCursor = row + 1
      for (const child of sub.children) {
        const attachHere = child.turnId
          ? child.turnId === turn.id
          : turn === sub.turns[0]
        if (!attachHere) continue
        const childLane = takeLane('subagent')
        const childEnd = laySubagent(child, childLane, childCursor)
        const childLabel = child.title || '子代理'
        // 分出：父节点 → 子泳道最后一个自有节点；汇回：该节点 → 父泳道下一行（或下一轮节点）。
        edges.push({
          fromLane: lane,
          fromRow: row,
          toLane: childLane,
          toRow: childEnd.last,
          kind: 'subagent',
          ownerId: child.id,
          label: childLabel,
        })
        edges.push({
          fromLane: childLane,
          fromRow: childEnd.last,
          toLane: lane,
          toRow: childEnd.next,
          kind: 'subagent',
          ownerId: child.id,
          label: childLabel,
          merge: true,
        })
        childCursor = Math.max(childCursor, childEnd.next)
      }
      row = Math.max(row + 1, childCursor)
    }
    return { last, next: row }
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
      label: turn.preview || '（无文字）',
      ...(turn.pinned ? { pinned: true } : {}),
    })
    rows = Math.max(rows, turnRow + 1)

    let branchEnd = turnRow
    let branchCursor = turnRow + 1
    const mergeEdges: Array<{ lane: number; row: number; sub: GraphSubagent }> = []

    for (const sub of subsByTurn.get(turn.id) ?? []) {
      const lane = takeLane('subagent')
      const end = laySubagent(sub, lane, branchCursor)
      const label = sub.title || '子代理'
      edges.push({
        fromLane: 0,
        fromRow: turnRow,
        toLane: lane,
        toRow: end.last,
        kind: 'subagent',
        ownerId: sub.id,
        label,
      })
      mergeEdges.push({ lane, row: end.last, sub })
      branchEnd = Math.max(branchEnd, end.last)
      // 同一轮派出的多个分支各占一段行，避免窄面板里文字互相压住。
      branchCursor = Math.max(branchCursor + 1, end.next)
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
      edges.push({
        fromLane: 0,
        fromRow: turnRow,
        toLane: lane,
        toRow: branchCursor,
        kind: 'fork',
        ownerId: fork.id,
        label: fork.title || '分叉',
      })
      branchEnd = Math.max(branchEnd, branchCursor)
      branchCursor += 1
    }

    const nextRow = branchEnd > turnRow ? branchCursor : turnRow + 1
    // 子代理最后一行汇回父会话：下一轮节点，或（父会话最后一轮）下一行轨道。
    for (const merge of mergeEdges) {
      if (nextRow > merge.row) {
        edges.push({
          fromLane: merge.lane,
          fromRow: merge.row,
          toLane: 0,
          toRow: nextRow,
          kind: 'subagent',
          ownerId: merge.sub.id,
          label: merge.sub.title || '子代理',
          merge: true,
        })
      }
    }
    if (mergeEdges.length && nextRow > turnRow) mainEndRow = Math.max(mainEndRow, nextRow)
    cursor = nextRow
  }

  // 主线：一条从上到下的竖线，贯穿所有主线节点（节点圆心都在线上）。
  if (mainRows.length) {
    mainEndRow = Math.max(mainEndRow, mainRows[mainRows.length - 1]!)
    rows = Math.max(rows, mainEndRow + 1)
  }

  // 空会话也保留一行，便于显示空态说明。
  if (rows === 0) rows = 1

  /**
   * 时间倒序（反馈1926#06）：布局仍按对话顺序计算，最后一次性翻转所有行号。
   * 翻转后分支从父节点向上延伸，最新的一轮出现在最上。
   */
  const flipRow = (row: number) => rows - 1 - row
  for (const node of nodes) node.row = flipRow(node.row)
  for (const edge of edges) {
    edge.fromRow = flipRow(edge.fromRow)
    edge.toRow = flipRow(edge.toRow)
  }

  // 主线竖线在翻转后重新取上下端点（覆盖汇回端点，避免线悬空）。
  if (mainRows.length) {
    const trackTop = Math.min(...mainRows.map((row) => flipRow(row)), flipRow(mainEndRow))
    const trackBottom = Math.max(...mainRows.map((row) => flipRow(row)), flipRow(mainEndRow))
    edges.unshift({
      fromLane: 0,
      fromRow: trackTop,
      toLane: 0,
      toRow: trackBottom,
      kind: 'main',
      ownerId: input.sessionId,
      label: mainTitle,
    })
  }

  // 键盘 ↑/↓ 按视觉顺序（上→下）移动。
  nodes.sort((a, b) => a.row - b.row || a.lane - b.lane)

  const lanes = Math.max(1, nextLane)
  const { columnOf, columns } = assignColumns(nodes, edges, lanes)
  return { nodes, edges, rows, lanes, columnOf, columns, laneKinds }
}
