// Glob：按 glob 模式查找文件（跳过 node_modules/.git）。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { matchGlob } from '../util/glob.js';
import { isSubPath, resolvePath, toPosix } from '../util/path.js';
import { truncateEnd } from '../util/text.js';

const MAX_RESULTS = 200;
const STAT_BATCH = 64;

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
  const { env } = ctx;
  const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : '';
  if (!pattern) return { content: '缺少 pattern 参数', isError: true };

  const base = input.path ? resolvePath(ctx.cwd, String(input.path), env) : ctx.cwd;
  try {
    if ((await env.fs.stat(base)).type !== 'dir') {
      return { content: `搜索路径不是目录: ${base}`, isError: true };
    }
  } catch {
    return { content: `搜索路径不存在: ${base}`, isError: true };
  }

  const files = await env.fs.walk(base, { maxEntries: 50_000, signal: ctx.signal });
  // 只对匹配的文件取 mtime，分批并发查询（远端每次都是一次往返）。
  const queue = files.filter((abs) => matchGlob(toPosix(env.path.relative(base, abs), env), pattern));
  const matched: Array<{ abs: string; mtime: number }> = [];
  for (let i = 0; i < queue.length; i += STAT_BATCH) {
    const batch = queue.slice(i, i + STAT_BATCH);
    const mtimes = await Promise.all(
      batch.map((abs) => env.fs.stat(abs).then((st) => st.mtimeMs, () => 0)),
    );
    batch.forEach((abs, j) => matched.push({ abs, mtime: mtimes[j]! }));
  }

  if (matched.length === 0) return { content: `未找到匹配 "${pattern}" 的文件` };

  matched.sort((a, b) => b.mtime - a.mtime);
  const lines = matched.slice(0, MAX_RESULTS).map(({ abs }) => {
    return isSubPath(ctx.cwd, abs, env) ? toPosix(env.path.relative(ctx.cwd, abs), env) : abs;
  });
  let content = lines.join('\n');
  if (matched.length > MAX_RESULTS) {
    content += `\n\n[共 ${matched.length} 个匹配，仅显示前 ${MAX_RESULTS} 个]`;
  }
  return { content: truncateEnd(content) };
}
