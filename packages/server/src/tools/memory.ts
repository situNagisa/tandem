// Memory：Tandem 私有的项目/全局长期记忆。写入属于 Edit 类操作，需要审批。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { MemoryStore, bodyOfMemory } from '../memory.js';

export const definition: ToolDefinition = {
  name: 'Memory',
  readOnly: false,
  requiresApproval: true,
  description:
    'Tandem 私有的长期记忆（按项目保存，跨会话、跨 /compact 保留，可随配置迁移到其它机器）。' +
    '当用户说「记住…」或你发现长期有效的项目事实、约定、架构决策、用户偏好时用它记录；' +
    '不要记录临时进度、本次任务的中间状态或很快就会过期的信息。' +
    'action=view 查看当前记忆；add 追加（text，每行一条）；replace 用 text 替换第一条包含 old 的条目；remove 删除第一条包含 old 的条目。' +
    'scope 缺省为 project（当前 git 仓库根或 cwd），global 为用户级全局记忆。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['view', 'add', 'replace', 'remove'],
        description: '要执行的操作。',
      },
      text: {
        type: 'string',
        description: 'add/replace 时要写入的事实（支持多行，每行一条）。',
      },
      old: {
        type: 'string',
        description: 'replace/remove 时用于定位条目的子串。',
      },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: '记忆范围，默认 project。',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const action = String(input.action ?? '');
  const scope = input.scope === 'global' ? 'global' : 'project';
  const memory = ctx.memory ?? new MemoryStore(ctx.home ?? '');
  try {
    if (action === 'view') {
      const file = memory.read(scope, ctx.cwd);
      if (!file.exists || !file.text.trim()) {
        return { content: `（${scope === 'global' ? '全局' : '项目'}记忆为空）` };
      }
      return { content: bodyOfMemory(file.text).trim() || '（空）' };
    }
    if (action === 'add') {
      const file = memory.add(ctx.cwd, String(input.text ?? ''), scope);
      return { content: `已写入${scope === 'global' ? '全局' : '项目'}记忆（当前 ${file.entries} 条）。` };
    }
    if (action === 'replace') {
      const file = memory.replace(ctx.cwd, String(input.old ?? ''), String(input.text ?? ''), scope);
      return { content: `已替换记忆条目（当前 ${file.entries} 条）。` };
    }
    if (action === 'remove') {
      const file = memory.removeFact(ctx.cwd, String(input.old ?? ''), scope);
      return { content: `已删除记忆条目（当前 ${file.entries} 条）。` };
    }
    return { content: `未知 action: ${action}`, isError: true };
  } catch (err) {
    return { content: `记忆操作失败: ${(err as Error).message}`, isError: true };
  }
}

