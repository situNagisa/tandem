// KillBash：终止 run_in_background 启动的后台 Bash 任务。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import type { BackgroundTaskManager } from '../tasks.js';

export const definition: ToolDefinition = {
  name: 'KillBash',
  readOnly: false,
  requiresApproval: false,
  description: 'Kills a background Bash task started with run_in_background.',
  inputSchema: {
    type: 'object',
    properties: {
      shell_id: { type: 'string', description: 'The background task id (bash_id).' },
    },
    required: ['shell_id'],
    additionalProperties: false,
  },
};

type TaskAwareContext = ToolContext & { backgroundTasks?: BackgroundTaskManager };

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const id = typeof input.shell_id === 'string' ? input.shell_id.trim() : '';
  if (!id) return { content: '缺少 shell_id 参数', isError: true };
  const manager = (ctx as TaskAwareContext).backgroundTasks;
  if (!manager) return { content: '后台任务管理器不可用', isError: true };
  const task = manager.get(id);
  if (!task) return { content: `后台任务不存在: ${id}`, isError: true };
  if (task.sessionId !== ctx.session.id) return { content: '不能终止其他会话的后台任务', isError: true };
  const killed = await manager.kill(id);
  if (!killed) return { content: `后台任务不存在: ${id}`, isError: true };
  if (killed.status === 'running') return { content: `未能终止后台任务: ${id}`, isError: true };
  if (killed.status === 'exited' || killed.status === 'lost') {
    return { content: `后台任务 ${id} 已结束，无需终止（状态：${killed.status}）` };
  }
  return { content: `已终止后台任务 ${id}（状态：${killed.status}）` };
}
