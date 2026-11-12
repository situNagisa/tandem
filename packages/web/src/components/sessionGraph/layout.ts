/**
 * 会话图布局：一棵会话树（根 + 递归分叉 + 所有子代理）只有一张拓扑，
 * 节点是「轮次」，边是「下一轮 / 分叉自某轮 / 子代理派出与汇回」。
 * 树内任何会话打开时节点与边完全相同，只有「主线」（trunk）随当前会话切换。
 *
 * 约定（照 git log --graph 理解）：
 * - 主线 = 当前会话的祖先链：当前会话的轮次 + 它来源会话在分叉点之前的轮次（递归到根），
 *   全部落在第 0 列、一条直线上去。
 * - 其余会话的独有轮次从它们与主线的分叉点分到分支泳道；分叉点的来源会话在分叉点之后的
 *   轮次也是一条分支泳道。
 * - 子代理泳道挂在各自父轮上（主线轮的也要显示），最后一行汇回父会话的下一轮或轨道下一行。
 * - 行号在布局末尾统一翻转（flipRow），因此分支视觉上向上延伸、最新一轮在最上。
 */

export interface GraphTurn {
  id: string
  /** 1-based 轮号（只用于定位当前轮，不在节点上显示）。 */
  no: number
  preview: string
  pinned?: boolean
}

export interface GraphSession {
  id: string
  title: string
  /** root = 树根会话；fork = 分叉；subagent = Task 子代理会话。 */
  kind: 'root' | 'fork' | 'subagent'
  /** 父会话 id（分叉 = forkedFrom；子代理 = parentId）。 */
  parentId?: string
  /** 接入点所属会话（可能是祖先会话）与接入轮次。 */
  attachSessionId?: string
  attachTurnId?: string
  /** 该会话正在运行：它最新一轮的节点显示运行动画。 */
  running?: boolean
  /** 本会话独有的轮次（分叉不含复制来的祖先轮次），对话顺序。 */
  turns: GraphTurn[]
}

export interface GraphTreeInput {
  /** 当前打开的会话：决定哪条链是主线。 */
  sessionId: string
  sessions: GraphSession[]
}

export interface GraphLayoutOptions {
  /** 紧凑模式（侧栏悬停浮层）：不显示轮次标题，只在每个会话的一个节点上显示会话名。 */
  compact?: boolean
  /** 主线用哪个会话（缺省 = input.sessionId）；右栏传当前打开的会话，悬停浮层传正在查看的会话。 */
  trunkId?: string
}

export type GraphNodeKind = 'turn' | 'subagent-turn' | 'fork'

export interface GraphNode {
  key: string
  kind: GraphNodeKind
  lane: number
  row: number
  /** 该轮用户消息 id（点击定位）。 */
  id: string
  turnId: string
  turnNo: number
  label: string
  sessionId: string
  sessionTitle: string
  relation: 'root' | 'fork' | 'subagent'
  /** 主线（当前会话祖先链）上的节点。 */
  trunk?: boolean
  /** 属于当前打开的会话。 */
  current?: boolean
  /** 该会话在图里的会话名节点（会话起点；紧凑模式只在这里显示会话名）。 */
  sessionLabel?: boolean
  /** 该轮派出了子代理或分出了分叉（紧凑模式必须保留的拓扑节点）。 */
  attachPoint?: boolean
  subagentId?: string
  forkSessionId?: string
  pinned?: boolean
  /** 所属会话正在运行。 */
  running?: boolean
}

export type GraphEdgeKind = 'main' | 'subagent' | 'fork'

export interface GraphEdge {
  fromLane: number
  fromRow: number
  toLane: number
  toRow: number
  kind: GraphEdgeKind
  /** 归属会话；悬停时该会话的节点与线一起高亮。 */
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
  /** 每条泳道归属的会话（点线跳转用；主线泳道是当前会话）。 */
  sessionOfLane: string[]
}

/** 一行的高度（px）：渲染层与虚拟滚动共用。 */
export const GRAPH_ROW_H = 28
/**
 * 相邻列的水平间距（px）：列宽固定，节点与连线都落在列中心。
 * 14px 留出连线的透明命中带（两侧各 6px），相邻泳道的命中区不会互相盖住（反馈0220#07）。
 */
export const GRAPH_COLUMN_GAP = 14
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
    touch(edge.fromLane, edge.fromRow)
    touch(edge.fromLane, edge.toRow)
    touch(edge.toLane, edge.fromRow)
    touch(edge.toLane, edge.toRow)
    if (edge.fromLane === edge.toLane) continue
    if (edge.toLane > edge.fromLane) {
      childrenOf.set(edge.fromLane, [...(childrenOf.get(edge.fromLane) ?? []), edge.toLane])
    }
  }

  const packs = new Map<number, PackedChildren>()
  const blockWidth = (lane: number): number => 1 + packOf(lane).width
  const packOf = (parent: number): PackedChildren => {
    const cached = packs.get(parent)
    if (cached) return cached
    const sorted = [...new Set(childrenOf.get(parent) ?? [])].sort((a, b) => {
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
  const place = (lane: number, column: number, seen: Set<number>) => {
    if (seen.has(lane)) return
    seen.add(lane)
    columnOf[lane] = column
    const { offset } = packOf(lane)
    for (const child of new Set(childrenOf.get(lane) ?? [])) {
      place(child, column + 1 + offset.get(child)!, seen)
    }
  }
  place(0, 0, new Set())
  // 没连到主线的异常泳道也放到第 0 列右侧，避免挤在同一列。
  for (let lane = 0; lane < lanes; lane += 1) {
    if (!span.has(lane)) continue
    if (!columnOf[lane] && lane !== 0) columnOf[lane] = packOf(0).width
  }
  return { columnOf, columns: Math.max(1, packOf(0).width + 1) }
}

interface Span {
  last: number
  next: number
}

export function layoutSessionGraph(
  input: GraphTreeInput,
  options: GraphLayoutOptions = {},
): GraphLayout {
  // 紧凑模式只保留能看出拓扑的轮次：每个会话的起点与最新轮、分叉/派出点、汇回点；
  // 同一会话里相邻保留轮之间由该泳道的直线连起来，其余普通轮省略。
  const attachTurns = new Set<string>()
  const mergeAttachTurns = new Set<string>()
  for (const session of input.sessions) {
    if (!session.attachTurnId) continue
    attachTurns.add(session.attachTurnId)
    // 只有子代理会汇回父会话：保留它的汇回点；分叉不汇回，没有汇回点。
    if (session.kind === 'subagent') mergeAttachTurns.add(session.attachTurnId)
  }
  const activeSessionId = options.trunkId ?? input.sessionId
  const sessions: GraphSession[] = options.compact
    ? input.sessions.map((session) => {
        if (session.turns.length <= 2) return session
        const keep = new Set<number>([0, session.turns.length - 1])
        session.turns.forEach((turn, index) => {
          if (!attachTurns.has(turn.id)) return
          keep.add(index)
          // 汇回点：子代理返回后父会话继续的那一轮。
          if (mergeAttachTurns.has(turn.id) && index + 1 < session.turns.length) keep.add(index + 1)
        })
        const turns = session.turns.filter((_, index) => keep.has(index))
        return turns.length === session.turns.length ? session : { ...session, turns }
      })
    : input.sessions
  const byId = new Map<string, GraphSession>()
  for (const session of sessions) byId.set(session.id, session)
  const turnSession = new Map<string, GraphSession>()
  const turnOrder = new Map<string, number>()
  const turnData = new Map<string, GraphTurn>()
  for (const session of sessions) {
    session.turns.forEach((turn, index) => {
      if (turnSession.has(turn.id)) return
      turnSession.set(turn.id, session)
      turnOrder.set(turn.id, index)
      turnData.set(turn.id, turn)
    })
  }
  const chainNext = (turnId: string): string | undefined => {
    const session = turnSession.get(turnId)
    if (!session) return undefined
    return session.turns[turnOrder.get(turnId)! + 1]?.id
  }
  const ownersOfAttach = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.attachTurnId || session.turns.length === 0) continue
    const list = ownersOfAttach.get(session.attachTurnId) ?? []
    list.push(session.id)
    ownersOfAttach.set(session.attachTurnId, list)
  }
  for (const list of ownersOfAttach.values()) {
    list.sort((a, b) => {
      const sa = byId.get(a)!
      const sb = byId.get(b)!
      const rank = (kind: GraphSession['kind']) => (kind === 'subagent' ? 0 : 1)
      return rank(sa.kind) - rank(sb.kind) || sa.title.localeCompare(sb.title)
    })
  }

  // 主线：当前会话的祖先链（对话顺序，旧 → 新）。
  const chainPrefix = (sessionId: string, upto?: string): string[] => {
    const session = byId.get(sessionId)
    if (!session) return []
    const index = upto ? session.turns.findIndex((turn) => turn.id === upto) : session.turns.length - 1
    if (index < 0) return []
    const own = session.turns.slice(0, index + 1).map((turn) => turn.id)
    const above =
      session.attachSessionId && session.attachTurnId
        ? chainPrefix(session.attachSessionId, session.attachTurnId)
        : []
    return above.concat(own)
  }
  const trunk: string[] = []
  const trunkSet = new Set<string>()
  const addTrunk = (ids: string[]) => {
    for (const id of ids) {
      if (!turnSession.has(id) || trunkSet.has(id)) continue
      trunkSet.add(id)
      trunk.push(id)
    }
  }
  const current = byId.get(activeSessionId)
  if (current) {
    if (current.attachSessionId && current.attachTurnId) {
      addTrunk(chainPrefix(current.attachSessionId, current.attachTurnId))
    }
    addTrunk(current.turns.map((turn) => turn.id))
  }
  if (trunk.length === 0) {
    // 当前会话没有轮次：退回树根会话的链，保证有一条主线可用。
    const anchor =
      sessions.find((session) => session.kind === 'root') ?? sessions[0]
    if (anchor) {
      addTrunk(
        anchor.attachSessionId && anchor.attachTurnId
          ? chainPrefix(anchor.attachSessionId, anchor.attachTurnId)
          : anchor.turns.map((turn) => turn.id),
      )
    }
  }

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const laneKinds: Array<'main' | 'subagent' | 'fork'> = ['main']
  const sessionOfLane: string[] = [activeSessionId]
  let nextLane = 1
  const rowOf = new Map<string, number>()
  const laneOf = new Map<string, number>()
  /** 该轮所在泳道“继续”的行：父会话下一轮的行，或该轮子树的下一行（汇回端点）。 */
  const blockEnd = new Map<string, number>()
  const lastOfSession = new Map<string, string>()

  const takeLane = (kind: GraphSession['kind'], sessionId: string): number => {
    const lane = nextLane
    nextLane += 1
    laneKinds[lane] = kind === 'subagent' ? 'subagent' : 'fork'
    sessionOfLane[lane] = sessionId
    return lane
  }
  const place = (turnId: string, lane: number, row: number) => {
    const session = turnSession.get(turnId)!
    const turn = turnData.get(turnId)!
    const relation = session.kind
    const kind: GraphNodeKind =
      relation === 'fork' ? 'fork' : relation === 'subagent' ? 'subagent-turn' : 'turn'
    nodes.push({
      key: `${session.id}:${turnId}`,
      kind,
      lane,
      row,
      id: turnId,
      turnId,
      turnNo: turn.no,
      label: turn.preview || '（无文字）',
      sessionId: session.id,
      sessionTitle: session.title,
      relation,
      ...(turnOrder.get(turnId) === 0 ? { sessionLabel: true } : {}),
      ...(ownersOfAttach.has(turnId) ? { attachPoint: true } : {}),
      ...(trunkSet.has(turnId) ? { trunk: true } : {}),
      ...(session.id === activeSessionId ? { current: true } : {}),
      ...(turn.pinned ? { pinned: true } : {}),
      ...(session.running ? { running: true } : {}),
      ...(relation === 'subagent' ? { subagentId: session.id } : {}),
      ...(relation === 'fork' ? { forkSessionId: session.id } : {}),
    })
    rowOf.set(turnId, row)
    laneOf.set(turnId, lane)
    lastOfSession.set(session.id, turnId)
  }

  /** 铺一条泳道上的会话链（含其派出的子代理与分叉）。 */
  const layChain = (turnId: string, lane: number, startRow: number): Span => {
    let row = startRow
    place(turnId, lane, row)
    let cursor = row + 1
    for (const childId of ownersOfAttach.get(turnId) ?? []) {
      const child = byId.get(childId)!
      const first = child.turns[0]
      if (!first || trunkSet.has(first.id)) continue
      const childLane = takeLane(child.kind, child.id)
      const span = layChain(first.id, childLane, cursor)
      edges.push({
        fromLane: lane,
        fromRow: row,
        toLane: childLane,
        toRow: rowOf.get(first.id)!,
        kind: child.kind === 'subagent' ? 'subagent' : 'fork',
        ownerId: child.id,
        label: child.title,
      })
      cursor = Math.max(cursor, span.next)
    }
    const next = chainNext(turnId)
    if (next) {
      const span = layChain(next, lane, cursor)
      blockEnd.set(turnId, rowOf.get(next)!)
      return { last: span.last, next: span.next }
    }
    blockEnd.set(turnId, cursor)
    return { last: Math.max(row, cursor - 1), next: cursor }
  }

  let row = 0
  let laidAny = false
  for (let index = 0; index < trunk.length; index += 1) {
    const turnId = trunk[index]!
    const nextTrunk = trunk[index + 1]
    place(turnId, 0, row)
    laidAny = true
    let cursor = row + 1
    // 该轮派出的分叉/子代理（主线上的也要画）。
    for (const childId of ownersOfAttach.get(turnId) ?? []) {
      const child = byId.get(childId)!
      const first = child.turns[0]
      if (!first || trunkSet.has(first.id)) continue
      const childLane = takeLane(child.kind, child.id)
      const span = layChain(first.id, childLane, cursor)
      edges.push({
        fromLane: 0,
        fromRow: row,
        toLane: childLane,
        toRow: rowOf.get(first.id)!,
        kind: child.kind === 'subagent' ? 'subagent' : 'fork',
        ownerId: child.id,
        label: child.title,
      })
      cursor = Math.max(cursor, span.next)
    }
    // 祖先会话在分叉点之后的轮次：分支泳道（当前查看的分叉在主线）。
    const next = chainNext(turnId)
    if (next && !trunkSet.has(next)) {
      const owner = turnSession.get(next)!
      const childLane = takeLane('fork', owner.id)
      const span = layChain(next, childLane, cursor)
      edges.push({
        fromLane: 0,
        fromRow: row,
        toLane: childLane,
        toRow: rowOf.get(next)!,
        kind: 'fork',
        ownerId: owner.id,
        label: owner.title,
      })
      cursor = Math.max(cursor, span.next)
    }
    row = nextTrunk ? cursor : Math.max(row + 1, cursor)
    blockEnd.set(turnId, row)
  }
  if (!laidAny) {
    // 主线为空（当前会话不在树里或没有轮次）：把树根会话的链铺在第 0 列。
    const anchor =
      sessions.find((session) => session.kind === 'root') ?? sessions[0]
    const first = anchor?.turns[0]
    if (first) {
      const span = layChain(first.id, 0, 0)
      row = span.next
    }
  }
  // 兜底：接入点落在已删除的祖先/轮次上时，把剩下的会话按独立泳道铺出来，不丢节点。
  for (const session of sessions) {
    const first = session.turns[0]
    if (!first || rowOf.has(first.id)) continue
    const lane = takeLane(session.kind, session.id)
    const span = layChain(first.id, lane, row)
    row = Math.max(row, span.next)
  }

  // 子代理汇回父会话：父会话的下一轮（或轨道下一行）。
  for (const session of sessions) {
    if (session.kind !== 'subagent') continue
    const last = lastOfSession.get(session.id)
    if (!last) continue
    const attach = session.attachTurnId
    let target: { lane: number; row: number } | undefined
    if (attach) {
      const next = chainNext(attach)
      if (next && rowOf.has(next)) target = { lane: laneOf.get(next)!, row: rowOf.get(next)! }
      else {
        const lane = laneOf.get(attach)
        const end = blockEnd.get(attach)
        if (lane !== undefined && end !== undefined) target = { lane, row: end }
      }
    }
    if (!target) continue
    const lane = laneOf.get(last)!
    const fromRow = rowOf.get(last)!
    if (lane === target.lane && target.row === fromRow) continue
    edges.push({
      fromLane: lane,
      fromRow,
      toLane: target.lane,
      toRow: target.row,
      kind: 'subagent',
      ownerId: session.id,
      label: session.title,
      merge: true,
    })
  }

  // 每条泳道一条连续竖线（闂盖所有节点与连线端点），主线即一条直线上去。
  const laneSpan = new Map<number, [number, number]>()
  const touchLane = (lane: number, atRow: number) => {
    const span = laneSpan.get(lane)
    laneSpan.set(lane, span ? [Math.min(span[0], atRow), Math.max(span[1], atRow)] : [atRow, atRow])
  }
  for (const node of nodes) touchLane(node.lane, node.row)
  for (const edge of edges) {
    touchLane(edge.fromLane, edge.fromRow)
    touchLane(edge.toLane, edge.toRow)
  }
  for (let lane = 0; lane < nextLane; lane += 1) {
    const span = laneSpan.get(lane)
    if (!span) continue
    const ownerId = sessionOfLane[lane] ?? input.sessionId
    edges.push({
      fromLane: lane,
      fromRow: span[0],
      toLane: lane,
      toRow: span[1],
      kind: laneKinds[lane]!,
      ownerId,
      label: byId.get(ownerId)?.title ?? current?.title ?? '',
    })
  }

  let rows = 1
  for (const node of nodes) rows = Math.max(rows, node.row + 1)
  for (const edge of edges) rows = Math.max(rows, edge.fromRow + 1, edge.toRow + 1)

  /**
   * 时间倒序（反馈1926#06）：布局仍按对话顺序计算，最后一次性翻转所有行号。
   * 翻转后分支从父节点向上延伸，最新的一轮出现在最上。
   */
  const flipRow = (value: number) => rows - 1 - value
  for (const node of nodes) node.row = flipRow(node.row)
  for (const edge of edges) {
    edge.fromRow = flipRow(edge.fromRow)
    edge.toRow = flipRow(edge.toRow)
    // 同泳道的竖线统一成从上往下（起点在上），几何断言与 tooltip 都不依赖方向。
    if (edge.fromLane === edge.toLane && edge.fromRow > edge.toRow) {
      const row = edge.fromRow
      edge.fromRow = edge.toRow
      edge.toRow = row
    }
  }

  // 键盘 ↑/↓ 按视觉顺序（上→下）移动。
  nodes.sort((a, b) => a.row - b.row || a.lane - b.lane)

  const lanes = Math.max(1, nextLane)
  const { columnOf, columns } = assignColumns(nodes, edges, lanes)
  return {
    nodes,
    edges,
    rows,
    lanes,
    columnOf,
    columns,
    laneKinds,
    sessionOfLane,
  }
}
