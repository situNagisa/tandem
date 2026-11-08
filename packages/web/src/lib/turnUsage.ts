import type { Usage } from '@tandem/protocol'
import type { SubagentSession, UiMessage } from './types'
import { formatTokens } from './format'

/** 一轮（用户消息 → 下一条用户消息）内所有模型调用的用量汇总。 */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  /** 是否至少有一条消息带 costUsd（未知单价时为 false）。 */
  hasCost: boolean
  /** 是否包含 Task 子代理（含孙代理）的用量。 */
  subagents: boolean
  /** 这一轮目前还占用的上下文估算（压缩掉的轮次为 0）。 */
  contextTokens: number
  /** 是否至少有一条 assistant 消息带 usage（没有回复的轮次不显示 tooltip）。 */
  hasUsage: boolean
}

function emptyUsage(): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    hasCost: false,
    subagents: false,
    contextTokens: 0,
    hasUsage: false,
  }
}

function addUsage(target: TurnUsage, usage: Usage | undefined): void {
  if (!usage) return
  target.hasUsage = true
  target.inputTokens += usage.inputTokens || 0
  target.outputTokens += usage.outputTokens || 0
  target.cacheReadTokens += usage.cacheReadTokens || 0
  target.cacheWriteTokens += usage.cacheWriteTokens || 0
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
    target.costUsd += usage.costUsd
    target.hasCost = true
  }
}

/** 粗略估算一条消息当前占用的 token（与 Host 侧 estimateMessagesTokens 同量级）。 */
export function estimateMessageTokens(message: UiMessage): number {
  let chars = 0
  for (const block of message.content) {
    if (block.type === 'text' || block.type === 'thinking') chars += block.text.length
    else if (block.type === 'tool_result') chars += block.content.length
    else if (block.type === 'tool_use') chars += JSON.stringify(block.input ?? {}).length + 24
    else if (block.type === 'image') chars += 4_000
  }
  return Math.ceil(chars / 4) + 8
}

/** 压缩摘要行：按摘要自身的 token 数着色，不参与花费金额。 */
export function summaryUsage(message: UiMessage): TurnUsage {
  const tokens = estimateMessageTokens(message)
  return {
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    hasCost: false,
    subagents: false,
    contextTokens: tokens,
    hasUsage: true,
  }
}

const isUserTurn = (message: UiMessage): boolean =>
  message.role === 'user' &&
  !message.summary &&
  !message.gap &&
  message.content.some(
    (block) => block.type === 'image' || (block.type === 'text' && !!block.text?.trim()),
  )

/** 递归累加一个子代理会话及其所有后代（孙代理）的用量。 */
function addSubagentUsage(
  sessionId: string,
  subagents: Record<string, SubagentSession>,
  target: TurnUsage,
  seen: Set<string>,
): void {
  if (seen.has(sessionId)) return
  seen.add(sessionId)
  const sub = subagents[sessionId]
  if (!sub) return
  for (const message of sub.messages) {
    if (message.role === 'assistant') addUsage(target, message.usage)
  }
  for (const [childId, child] of Object.entries(subagents)) {
    if (child.summary?.parentId === sessionId) {
      target.subagents = true
      addSubagentUsage(childId, subagents, target, seen)
    }
  }
}

/** Task 工具调用的描述：用于把子代理会话归到产生它的那一轮。 */
function taskDescriptions(messages: UiMessage[]): string[] {
  const out: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== 'Task') continue
      const input = block.input as Record<string, unknown> | undefined
      const description = typeof input?.description === 'string' ? input.description : ''
      if (description) out.push(description)
    }
  }
  return out
}

/**
 * 按用户轮次汇总 usage：该轮用户消息到下一条用户消息之间所有 assistant 消息，
 * 并计入该轮派出的 Task 子代理（含孙代理）。滚动分页只算已加载的消息。
 */
export function usageByTurn(
  messages: UiMessage[],
  subagents: Record<string, SubagentSession> | undefined,
  sessionId: string | undefined,
): Map<string, TurnUsage> {
  const result = new Map<string, TurnUsage>()
  if (!sessionId) return result
  const starts: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (isUserTurn(messages[i]!)) starts.push(i)
  }
  const subList = subagents ? Object.values(subagents) : []
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s]!
    const end = starts[s + 1] ?? messages.length
    const turnMessages = messages.slice(start, end)
    const usage = emptyUsage()
    for (const message of turnMessages) {
      if (message.role === 'assistant') addUsage(usage, message.usage)
    }
    // 子代理按「父会话 + Task 描述 + 创建时间落在这轮内」匹配。
    for (const message of turnMessages) usage.contextTokens += estimateMessageTokens(message)
    const firstAt = messages[start]?.createdAt ?? 0
    const lastAt = end < messages.length ? (messages[end]?.createdAt ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
    const used = new Set<string>()
    for (const description of taskDescriptions(turnMessages)) {
      const candidates = subList
        .filter((sub) => {
          const summary = sub.summary
          if (!summary || summary.parentId !== sessionId) return false
          const title = description.length > 120 ? description.slice(0, 120) : description
          if (summary.title !== title) return false
          if (summary.createdAt < firstAt - 2_000) return false
          if (summary.createdAt > lastAt) return false
          return !used.has(summary.id)
        })
        .sort((a, b) => (b.summary?.createdAt ?? 0) - (a.summary?.createdAt ?? 0))
      const match = candidates[0]
      if (!match?.summary) continue
      used.add(match.summary.id)
      usage.subagents = true
      addSubagentUsage(match.summary.id, subagents!, usage, new Set())
    }
    result.set(messages[start]!.id, usage)
  }
  return result
}

/** 缓存命中率：缓存读 /（未命中输入 + 缓存读 + 缓存写）。 */
export function cacheHitRate(usage: TurnUsage): number {
  const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  return total > 0 ? Math.round((usage.cacheReadTokens / total) * 100) : 0
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  const digits = usd >= 1 ? 2 : usd >= 0.01 ? 3 : 4
  return `$${usd.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}`
}

export type TurnHeatMetric = 'cost' | 'context'

/** 着色权重：花费=本轮实际消耗的输入+输出 token；上下文=本轮当前占用。 */
export function turnWeight(usage: TurnUsage | undefined, metric: TurnHeatMetric): number {
  if (!usage) return 0
  return metric === 'cost' ? usage.inputTokens + usage.outputTokens : usage.contextTokens
}

const HEAT_LABELS = ['用量低', '用量较低', '用量中', '用量较高', '用量高']

/** 用量档位 1–5：按本会话内的分位排名，避免一个超大轮把其他轮压成最浅。 */
export function heatLevels(weights: number[]): number[] {
  const positive = weights.filter((w) => w > 0).sort((a, b) => a - b)
  if (positive.length === 0) return weights.map(() => 1)
  return weights.map((weight) => {
    if (weight <= 0) return 1
    const below = positive.filter((w) => w < weight).length
    const rank = positive.length > 1 ? below / (positive.length - 1) : 0
    return 1 + Math.min(4, Math.floor(rank * 5))
  })
}

export function heatLabel(level: number): string {
  return HEAT_LABELS[Math.min(4, Math.max(0, level - 1))] ?? HEAT_LABELS[0]!
}

/** 轮次大纲 tooltip：只显示用量，不重复大纲文字；可附占本会话比例与压缩标记。 */
export function turnUsageLabel(
  usage: TurnUsage | undefined,
  extra?: { share?: number; compressed?: boolean; summary?: boolean },
): string {
  if (!usage) return ''
  if (!usage.hasUsage && !usage.hasCost && !extra?.summary) return ''
  const parts: string[] = []
  if (extra?.summary) {
    parts.push('摘要', `占用 ${formatTokens(usage.contextTokens)}`)
  } else {
    parts.push(
      `输入 ${formatTokens(usage.inputTokens)}`,
      `输出 ${formatTokens(usage.outputTokens)}`,
      `缓存命中 ${cacheHitRate(usage)}%`,
      usage.hasCost ? formatCost(usage.costUsd) : '花费未知',
    )
    if (usage.subagents) parts.push('含子代理')
  }
  if (extra?.share !== undefined) parts.push(`占本会话 ${extra.share}%`)
  if (extra?.compressed) parts.push('已压缩到摘要')
  return parts.join(' · ')
}
