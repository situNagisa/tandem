import type { SessionSummary } from '@tandem/protocol'
import { isUserTurnMessage } from '@tandem/protocol'
import type { SubagentSession, UiMessage } from '../../lib/types'
import type { GraphFork, GraphInput, GraphSubagent, GraphTurn } from './layout'

function firstLine(message: UiMessage): string {
  const texts: string[] = []
  let image = false
  for (const block of message.content) {
    if (block.type === 'text') texts.push(block.text)
    else if (block.type === 'image') image = true
  }
  const line =
    texts
      .join('\n')
      .split('\n')
      .map((item) => item.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? ''
  return line || (image ? '图片' : '')
}

interface TurnParts {
  turns: GraphTurn[]
  /** 消息 id → 所属用户轮 id（分叉点可能落在助手消息上）。 */
  turnOfMessage: Map<string, string>
}

/** 从消息流里取用户轮：预览与 Task 工具 id/标题。 */
export function turnsFromMessages(messages: UiMessage[]): TurnParts {
  const starts: number[] = []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!
    if (message.role === 'user' && !message.gap && isUserTurnMessage(message)) starts.push(i)
  }
  const turns: GraphTurn[] = []
  const turnOfMessage = new Map<string, string>()
  for (let s = 0; s < starts.length; s += 1) {
    const start = starts[s]!
    const end = starts[s + 1] ?? messages.length
    const startMessage = messages[start]!
    const taskToolIds: string[] = []
    const taskTitles: string[] = []
    for (let i = start; i < end; i += 1) {
      const message = messages[i]!
      turnOfMessage.set(message.id, startMessage.id)
      if (message.role !== 'assistant') continue
      for (const block of message.content) {
        if (block.type !== 'tool_use' || block.name !== 'Task') continue
        taskToolIds.push(block.id)
        const input = block.input as Record<string, unknown> | undefined
        if (typeof input?.description === 'string' && input.description.trim()) {
          taskTitles.push(input.description.trim())
        }
      }
    }
    turns.push({
      id: startMessage.id,
      no: s + 1,
      preview: firstLine(startMessage).slice(0, 160),
      ...(taskToolIds.length ? { taskToolIds } : {}),
      ...(taskTitles.length ? { taskTitles } : {}),
    })
  }
  return { turns, turnOfMessage }
}

function findTurnForTool(
  turns: GraphTurn[],
  toolUseId?: string,
  title?: string,
): string | undefined {
  if (toolUseId) {
    const hit = turns.find((turn) => turn.taskToolIds?.includes(toolUseId))
    if (hit) return hit.id
  }
  if (title) {
    const normalized = title.length > 120 ? title.slice(0, 120) : title
    const hit = turns.find((turn) =>
      turn.taskTitles?.some(
        (item) => (item.length > 120 ? item.slice(0, 120) : item) === normalized,
      ),
    )
    if (hit) return hit.id
  }
  return undefined
}

function buildSubagentTree(
  all: SubagentSession[],
  parentId: string,
  parentTurns: GraphTurn[],
): GraphSubagent[] {
  return all
      .filter((item) => item.summary?.parentId === parentId)
      .sort((a, b) => (a.summary?.createdAt ?? 0) - (b.summary?.createdAt ?? 0))
      .map((item) => {
        const summary = item.summary!
        const parts = turnsFromMessages(item.messages)
        const turnId =
          findTurnForTool(parentTurns, summary.parentToolUseId, summary.title) ??
          parentTurns[parentTurns.length - 1]?.id
        const children = buildSubagentTree(all, summary.id, parts.turns)
        return {
          id: summary.id,
          title: summary.title,
          ...(turnId ? { turnId } : {}),
          createdAt: summary.createdAt,
          ...(summary.status ? { status: summary.status } : {}),
          turns: parts.turns,
          children,
        }
      })
}

function resolveForkTurn(
  fork: SessionSummary,
  turns: GraphTurn[],
  turnOfMessage: Map<string, string>,
): string | undefined {
  const from = fork.forkedFrom
  if (!from?.messageId) return turns[turns.length - 1]?.id
  if (turns.some((turn) => turn.id === from.messageId)) return from.messageId
  return turnOfMessage.get(from.messageId) ?? turns[turns.length - 1]?.id
}

/**
 * 组装会话图输入：主线轮次 + 本会话派生的子代理树 + 以本会话为父的分叉会话。
 * 子代理优先用 summary.parentToolUseId 定位到轮；旧数据按 Task 标题兜底。
 */
export function buildSessionGraph(input: {
  sessionId: string
  title?: string
  messages: UiMessage[]
  subagents?: Record<string, SubagentSession>
  hostSessions?: SessionSummary[]
}): GraphInput {
  const parts = turnsFromMessages(input.messages)
  const all = Object.values(input.subagents ?? {})
  const subagents = buildSubagentTree(all, input.sessionId, parts.turns)
  const forks: GraphFork[] = (input.hostSessions ?? [])
    .filter((session) => session.forkedFrom?.sessionId === input.sessionId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((session) => {
      const turnId = resolveForkTurn(session, parts.turns, parts.turnOfMessage)
      return {
        id: session.id,
        title: session.title || '分叉',
        ...(turnId ? { turnId } : {}),
        createdAt: session.createdAt,
      }
    })
  return {
    sessionId: input.sessionId,
    ...(input.title ? { title: input.title } : {}),
    turns: parts.turns,
    subagents,
    forks,
  }
}
