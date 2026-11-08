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
    'subagent_type: "Explore" or "Plan" for read-only work (these can run in parallel), "general-purpose" for tasks that may modify files, ' +
    'or the name of a configured subagent preset (different account/group/model/effort/tools).',
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
        description:
          'Optional agent type: Explore, Plan, general-purpose (default), or a subagent preset name.',
      },
      model: {
        type: 'string',
        description:
          'Optional model override for this subagent, e.g. a cheaper model. The preset model is used when omitted.',
      },
      role: {
        type: 'string',
        enum: ['executor', 'specialist'],
        description:
          '分工路由角色：executor = 设置里的便宜执行模型；specialist = 领域专长模型（配合 domain）。',
      },
      domain: {
        type: 'string',
        enum: ['ui', 'backend', 'test', 'docs', 'data', 'ops', 'general'],
        description: 'role=specialist 时的任务领域。',
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
  const model = typeof input.model === 'string' ? input.model.trim() || undefined : undefined;
  const role =
    input.role === 'executor' || input.role === 'specialist' ? input.role : undefined;
  const domain =
    typeof input.domain === 'string' &&
    ['ui', 'backend', 'test', 'docs', 'data', 'ops', 'general'].includes(input.domain)
      ? (input.domain as import('@tandem/protocol').RouteDomain)
      : undefined;
  return ctx.runSubagent({ description, prompt, subagentType, model, ...(role ? { role } : {}), ...(domain ? { domain } : {}) });
}

/** 只读子代理类型：允许同一批 Task 并行执行。 */
export function isReadOnlySubagentInput(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const type = String((input as Record<string, unknown>).subagent_type ?? 'general-purpose').toLowerCase();
  return type === 'explore' || type === 'plan';
}
