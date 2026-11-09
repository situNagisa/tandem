import { describe, expect, it } from 'vitest'
import {
  GRAPH_ROW_H,
  laneX,
  layoutSessionGraph,
  type GraphInput,
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
  })

  it('单个子代理：分出虚线泳道并合并回主线下一行', () => {
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
    expect(layout.nodes.some((n) => n.kind === 'subagent-result' && n.subagentId === 'a')).toBe(true)
    expect(layout.lanes).toBe(3)
    expect(layout.counts.subagents).toBe(2)
  })

  it('分叉是实线菱形节点，不合并回主线', () => {
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
    expect(forkEdges[0]).toMatchObject({ fromLane: 0, fromRow: 0, toLane: 1, toRow: 1 })
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
    expect(laneX(1)).toBeGreaterThan(laneX(0))
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
})
