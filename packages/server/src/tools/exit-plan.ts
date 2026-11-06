// ExitPlanMode：计划模式下由模型提交计划，服务端转为一次特殊审批（不是普通工具执行）。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

export const definition: ToolDefinition = {
  name: 'ExitPlanMode',
  readOnly: true,
  requiresApproval: false,
  description:
    'Submit the implementation plan for user approval when in plan mode. ' +
    'The plan is markdown shown to the user, who can approve it (leaving plan mode) or ask for revisions. ' +
    'Only call this when you have finished researching and have a concrete plan.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The implementation plan in markdown. Keep it concise and concrete.',
      },
    },
    required: ['plan'],
    additionalProperties: false,
  },
};

export async function run(_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
  return { content: '计划已提交，等待用户批准。', isError: true };
}
