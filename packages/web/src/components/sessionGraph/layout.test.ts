import { describe, expect, it } from 'vitest'
import {
  GRAPH_ROW_H,
  graphCardHeight,
  columnX,
  layoutSessionGraph,
  type GraphLayout,
  type GraphSession,
  type GraphTreeInput,
  type GraphTurn,
} from './layout'

function chain(n: number, prefix = 't'): GraphTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    no: i + 1,
    preview: `用户第 ${i + 1} 轮`,
  }))
}

function session(
  id: string,
  kind: GraphSession['kind'],
  turns: GraphTurn[],
  extra: Partial<GraphSession> = {},
): GraphSession {
  return { id, title: `${id} 会话`, kind, turns, ...extra }
}

function tree(sessionId: string, sessions: GraphSession[]): GraphTreeInput {
  return { sessionId, sessions }
}

const byId = (layout: GraphLayout, turnId: string) =>
  layout.nodes.find((node) => node.id === turnId)

const topDown = (layout: GraphLayout) =>
  [...layout.nodes].sort((a, b) => a.row - b.row).map((node) => node.id)

/** 步骤里的演示树：根 6 轮，r3 分出 3 轮的分叉，r5 派 1 个 2 轮子代理。 */
function demoTree(): GraphSession[] {
  return [
    session('R', 'root', chain(6, 'r'), { title: '根会话' }),
    session('F', 'fork', chain(3, 'f'), {
      title: '分叉会话',
      parentId: 'R',
      attachSessionId: 'R',
      attachTurnId: 'r3',
    }),
    session('S', 'subagent', chain(2, 's'), {
      title: '子代理会话',
      parentId: 'R',
      attachSessionId: 'R',
      attachTurnId: 'r5',
    }),
  ]
}

describe('layoutSessionGraph（整棵树共用一张拓扑）', () => {
  it('根会话视图：主线每轮一行，时间倒序，最新一轮在最上', () => {
    const layout = layoutSessionGraph(tree('R', demoTree()))
    const trunk = layout.nodes.filter((node) => node.trunk)
    // 视觉顺序（上→下）：最新一轮在最上。
    expect(trunk.map((node) => node.id)).toEqual(['r6', 'r5', 'r4', 'r3', 'r2', 'r1'])
    expect(trunk.every((node) => node.lane === 0)).toBe(true)
    // 视觉顺序：最新一轮在最上，越早越下。
    expect(topDown(layout)[0]).toBe('r6')
    expect(byId(layout, 'r6')!.row).toBeLessThan(byId(layout, 'r1')!.row)
    const rows = trunk.map((node) => node.row)
    expect(rows).toEqual([...rows].sort((a, b) => a - b))
  })

  it('同一棵树在主会话与分叉里节点与连线完全相同，只有主线不同', () => {
    const fromMain = layoutSessionGraph(tree('R', demoTree()))
    const fromFork = layoutSessionGraph(tree('F', demoTree()))
    const keys = (layout: GraphLayout) => layout.nodes.map((node) => node.key).sort()
    expect(keys(fromMain)).toEqual(keys(fromFork))
    // 汇回边（子代理返回父会话）是两侧都稳定存在的拓扑关系。
    const merges = (layout: GraphLayout) =>
      layout.edges.filter((edge) => edge.merge).map((edge) => edge.ownerId).sort()
    expect(merges(fromMain)).toEqual(merges(fromFork))
    expect(merges(fromMain)).toEqual(['S'])
    // 只有主线（哪些轮在 trunk 上）不同。
    expect(fromMain.nodes.filter((node) => node.trunk).map((node) => node.id).sort()).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
      'r6',
    ])
    expect(fromFork.nodes.filter((node) => node.trunk).map((node) => node.id).sort()).toEqual([
      'f1',
      'f2',
      'f3',
      'r1',
      'r2',
      'r3',
    ])
  })

  it('分叉视图：主线 = 分叉点前的根轮次 + 分叉轮次，一条直线上去', () => {
    const layout = layoutSessionGraph(tree('F', demoTree()))
    const trunk = layout.nodes
      .filter((node) => node.trunk)
      .sort((a, b) => a.row - b.row)
      .map((node) => node.id)
    expect(trunk).toEqual(['f3', 'f2', 'f1', 'r3', 'r2', 'r1'])
    // 主线都在第 0 列，且由一条竖线贯穿。
    const trunkNodes = layout.nodes.filter((node) => node.trunk)
    expect(trunkNodes.every((node) => node.lane === 0)).toBe(true)
    const mainLine = layout.edges.find(
      (edge) => edge.kind === 'main' && edge.fromLane === 0 && edge.toLane === 0,
    )
    expect(mainLine).toBeTruthy()
    expect(Math.min(...trunkNodes.map((node) => node.row))).toBeGreaterThanOrEqual(
      Math.min(mainLine!.fromRow, mainLine!.toRow),
    )
    expect(Math.max(...trunkNodes.map((node) => node.row))).toBeLessThanOrEqual(
      Math.max(mainLine!.fromRow, mainLine!.toRow),
    )
  })

  it('分叉视图：来源会话在分叉点之后的轮次是完整分支泳道，不是单节点「原会话」支线', () => {
    const layout = layoutSessionGraph(tree('F', demoTree()))
    expect(layout.nodes.some((node) => node.label.includes('原会话'))).toBe(false)
    const branch = layout.nodes.filter((node) => node.sessionId === 'R' && !node.trunk)
    expect(branch.map((node) => node.id).sort()).toEqual(['r4', 'r5', 'r6'])
    expect(new Set(branch.map((node) => node.lane)).size).toBe(1)
    // 分支从分叉点 r3 分出去（不是从根节点）。
    const out = layout.edges.find(
      (edge) => edge.kind === 'fork' && edge.ownerId === 'R' && edge.fromRow === byId(layout, 'r3')!.row,
    )
    expect(out).toBeTruthy()
    expect(out!.fromLane).toBe(0)
    expect(out!.toLane).toBe(branch[0]!.lane)
  })

  it('分叉视图里主会话上的子代理仍可见，并挂在派出它的那一轮（分支上）', () => {
    const layout = layoutSessionGraph(tree('F', demoTree()))
    const sub = layout.nodes.find((node) => node.sessionId === 'S')
    expect(sub).toBeTruthy()
    const attach = byId(layout, 'r5')!
    expect(attach.sessionId).toBe('R')
    expect(layout.nodes.filter((node) => node.sessionId === 'S').every((node) => node.lane !== 0)).toBe(
      true,
    )
    const out = layout.edges.find(
      (edge) =>
        edge.kind === 'subagent' &&
        edge.ownerId === 'S' &&
        !edge.merge &&
        edge.fromRow === attach.row,
    )
    expect(out).toBeTruthy()
    expect(out!.fromLane).toBe(attach.lane)
  })

  it('子代理最后一行汇回父会话的下一轮；分叉不汇回', () => {
    const layout = layoutSessionGraph(tree('R', demoTree()))
    const merge = layout.edges.find((edge) => edge.kind === 'subagent' && edge.merge && edge.ownerId === 'S')
    expect(merge).toBeTruthy()
    // 汇回从子代理最后一行（对话顺序最后一轮，视觉上更靠上）出发。
    const subLast = layout.nodes
      .filter((node) => node.sessionId === 'S')
      .sort((a, b) => a.row - b.row)[0]!
    expect(merge!.fromRow).toBe(subLast.row)
    expect(merge!.fromLane).toBe(subLast.lane)
    expect(merge!.toRow).toBe(byId(layout, 'r6')!.row)
    expect(merge!.toLane).toBe(0)
    expect(layout.edges.some((edge) => edge.kind === 'fork' && edge.merge)).toBe(false)
  })

  it('嵌套子代理：孙代理在父代理泳道右侧，顺序与汇回端点都在父泳道', () => {
    const sessions: GraphSession[] = [
      session('R', 'root', chain(2, 'r')),
      session('C', 'subagent', chain(2, 'c'), {
        parentId: 'R',
        attachSessionId: 'R',
        attachTurnId: 'r1',
      }),
      session('G', 'subagent', chain(1, 'g'), {
        parentId: 'C',
        attachSessionId: 'C',
        attachTurnId: 'c2',
      }),
    ]
    const layout = layoutSessionGraph(tree('R', sessions))
    const middle = byId(layout, 'c2')!
    const leaf = byId(layout, 'g1')!
    expect(leaf.lane).not.toBe(middle.lane)
    expect(layout.columnOf[leaf.lane]!).toBeGreaterThan(layout.columnOf[middle.lane]!)
    const out = layout.edges.find((edge) => edge.kind === 'subagent' && edge.ownerId === 'G' && !edge.merge)
    expect(out!.fromLane).toBe(middle.lane)
    expect(out!.toLane).toBe(leaf.lane)
  })

  it('同一轮并行派出的分支各占一段列，水平线不穿过别的竖线', () => {
    const sessions: GraphSession[] = [
      session('R', 'root', chain(3, 'r')),
      session('A', 'subagent', chain(1, 'a'), {
        parentId: 'R',
        attachSessionId: 'R',
        attachTurnId: 'r1',
      }),
      session('B', 'fork', chain(1, 'b'), {
        parentId: 'R',
        attachSessionId: 'R',
        attachTurnId: 'r1',
      }),
    ]
    const layout = layoutSessionGraph(tree('R', sessions))
    const a = byId(layout, 'a1')!
    const b = byId(layout, 'b1')!
    expect(a.lane).not.toBe(b.lane)
    expect(columnX(layout.columnOf[a.lane]!)).not.toBe(columnX(layout.columnOf[b.lane]!))
  })

  it('行区间不相交的分支复用同一列', () => {
    const sessions: GraphSession[] = [
      session('R', 'root', chain(4, 'r')),
      session('A', 'subagent', chain(1, 'a'), {
        parentId: 'R',
        attachSessionId: 'R',
        attachTurnId: 'r1',
      }),
      session('B', 'subagent', chain(1, 'b'), {
        parentId: 'R',
        attachSessionId: 'R',
        attachTurnId: 'r4',
      }),
    ]
    const layout = layoutSessionGraph(tree('R', sessions))
    const a = byId(layout, 'a1')!
    const b = byId(layout, 'b1')!
    expect(layout.columnOf[a.lane]).toBe(layout.columnOf[b.lane])
  })

  it('320 轮大会话布局 < 20ms', () => {
    const sessions = [session('R', 'root', chain(320, 'r'))]
    const start = performance.now()
    const layout = layoutSessionGraph(tree('R', sessions))
    const cost = performance.now() - start
    expect(layout.nodes.length).toBe(320)
    expect(cost).toBeLessThan(20)
  })

  it('当前会话没有轮次时退回树根会话的主线', () => {
    const sessions = [
      session('R', 'root', chain(3, 'r')),
      session('F', 'fork', [], { parentId: 'R', attachSessionId: 'R', attachTurnId: 'r3' }),
    ]
    const layout = layoutSessionGraph(tree('F', sessions))
    expect(layout.nodes.filter((node) => node.trunk).map((node) => node.id)).toEqual([
      'r3',
      'r2',
      'r1',
    ])
  })

  it('紧凑模式：保留起点/最新轮/分叉点/派出点/汇回点，其余轮次省略', () => {
    const sessions: GraphSession[] = [
      session('R', 'root', chain(8, 'r')),
      session('S', 'subagent', chain(3, 's'), {
        parentId: 'R',
        attachSessionId: 'R',
        attachTurnId: 'r2',
      }),
      session('F', 'fork', chain(3, 'f'), {
        parentId: 'R',
        attachSessionId: 'R',
        attachTurnId: 'r5',
      }),
    ]
    const full = layoutSessionGraph(tree('R', sessions))
    const compact = layoutSessionGraph(tree('R', sessions), { compact: true })
    expect(compact.nodes.length).toBeLessThan(full.nodes.length)
    const ids = compact.nodes.map((node) => node.id)
    // 每个会话的起点与最新轮。
    for (const id of ['r1', 'r8', 's1', 's3', 'f1', 'f3']) expect(ids).toContain(id)
    // 分叉点 / 派出点 / 汇回点。
    for (const id of ['r2', 'r5', 'r3']) expect(ids).toContain(id)
    // 普通轮次省略。
    for (const id of ['r6', 's2', 'f2']) expect(ids).not.toContain(id)
    expect(byId(compact, 'r2')!.attachPoint).toBe(true)
    expect(byId(compact, 'r5')!.attachPoint).toBe(true)
    // 分叉/子代理泳道起点连在派出它的那一轮，不是都连在根节点。
    const subStart = byId(compact, 's1')!
    const subEdge = compact.edges.find(
      (edge) => edge.kind === 'subagent' && !edge.merge && edge.toLane === subStart.lane,
    )
    expect(subEdge!.fromRow).toBe(byId(compact, 'r2')!.row)
    const forkStart = byId(compact, 'f1')!
    const forkEdge = compact.edges.find((edge) => edge.kind === 'fork' && edge.toLane === forkStart.lane)
    expect(forkEdge!.fromRow).toBe(byId(compact, 'r5')!.row)
    expect(
      compact.nodes.filter((node) => node.sessionId === 'R' && node.sessionLabel).map((node) => node.id),
    ).toEqual(['r1'])
  })
})

describe('卡片内会话图高度（反馈16#09）', () => {
  it('少于 3 行按最小高度，超过 12 行按最大高度，中间随行数增长', () => {
    expect(graphCardHeight(1)).toBe(GRAPH_ROW_H * 3)
    expect(graphCardHeight(2)).toBe(GRAPH_ROW_H * 3)
    expect(graphCardHeight(4)).toBe(GRAPH_ROW_H * 4)
    expect(graphCardHeight(20)).toBe(Math.min(GRAPH_ROW_H * 12, 360))
  })
})
