// Edit：精确字符串替换，校验 old_string 唯一性。
import type { HostStat } from '../host-env.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { resolvePath } from '../util/path.js';

export const definition: ToolDefinition = {
  name: 'Edit',
  readOnly: false,
  requiresApproval: true,
  description:
    'Performs an exact string replacement in a file. ' +
    'old_string must appear exactly once unless replace_all is true. ' +
    'Read the file first and include enough context to make the match unique.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to edit.' },
      old_string: { type: 'string', description: 'The exact text to replace.' },
      new_string: { type: 'string', description: 'The replacement text.' },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default false).',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
};

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { env } = ctx;
  const rawPath = typeof input.file_path === 'string' ? input.file_path : '';
  const oldString = typeof input.old_string === 'string' ? input.old_string : '';
  const newString = typeof input.new_string === 'string' ? input.new_string : '';
  const replaceAll = input.replace_all === true;
  if (!rawPath) return { content: '缺少 file_path 参数', isError: true };
  if (!oldString) return { content: 'old_string 不能为空', isError: true };
  if (oldString === newString) return { content: 'old_string 与 new_string 相同，无需修改', isError: true };

  const filePath = resolvePath(ctx.cwd, rawPath, env);
  let st: HostStat;
  let before: Buffer;
  try {
    st = await env.fs.stat(filePath);
    before = (await env.fs.read(filePath)).data;
  } catch {
    return { content: `文件不存在或无法读取: ${filePath}`, isError: true };
  }
  ctx.snapshot?.(filePath, before);
  const content = before.toString('utf8');

  const count = content.split(oldString).length - 1;
  if (count === 0) {
    return {
      content: `未找到要替换的内容。请先用 Read 确认文件当前内容（old_string 必须精确匹配，包括缩进和换行）。`,
      isError: true,
    };
  }
  if (count > 1 && !replaceAll) {
    return {
      content: `old_string 在文件中出现了 ${count} 次。请提供更多上下文使其唯一，或设置 replace_all=true。`,
      isError: true,
    };
  }

  const next = replaceAll
    ? content.split(oldString).join(newString)
    : (() => {
        const index = content.indexOf(oldString);
        return content.slice(0, index) + newString + content.slice(index + oldString.length);
      })();

  try {
    await env.fs.write(filePath, Buffer.from(next, 'utf8'), { expectMtime: st.mtimeMs });
  } catch (err) {
    if ((err as { code?: string }).code === 'ECONFLICT') {
      return { content: '写入失败: 文件已被修改，请先 Read 再编辑', isError: true };
    }
    return { content: `写入失败: ${(err as Error).message}`, isError: true };
  }
  return { content: `已编辑 ${filePath}（替换 ${replaceAll ? count : 1} 处）` };
}
