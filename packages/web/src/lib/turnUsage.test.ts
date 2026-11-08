import { describe, expect, test } from 'vitest'
import type { SubagentSession, UiMessage } from './types'
import { heatLabel, heatLevels, turnUsageLabel, turnWeight, usageByTurn } from './turnUsage'

let seq = 0
function user(text: string, createdAt: number): UiMessage {
  return { id: `u${++seq}`, role: 'user', content: [{ type: 'text', text }], createdAt }
}
function assistant(createdAt: number, usage?: UiMessage['usage'], content: UiMessage['content'] = [{ type: 'text', text: 'ok' }]): UiMessage {
  return { id: `a${++seq}`, role: 'assistant', content, createdAt, ...(usage ? { usage } : {}) }
}
function sub(id: string, parentId: string, title: string, createdAt: number, messages: UiMessage[], parent?: string): [string, SubagentSession] {
  return [
    id,
    {
      summary: { id, parentId: parent ?? parentId, title, createdAt } as SubagentSession['summary'],
      messages,
      pending: [],
      loading: false,
      running: false,
      liveToolInputs: {},
      toolResults: {},
    },
  ]
}

describe('turn usage', () => {
  test('按用户轮次汇总 assistant 用量与缓存命中率', () => {
    const t = 1_000
    const messages = [
      user('第一轮', t),
      assistant(t + 10, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0, costUsd: 0.002 }),
      assistant(t + 20, { inputTokens: 0, outputTokens: 100, cacheReadTokens: 1000, costUsd: 0.001 }),
      user('第二轮', t + 100),
      assistant(t + 110, { inputTokens: 500, outputTokens: 50, costUsd: 0.0004 }),
    ]
    const map = usageByTurn(messages, undefined, 's1')
    const first = map.get(messages[0]!.id)!
    expect(first.inputTokens).toBe(1000)
    expect(first.outputTokens).toBe(300)
    expect(first.cacheReadTokens).toBe(4000)
    expect(first.costUsd).toBeCloseTo(0.003)
    expect(turnUsageLabel(first)).toBe('输入 1.0k · 输出 300 · 缓存命中 80% · $0.003')
    expect(map.get(messages[3]!.id)!.costUsd).toBeCloseTo(0.0004)
  })

  test('计入该轮 Task 子代理与孙代理，并标注含子代理', () => {
    const t = 10_000
    const task = {
      type: 'tool_use' as const,
      id: 'tool-task',
      name: 'Task',
      input: { description: '跑测试', prompt: 'npm test' },
    }
    const messages = [
      user('派个子代理', t),
      assistant(t + 10, { inputTokens: 100, outputTokens: 20, costUsd: 0.01 }, [
        { type: 'text', text: '交给执行者' },
        task,
      ]),
      user('下一轮', t + 8_000),
      assistant(t + 8_010, { inputTokens: 1, outputTokens: 1, costUsd: 0 }),
    ]
    const subs = Object.fromEntries([
      sub('sub1', 's1', '跑测试', t + 20, [
        user('任务', t + 21),
        assistant(t + 30, { inputTokens: 50, outputTokens: 10, costUsd: 0.001 }),
      ]),
      sub('sub2', 'sub1', '再查一下', t + 40, [
        assistant(t + 50, { inputTokens: 5, outputTokens: 5, costUsd: 0.0001 }),
      ]),
      // 其他轮的同类任务不应混入
      sub('sub3', 's1', '跑测试', t + 9_000, [
        assistant(t + 9_010, { inputTokens: 999, outputTokens: 999, costUsd: 9 }),
      ]),
    ])
    const usage = usageByTurn(messages, subs, 's1').get(messages[0]!.id)!
    expect(usage.inputTokens).toBe(155)
    expect(usage.outputTokens).toBe(35)
    expect(usage.costUsd).toBeCloseTo(0.0111)
    expect(usage.subagents).toBe(true)
    expect(turnUsageLabel(usage)).toContain('含子代理')
  })

  test('未知单价显示花费未知；无 usage 的轮次没有提示文本', () => {
    const t = 20_000
    const messages = [user('没有回复', t), assistant(t + 10), user('有回复', t + 20), assistant(t + 30, { inputTokens: 1, outputTokens: 1 })]
    const map = usageByTurn(messages, undefined, 's1')
    expect(turnUsageLabel(map.get(messages[0]!.id))).toBe('')
    expect(turnUsageLabel(map.get(messages[2]!.id))).toBe('输入 1 · 输出 1 · 缓存命中 0% · 花费未知')
  })
})

describe('turn heat', () => {
  test('按分位排名分 5 档，零占用为最浅档', () => {
    const levels = heatLevels([0, 10, 20, 30, 40, 50, 60])
    expect(levels[0]).toBe(1)
    expect(new Set(levels.slice(1)).size).toBeGreaterThanOrEqual(4)
    expect(levels[6]).toBe(5)
    expect(heatLabel(5)).toBe('用量高')
    expect(heatLabel(1)).toBe('用量低')
  })

  test('花费看输入+输出，上下文看当前占用', () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      costUsd: 0.01,
      hasCost: true,
      subagents: false,
      contextTokens: 700,
      hasUsage: true,
    }
    expect(turnWeight(usage, 'cost')).toBe(150)
    expect(turnWeight(usage, 'context')).toBe(700)
  })
})
