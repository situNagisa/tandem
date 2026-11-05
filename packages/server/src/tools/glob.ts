// Glob：按 glob 模式查找文件（跳过 node_modules/.git）。
import { statSync } from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { walkFiles } from '../util/fs-walk.js';
import { matchGlob } from '../util/glob.js';
import { isSubPath, resolvePath, toPosix } from '../util/path.js';
import { truncateEnd } from '../util/text.js';

const MAX_RESULTS = 200;

export const definition: ToolDefinition = {
  name: 'Glob',
  readOnly: true,
  requiresApproval: false,
  description:
    'Fast file pattern matching. Supports glob patterns like "**/*.ts" or "src/**/*.{ts,tsx}". ' +
    'Returns matching file paths sorted by modification time.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match files against.' },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to the session working directory.',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
};

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';
  if (!pattern) return { content: '缺少 pattern 参数', isError: true };

  const base = input.path ? resolvePath(ctx.cwd, String(input.path)) : ctx.cwd;
  try {
    if (!statSync(base).isDirectory()) {
      return { content: `搜索路径不是目录: ${base}`, isError: true };
    }
  } catch {
    return { content: `搜索路径不存在: ${base}`, isError: true };
  }

  const files = walkFiles(base, { maxEntries: 50_000, signal: ctx.signal });
  const matched: Array<{ abs: string; mtime: number }> = [];
  for (const abs of files) {
    const rel = toPosix(path.relative(base, abs));
    if (!matchGlob(rel, pattern)) continue;
    let mtime = 0;
    try {
      mtime = statSync(abs).mtimeMs;
    } catch {
      // ignore
    }
    matched.push({ abs, mtime });
  }

  if (matched.length === 0) return { content: `未找到匹配 "${pattern}" 的文件` };

  matched.sort((a, b) => b.mtime - a.mtime);
  const lines = matched.slice(0, MAX_RESULTS).map(({ abs }) => {
    return isSubPath(ctx.cwd, abs) ? toPosix(path.relative(ctx.cwd, abs)) : abs;
  });
  let content = lines.join('\n');
  if (matched.length > MAX_RESULTS) {
    content += `\n\n[共 ${matched.length} 个匹配，仅显示前 ${MAX_RESULTS} 个]`;
  }
  return { content: truncateEnd(content) };
}
