// ProposeCards：看板卡片会话在回合中提议后续工作；产物是待办里的草稿，需用户确认（或看板设置自动接受）。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

export const definition: ToolDefinition = {
  name: 'ProposeCards',
  readOnly: true,
  requiresApproval: false,
  description:
    '仅在任务看板的卡片会话里可用：把你在本次任务中发现的后续工作提议成新卡片。' +
    '提议会以草稿出现在看板待办列顶部并标注「由本卡提议」，默认要用户确认后才排队；' +
    '看板开启「自动接受提议」时，少量提议会直接排队。' +
    '每张卡写清可独立执行的范围与验收标准；dependsOn 可以填同一批提议的标题或 1-based 序号，' +
    '也可以填看板已有卡的标题或 id。只提议真正需要另开一轮做的事，不要重复当前任务。',
  inputSchema: {
    type: 'object',
    properties: {
      cards: {
        type: 'array',
        description: '提议的卡片（1–12 张）。',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '简短标题。' },
            prompt: { type: 'string', description: '交给新卡片会话的完整任务说明。' },
            dependsOn: {
              type: 'array',
              description: '依赖：同批提议的标题/序号，或看板已有卡片的标题/id。',
              items: { type: 'string' },
            },
          },
          required: ['title', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['cards'],
    additionalProperties: false,
  },
};

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.proposeCards) return { content: '当前会话不是任务看板卡片，不能提议卡片', isError: true };
  return ctx.proposeCards(input);
}
