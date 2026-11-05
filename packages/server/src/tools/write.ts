// Write：整文件写入（自动创建父目录）。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
  const rawPath = typeof input.file_path === 'string' ? input.file_path : '';
  const content = typeof input.content === 'string' ? input.content : '';
  if (!rawPath) return { content: '缺少 file_path 参数', isError: true };

  const filePath = resolvePath(ctx.cwd, rawPath);
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
    return { content: `已写入 ${filePath}（${Buffer.byteLength(content, 'utf8')} 字节）` };
  } catch (err) {
    return { content: `写入失败: ${(err as Error).message}`, isError: true };
  }
}
