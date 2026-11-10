// Read：按行读取文本文件（带行号）；图片以 image 块返回。
import type { ContentBlock } from '@tandem/protocol';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { resolvePath } from '../util/path.js';
import { truncateMiddle } from '../util/text.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_LINES = 2000;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const definition: ToolDefinition = {
  name: 'Read',
  readOnly: true,
  requiresApproval: false,
  description:
    'Reads a file from the local filesystem. Returns line-numbered content. ' +
    'Supports text files and images. Use offset/limit for large files.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to read.' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based).' },
      limit: { type: 'number', description: `Maximum number of lines to read (default ${MAX_LINES}).` },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
};

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { env } = ctx;
  const rawPath = typeof input.file_path === 'string' ? input.file_path : '';
  if (!rawPath) return { content: '缺少 file_path 参数', isError: true };
  const filePath = resolvePath(ctx.cwd, rawPath, env);

  let stat;
  try {
    stat = await env.fs.stat(filePath);
  } catch {
    return { content: `文件不存在: ${filePath}`, isError: true };
  }
  if (stat.type === 'dir') return { content: `这是一个目录，不是文件: ${filePath}`, isError: true };

  const mediaType = IMAGE_TYPES[env.path.extname(filePath).toLowerCase()];
  if (mediaType) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return { content: `图片过大（${stat.size} 字节），无法读取`, isError: true };
    }
    const dataBase64 = (await env.fs.read(filePath)).data.toString('base64');
    const image: ContentBlock = { type: 'image', mediaType, dataBase64 };
    return {
      content: `已读取图片文件: ${filePath}（${mediaType}，${stat.size} 字节）`,
      images: [image],
    };
  }

  if (stat.size > MAX_TEXT_BYTES) {
    return {
      content: `文件过大（${stat.size} 字节，上限 ${MAX_TEXT_BYTES}）。请使用 offset/limit 或 Grep 定位后再读取。`,
      isError: true,
    };
  }

  let text: string;
  try {
    text = (await env.fs.read(filePath)).data.toString('utf8');
  } catch (err) {
    return { content: `读取失败: ${(err as Error).message}`, isError: true };
  }

  const offsetRaw = Number(input.offset);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 1;
  const limitRaw = Number(input.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_LINES) : MAX_LINES;

  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (offset > lines.length) {
    return { content: `offset ${offset} 超出文件行数（共 ${lines.length} 行）`, isError: true };
  }

  const end = Math.min(lines.length, offset - 1 + limit);
  const out: string[] = [];
  for (let i = offset - 1; i < end; i++) {
    out.push(`${String(i + 1).padStart(6)}\t${lines[i]}`);
  }
  let content = out.join('\n');
  if (end < lines.length) {
    content += `\n\n[已读取 ${offset}-${end} 行，共 ${lines.length} 行；可继续使用 offset=${end + 1}]`;
  }
  return { content: truncateMiddle(content || '(空文件)') };
}
