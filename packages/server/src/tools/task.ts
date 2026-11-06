// Task：把独立子任务派发给子代理（创建子会话，跑完整 agent 循环）。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

export const definition: ToolDefinition = {
  name: 'Task',
  readOnly: false,
  requiresApproval: false,
  description:
    'Launch a new agent to handle a complex, multi-step task autonomously. ' +
    'The subagent has access to the same tools (except Task) and working directory, and runs its own full loop. ' +
    'Use it for independent research or parallelizable work. ' +
    'subagent_type: "Explore" or "Plan" for read-only work (these can run in parallel), "general-purpose" for tasks that may modify files.',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'A short (3-5 words) description of the task, used as the subagent session title.',
      },
      prompt: {
        type: 'string',
        description: 'The task for the subagent to perform. Be specific and self-contained.',
      },
      subagent_type: {
        type: 'string',
        description: 'Optional agent type: Explore, Plan, or general-purpose (default).',
      },
    },
    required: ['description', 'prompt'],
  },
};

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!description) return { content: '缺少 description 参数', isError: true };
  if (!prompt) return { content: '缺少 prompt 参数', isError: true };
  if (!ctx.runSubagent) return { content: '当前环境不支持子代理', isError: true };
  const subagentType =
    typeof input.subagent_type === 'string' ? input.subagent_type.trim() || undefined : undefined;
  return ctx.runSubagent({ description, prompt, subagentType });
}

/** 只读子代理类型：允许同一批 Task 并行执行。 */
export function isReadOnlySubagentInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const type = String((input as Record<string, unknown>).subagent_type ?? 'general-purpose').toLowerCase();
  return type === 'explore' || type === 'plan';
}
