// BashOutput：读取后台 Bash 任务自上次调用以来的新增输出。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import type { BackgroundTaskManager } from '../tasks.js';

export const definition: ToolDefinition = {
  name: 'BashOutput',
  readOnly: true,
  requiresApproval: false,
  description:
    'Reads new output from a background Bash task started with run_in_background. ' +
    'Returns only output produced since the previous BashOutput call for the same task. ' +
    'Use filter as a regular expression to return only matching lines.',
  inputSchema: {
    type: 'object',
    properties: {
      bash_id: { type: 'string', description: 'The background task id returned by Bash.' },
      filter: { type: 'string', description: 'Optional regular expression to filter output lines.' },
    },
    required: ['bash_id'],
    additionalProperties: false,
  },
};

type TaskAwareContext = ToolContext & { backgroundTasks?: BackgroundTaskManager };

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const id = typeof input.bash_id === 'string' ? input.bash_id.trim() : '';
  if (!id) return { content: '缺少 bash_id 参数', isError: true };
  const manager = (ctx as TaskAwareContext).backgroundTasks;
  if (!manager) return { content: '后台任务管理器不可用', isError: true };
  const task = manager.get(id);
  if (!task) return { content: `后台任务不存在: ${id}`, isError: true };
  if (task.sessionId !== ctx.session.id) return { content: '不能读取其他会话的后台任务', isError: true };
  const filter = typeof input.filter === 'string' && input.filter.trim() ? input.filter.trim() : undefined;
  let result;
  try {
    result = manager.readNew(id, filter);
  } catch (err) {
    return { content: (err as Error).message, isError: true };
  }
  if (!result) return { content: `后台任务不存在: ${id}`, isError: true };
  const state =
    result.task.status === 'running'
      ? '运行中'
      : result.task.status === 'killed'
        ? '已终止'
        : result.task.status === 'lost'
          ? '已丢失（Host 重启）'
          : `已结束（退出码 ${result.task.exitCode ?? '未知'}）`;
  const header = `[${id}] ${state}`;
  const body = result.content.replace(/\s+$/, '');
  const notice = result.truncated ? '\n[较早输出已超出 1MB 缓冲被丢弃]' : '';
  if (!body) {
    return {
      content: `${header}\n(没有新输出)${notice}`,
      isError: result.task.status === 'lost',
    };
  }
  return {
    content: `${header}\n${body}${notice}`,
    isError: result.task.status === 'lost',
  };
}
