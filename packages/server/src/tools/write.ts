// Write：整文件写入（自动创建父目录）。
import type { HostStat } from '../host-env.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { resolvePath } from '../util/path.js';

export const definition: ToolDefinition = {
  name: 'Write',
  readOnly: false,
  requiresApproval: true,
  description:
    'Writes content to a file, creating parent directories if needed. ' +
    'Overwrites the whole file. Prefer Edit for modifying existing files.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path of the file to write.' },
      content: { type: 'string', description: 'The full content to write.' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
};

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { env } = ctx;
  const rawPath = typeof input.file_path === 'string' ? input.file_path : '';
  const content = typeof input.content === 'string' ? input.content : '';
  if (!rawPath) return { content: '缺少 file_path 参数', isError: true };

  const filePath = resolvePath(ctx.cwd, rawPath, env);
  try {
    let st: HostStat | undefined;
    try {
      st = await env.fs.stat(filePath);
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }
    if (st && st.type !== 'file') return { content: `写入失败: 不是普通文件: ${filePath}`, isError: true };
    const before = st ? (await env.fs.read(filePath)).data : undefined;
    ctx.snapshot?.(filePath, before);
    const data = Buffer.from(content, 'utf8');
    await env.fs.write(filePath, data, { mkdirp: true, expectMtime: st?.mtimeMs });
    return { content: `已写入 ${filePath}（${data.length} 字节）` };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ECONFLICT') return { content: '写入失败: 文件已被修改，请先 Read 再写入', isError: true };
    return { content: `写入失败: ${(err as Error).message}`, isError: true };
  }
}
