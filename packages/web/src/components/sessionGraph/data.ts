import type { SessionGraphTree } from '@tandem/protocol'
import { isUserTurnMessage } from '@tandem/protocol'
import type { UiMessage } from '../../lib/types'
import type { GraphTreeInput, GraphTurn } from './layout'

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

/** 从消息流里取用户轮（注入内容、纯 tool_result、压缩摘要都不算一轮）。 */
export function turnsFromMessages(messages: UiMessage[], pinned: string[] = []): GraphTurn[] {
  const pinnedIds = new Set(pinned)
  const turns: GraphTurn[] = []
  for (const message of messages) {
    if (message.role !== 'user' || message.gap || !isUserTurnMessage(message)) continue
    turns.push({
      id: message.id,
      no: turns.length + 1,
      preview: firstLine(message).slice(0, 160),
      ...(pinnedIds.has(message.id) ? { pinned: true } : {}),
    })
  }
  return turns
}

/**
 * 只读会话图（外部会话、子代理内嵌视图）：只有一条链，没有分叉与子代理。
 * 外部会话的日志里没有 Tandem 的树关系，会话图只画主线轮次。
 */
export function graphFromMessages(
  messages: UiMessage[],
  options: { sessionId?: string; title?: string; pinned?: string[] } = {},
): GraphTreeInput {
  return {
    sessionId: options.sessionId ?? 'external',
    sessions: [
      {
        id: options.sessionId ?? 'external',
        title: options.title?.trim() || '当前会话',
        kind: 'root',
        turns: turnsFromMessages(messages, options.pinned ?? []),
      },
    ],
  }
}

/**
 * 服务端下发的会话树作为布局输入。
 * `sessionId` 决定主线：右栏传当前打开的会话；悬停浮层传树内正在查看的会话。
 */
export function graphFromTree(tree: SessionGraphTree, sessionId = tree.sessionId): GraphTreeInput {
  return {
    sessionId,
    sessions: tree.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      kind: session.kind,
      ...(session.parentId ? { parentId: session.parentId } : {}),
      ...(session.attachSessionId ? { attachSessionId: session.attachSessionId } : {}),
      ...(session.attachTurnId ? { attachTurnId: session.attachTurnId } : {}),
      ...(session.running ? { running: true } : {}),
      ...(session.waiting ? { waiting: true } : {}),
      turns: session.turns.map((turn) => ({
        id: turn.id,
        no: turn.no,
        preview: turn.preview,
        ...(turn.pinned ? { pinned: true } : {}),
      })),
    })),
  }
}
