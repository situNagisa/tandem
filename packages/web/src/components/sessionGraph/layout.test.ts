import { describe, expect, it } from 'vitest'
import {
  GRAPH_ROW_H,
  graphCardHeight,
  columnX,
  layoutSessionGraph,
  type GraphInput,
  type GraphLayout,
  type GraphSubagent,
  type GraphTurn,
} from './layout'

function turns(n: number, prefix = 't'): GraphTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    no: i + 1,
    preview: `用户第 ${i + 1} 轮`,
  }))
}

function sub(
  id: string,
  turnId: string,
  extra: Partial<GraphSubagent> = {},
): GraphSubagent {
  return {
    id,
    title: `子代理 ${id}`,
    turnId,
    createdAt: 0,
    steps: 3,
    turns: [{ id: `${id}-u1`, no: 1, preview: `${id} 的任务` }],
    children: [],
    ...extra,
  }
}

describe('layoutSessionGraph', () => {
  it('主线每轮一行，泳道数只有一条', () => {
    const layout = layoutSessionGraph({
      sessionId: 's',
      turns: turns(3),
      subagents: [],
      forks: [],
    })
    expect(layout.nodes.map((n) => [n.kind, n.lane, n.row])).toEqual([
      ['turn', 0, 0],
      ['turn', 0, 1],
      ['turn', 0, 2],
    ])
    expect(layout.lanes).toBe(1)
    expect(layout.rows).toBe(3)
    expect(layout.edges.filter((e) => e.kind === 'subagent')).toHaveLength(0)
    // 主线是一整条竖线：x 固定、贯穿首尾轮，每个主线节点圆心都在线上。
    const main = layout.edges.find((e) => e.kind === 'main')!
    expect(main).toMatchObject({ fromLane: 0, toLane: 0, fromRow: 0, toRow: 2 })
    const turnRows = layout.nodes.filter((n) => n.kind === 'turn').map((n) => n.row)
    for (const row of turnRows) {
      expect(row).toBeGreaterThanOrEqual(main.fromRow)
      expect(row).toBeLessThanOrEqual(main.toRow)
    }
    expect(columnX(0)).toBe(8)
    expect(columnX(2) - columnX(1)).toBe(12)
  })

  it('单个子代理：分出新泳道并合并回主线下一行', () => {
    const layout = layoutSessionGraph({
      sessionId: 's',
      turns: turns(2),
      subagents: [sub('a', 't1')],
      forks: [],
    })
    const branch = layout.nodes.find((n) => n.kind === 'subagent')!
    expect(branch.lane).toBe(1)
    expect(branch.row).toBe(1)
    expect(branch.collapsed).toBe(true)
    const nextTurn = layout.nodes.find((n) => n.kind === 'turn' && n.row > 0)!
    expect(nextTurn.row).toBe(2) // 子代理完成后主线才继续
    const split = layout.edges.find(
      (e) => e.kind === 'subagent' && e.fromLane === 0 && e.toLane === 1,
    )!
    expect(split).toMatchObject({ fromRow: 0, toRow: 1 })
    const out = layout.edges.find((e) => e.kind === 'subagent' && e.fromLane === 1)!
    expect(out.toLane).toBe(0)
    expect(out.toRow).toBe(2)
    expect(layout.counts).toEqual({ turns: 2, subagents: 1, forks: 0 })
  })

  it('嵌套子代理继续向右分泳道，展开后出现步与结果节点', () => {
    const parent = sub('a', 't1', {
      turns: [
        { id: 'a-u1', no: 1, preview: '先读文件' },
        { id: 'a-u2', no: 2, preview: '再派孙代理' },
      ],
      children: [sub('b', 'a-u2')],
    })
    const layout = layoutSessionGraph({
      sessionId: 's',
      turns: turns(2),
      subagents: [parent],
      forks: [],
      expanded: { a: true },
    })
    const parentTurns = layout.nodes.filter((n) => n.kind === 'subagent-turn' && n.subagentId === 'a')
    expect(parentTurns.map((n) => n.lane)).toEqual([1, 1])
    const grandchild = layout.nodes.find((n) => n.kind === 'subagent' && n.subagentId === 'b')!
    expect(grandchild.lane).toBe(2)
    expect(grandchild.row).toBeGreaterThan(parentTurns[1]!.row)
    const result = layout.nodes.find((n) => n.kind === 'subagent-result' && n.subagentId === 'a')!
    expect(result).toBeTruthy()
    // 分支竖线从父节点一直贯穿到最后一个节点（结果行），再合并回主线。
    const split = layout.edges.find(
      (e) => e.kind === 'subagent' && e.fromLane === 0 && e.toLane === 1,
    )!
    expect(split.toRow).toBe(result.row)
    expect(layout.lanes).toBe(3)
    expect(layout.counts.subagents).toBe(2)
  })

  it('分叉是独立泳道节点，不合并回主线', () => {
    const layout = layoutSessionGraph({
      sessionId: 's',
      turns: turns(2),
      subagents: [],
      forks: [{ id: 'fork-1', title: '分叉 · 方案 B', turnId: 't1', createdAt: 0 }],
    })
    const fork = layout.nodes.find((n) => n.kind === 'fork')!
    expect(fork.lane).toBe(1)
    expect(fork.row).toBe(1)
    expect(fork.forkSessionId).toBe('fork-1')
    const forkEdges = layout.edges.filter((e) => e.kind === 'fork')
    expect(forkEdges).toHaveLength(1)
    expect(forkEdges[0]).toMatchObject({ fromLane: 0, fromRow: 0, toLane: 1, toRow: fork.row })
    expect(layout.edges.some((e) => e.kind === 'fork' && e.toLane === 0)).toBe(false)
  })

  it('子代理与分叉混合：泳道类型与颜色分档可区分', () => {
    const layout = layoutSessionGraph({
      sessionId: 's',
      turns: turns(3),
      subagents: [sub('a', 't1'), sub('b', 't2')],
      forks: [{ id: 'fork-1', title: '分叉 · 某个会话', turnId: 't1', createdAt: 0 }],
    })
    expect(layout.laneKinds[0]).toBe('main')
    expect(layout.laneKinds).toContain('subagent')
    expect(layout.laneKinds).toContain('fork')
    expect(layout.counts).toEqual({ turns: 3, subagents: 2, forks: 1 })
    // 泳道互不重叠，行的顺序严格自上而下。
    expect(columnX(layout.columnOf[1]!)).toBeGreaterThan(columnX(0))
    const turnRows = layout.nodes.filter((n) => n.kind === 'turn').map((n) => n.row)
    expect(turnRows).toEqual([...turnRows].sort((a, b) => a - b))
  })

  it('320 轮大会话布局 < 20ms', () => {
    const many = turns(320)
    const input: GraphInput = {
      sessionId: 's',
      turns: many,
      subagents: Array.from({ length: 20 }, (_, i) =>
        sub(`a${i}`, many[i * 12]!.id, {
          turns: [
            { id: `a${i}-u1`, no: 1, preview: '子任务' },
            { id: `a${i}-u2`, no: 2, preview: '继续' },
          ],
          children: [sub(`b${i}`, `a${i}-u1`)],
        }),
      ),
      forks: Array.from({ length: 10 }, (_, i) => ({
        id: `fork-${i}`,
        title: `分叉 ${i}`,
        turnId: many[i * 20]!.id,
        createdAt: 0,
      })),
    }
    const started = performance.now()
    const layout = layoutSessionGraph(input)
    const elapsed = performance.now() - started
    expect(layout.counts.turns).toBe(320)
    expect(layout.nodes.length).toBeGreaterThan(320)
    expect(layout.rows * GRAPH_ROW_H).toBeGreaterThan(320 * GRAPH_ROW_H)
    expect(elapsed).toBeLessThan(20)
  })

  it('行区间不相交的分支复用同一列', () => {
    const layout = layoutSessionGraph({
      sessionId: 's',
      turns: turns(4),
      subagents: [sub('a', 't1'), sub('b', 't3')],
      forks: [],
    })
    expect(layout.columns).toBe(2)
    expect(layout.columnOf[1]).toBe(layout.columnOf[2])
  })

  it('同一轮并行派出的分支各占一列，互不共用', () => {
    const layout = layoutSessionGraph({
      sessionId: 's',
      turns: turns(2),
      subagents: [sub('a', 't1'), sub('b', 't1')],
      forks: [{ id: 'fork-1', title: '分叉', turnId: 't1', createdAt: 0 }],
    })
    const columns = [1, 2, 3].map((lane) => layout.columnOf[lane])
    expect(new Set(columns).size).toBe(3)
    expect(layout.columns).toBe(4)
  })

  it('同轮并行分支（含嵌套与分叉）的水平线不穿过别的竖线', () => {
    const layout = layoutSessionGraph({
      sessionId: 's',
      turns: turns(4),
      subagents: [
        sub('a', 't1', {
          turns: [
            { id: 'a-u1', no: 1, preview: 'a1' },
            { id: 'a-u2', no: 2, preview: 'a2' },
          ],
          children: [sub('c', 'a-u1'), sub('d', 'a-u2')],
        }),
        sub('b', 't1', {
          turns: [
            { id: 'b-u1', no: 1, preview: 'b1' },
            { id: 'b-u2', no: 2, preview: 'b2' },
            { id: 'b-u3', no: 3, preview: 'b3' },
          ],
          children: [sub('e', 'b-u3')],
        }),
      ],
      forks: [{ id: 'fork-1', title: '分叉', turnId: 't1', createdAt: 0 }],
      expanded: { a: true, b: true, c: true, e: true },
    })
    expect(crossings(layout)).toBe(0)
  })
})

/** 水平段穿过另一条竖线内部的次数（端点处的转折不算）。 */
function crossings(layout: GraphLayout): number {
  const column = (lane: number) => layout.columnOf[lane]!
  const horizontal: Array<{ edge: number; row: number; from: number; to: number }> = []
  const vertical: Array<{ edge: number; column: number; from: number; to: number }> = []
  layout.edges.forEach((e, edge) => {
    const x1 = column(e.fromLane)
    const x2 = column(e.toLane)
    if (x2 > x1) horizontal.push({ edge, row: e.fromRow, from: x1, to: x2 })
    if (x2 < x1) horizontal.push({ edge, row: e.toRow, from: x2, to: x1 })
    vertical.push({ edge, column: Math.max(x1, x2), from: e.fromRow, to: e.toRow })
  })
  let n = 0
  for (const h of horizontal) {
    for (const v of vertical) {
      if (h.edge === v.edge) continue
      if (h.from < v.column && v.column < h.to && v.from < h.row && h.row < v.to) n += 1
    }
  }
  return n
}

describe('卡片内会话图高度（反馈16#09）', () => {
  it('少于 3 行按最小高度，超过 12 行按最大高度，中间随行数增长', () => {
    expect(graphCardHeight(0)).toBe(GRAPH_ROW_H * 3)
    expect(graphCardHeight(2)).toBe(GRAPH_ROW_H * 3)
    expect(graphCardHeight(3)).toBe(GRAPH_ROW_H * 3)
    expect(graphCardHeight(8)).toBe(GRAPH_ROW_H * 8)
    expect(graphCardHeight(12)).toBe(GRAPH_ROW_H * 12)
    expect(graphCardHeight(30)).toBe(GRAPH_ROW_H * 12)
  })
})
