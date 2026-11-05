// TodoWrite：维护会话待办并广播给所有客户端。
import type { Todo } from '@tandem/protocol';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';

export const definition: ToolDefinition = {
  name: 'TodoWrite',
  readOnly: true,
  requiresApproval: false,
  description:
    'Updates the task list for the current session. Use it for multi-step work: ' +
    'keep exactly one item in_progress and mark items completed as soon as they are done.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The updated todo list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Task description.' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Task status.',
            },
            activeForm: { type: 'string', description: 'Present continuous form of the task.' },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
};

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!Array.isArray(input.todos)) return { content: 'todos 必须是数组', isError: true };
  const todos: Todo[] = [];
  for (const item of input.todos) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (!content) continue;
    const status = STATUSES.has(String(raw.status))
      ? (String(raw.status) as Todo['status'])
      : 'pending';
    todos.push({ content, status });
  }
  ctx.updateTodos(todos);
  return { content: `待办列表已更新（共 ${todos.length} 项）` };
}
