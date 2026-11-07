import { describe, expect, it } from 'vitest'
import type { BoardCard } from '@tandem/protocol'
import { dependencyCandidates, formatDuration, formatUsd, planDrop, queuedText } from './board'

const card = (id: string, deps: string[] = [], extra: Partial<BoardCard> = {}): BoardCard => ({
  id,
  title: id.toUpperCase(),
  prompt: 'p',
  deps,
  status: 'queued',
  order: 0,
  exec: {},
  attempts: 0,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
})

describe('看板拖动规则', () => {
  it('只允许表达人的意图', () => {
    expect(planDrop('todo', 'queued')).toEqual({ kind: 'action', action: 'start' })
    expect(planDrop('queued', 'todo')).toEqual({ kind: 'action', action: 'unqueue' })
    expect(planDrop('failed', 'queued')).toEqual({ kind: 'action', action: 'retry' })
    expect(planDrop('review', 'done')).toEqual({ kind: 'action', action: 'approve' })
    expect(planDrop('review', 'queued')).toEqual({ kind: 'action', action: 'reject', needsNote: true })
    expect(planDrop('running', 'todo')).toEqual({ kind: 'action', action: 'stop' })
  })

  it('运行中/待审批列由系统驱动：不能投放，也不能列内排序', () => {
    expect(planDrop('todo', 'running')).toBeNull()
    expect(planDrop('queued', 'approval')).toBeNull()
    expect(planDrop('running', 'running')).toBeNull()
    expect(planDrop('done', 'todo')).toBeNull()
    expect(planDrop('todo', 'todo')).toEqual({ kind: 'reorder' })
  })
})

describe('看板文案', () => {
  it('排队卡显示具体在等谁 / 上游失败 / 重试倒计时', () => {
    const a = card('a', [], { status: 'running' })
    const b = card('b', ['a'], { blocked: 'waiting' })
    expect(queuedText(b, [a, b])).toBe('等待 A')
    expect(queuedText(card('c', ['a'], { blocked: 'upstream_failed' }), [a])).toBe('上游失败')
    expect(queuedText(card('d', [], { retryAt: 10_000 }), [], 7_500)).toBe('3 秒后重试')
    expect(queuedText(card('e', [], { status: 'todo' }), [])).toBeUndefined()
  })

  it('花费与时长', () => {
    expect(formatUsd(0)).toBe('$0')
    expect(formatUsd(0.0042)).toBe('$0.0042')
    expect(formatUsd(1.236)).toBe('$1.24')
    expect(formatDuration(500)).toBe('<1 秒')
    expect(formatDuration(65_000)).toBe('1 分 5 秒')
  })
})

describe('依赖候选', () => {
  it('排除自己和所有会成环的下游卡', () => {
    const a = card('a')
    const b = card('b', ['a'])
    const c = card('c', ['b'])
    const d = card('d')
    expect(dependencyCandidates(a, [a, b, c, d]).map((x) => x.id)).toEqual(['d'])
    expect(dependencyCandidates(c, [a, b, c, d]).map((x) => x.id)).toEqual(['a', 'b', 'd'])
  })
})
