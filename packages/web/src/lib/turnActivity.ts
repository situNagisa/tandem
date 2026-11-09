import type { ToolResultBlock, UiMessage } from './types'

/**
 * 找出「本轮仍在执行」的工具：从最后一条带工具调用的 assistant 消息往回看，
 * 没有对应结果的就是在跑的工具。用户已经发出下一条消息或一轮已结束时返回空。
 * 排队中的本地消息不打断判断（它还没被 agent 读取）。
 */
export function activeToolUses(
  messages: UiMessage[],
  results?: Record<string, ToolResultBlock>,
): { ids: Set<string>; name?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.gap || message.local || message.compaction) continue
    if (message.role === 'user') {
      if (message.content.some((block) => block.type === 'text' || block.type === 'image')) {
        return { ids: new Set() }
      }
      continue
    }
    const tools = message.content.filter(
      (block): block is Extract<(typeof message.content)[number], { type: 'tool_use' }> =>
        block.type === 'tool_use',
    )
    if (tools.length === 0) continue
    const pending = tools.filter((tool) => !results?.[tool.id])
    return { ids: new Set(pending.map((tool) => tool.id)), name: pending[0]?.name }
  }
  return { ids: new Set() }
}
