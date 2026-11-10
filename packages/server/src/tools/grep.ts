// Grep：优先调用 ripgrep，缺失时用 JS 实现（同样的参数子集）。
import type { HostEnv } from '../host-env.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { matchGlob } from '../util/glob.js';
import { isSubPath, resolvePath, toPosix } from '../util/path.js';
import { truncateEnd } from '../util/text.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RG_OUTPUT_LIMIT = 10_000_000;

type OutputMode = 'content' | 'files_with_matches' | 'count';

interface GrepOptions {
  pattern: string;
  searchPath: string;
  cwd: string;
  glob?: string;
  fileType?: string;
  mode: OutputMode;
  caseInsensitive: boolean;
  lineNumbers: boolean;
  before: number;
  after: number;
  headLimit: number;
  offset: number;
  multiline: boolean;
}

export const definition: ToolDefinition = {
  name: 'Grep',
  readOnly: true,
  requiresApproval: false,
  description:
    'Searches file contents with a regular expression (ripgrep syntax). ' +
    'Supports output_mode content/files_with_matches/count, context lines, glob filters. ' +
    'Respects .gitignore and skips node_modules/.git.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: {
        type: 'string',
        description: 'File or directory to search. Defaults to the session working directory.',
      },
      glob: { type: 'string', description: 'Glob filter, e.g. "*.ts" or "src/**/*.tsx".' },
      type: { type: 'string', description: 'File type filter (ripgrep --type), e.g. "js", "py".' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output format. Defaults to content.',
      },
      '-i': { type: 'boolean', description: 'Case insensitive search.' },
      '-n': { type: 'boolean', description: 'Show line numbers in content mode (default true).' },
      '-A': { type: 'number', description: 'Lines of trailing context.' },
      '-B': { type: 'number', description: 'Lines of leading context.' },
      '-C': { type: 'number', description: 'Lines of context (both sides).' },
      head_limit: {
        type: 'number',
        description: 'Limit output entries. Defaults to 250; 0 means unlimited.',
      },
      offset: { type: 'number', description: 'Skip the first N entries.' },
      multiline: { type: 'boolean', description: 'Enable multiline mode.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
};

function intOf(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { env } = ctx;
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  if (!pattern) return { content: '缺少 pattern 参数', isError: true };

  const searchPath = input.path ? resolvePath(ctx.cwd, String(input.path), env) : ctx.cwd;
  try {
    await env.fs.stat(searchPath);
  } catch {
    return { content: `搜索路径不存在: ${searchPath}`, isError: true };
  }

  const rawMode = String(input.output_mode ?? 'content');
  const mode: OutputMode =
    rawMode === 'files_with_matches' || rawMode === 'count' ? rawMode : 'content';
  const contextCount = intOf(input['-C'], -1);
  const before = contextCount >= 0 ? contextCount : intOf(input['-B'], 0);
  const after = contextCount >= 0 ? contextCount : intOf(input['-A'], 0);
  const headLimit = input.head_limit === 0 ? Infinity : intOf(input.head_limit, 250);

  const options: GrepOptions = {
    pattern,
    searchPath,
    cwd: ctx.cwd,
    glob: typeof input.glob === 'string' && input.glob ? input.glob : undefined,
    fileType: typeof input.type === 'string' && input.type ? input.type : undefined,
    mode,
    caseInsensitive: input['-i'] === true,
    lineNumbers: input['-n'] !== false,
    before,
    after,
    headLimit,
    offset: intOf(input.offset, 0),
    multiline: input.multiline === true,
  };

  try {
    const output = (await env.hasRipgrep())
      ? await runRipgrep(env, options, ctx.signal)
      : await runJs(env, options, ctx.signal);
    if (!output.trim()) return { content: `未找到匹配 "${pattern}" 的内容` };
    return { content: truncateEnd(output, 30_000) };
  } catch (err) {
    return { content: `搜索失败: ${(err as Error).message}`, isError: true };
  }
}

function applyLimit(lines: string[], options: GrepOptions): string[] {
  const from = options.offset;
  const to = options.headLimit === Infinity ? undefined : from + options.headLimit;
  return lines.slice(from, to);
}

async function runRipgrep(env: HostEnv, options: GrepOptions, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('用户中断');
  const args = ['rg', '--color', 'never', '--no-heading', '--no-messages'];
  if (options.mode === 'content') {
    if (options.lineNumbers) args.push('--line-number');
    args.push('--with-filename');
  } else if (options.mode === 'files_with_matches') {
    args.push('--files-with-matches');
  } else {
    args.push('--count');
  }
  if (options.caseInsensitive) args.push('--ignore-case');
  if (options.multiline) args.push('--multiline');
  if (options.before > 0) args.push('-B', String(options.before));
  if (options.after > 0) args.push('-A', String(options.after));
  if (options.glob) args.push('--glob', options.glob);
  if (options.fileType) args.push('--type', options.fileType);
  args.push('--glob', '!node_modules', '--glob', '!.git');
  args.push('--', options.pattern, options.searchPath);

  const res = await env.exec({ argv: args, cwd: options.cwd, signal, outputLimit: RG_OUTPUT_LIMIT });
  if (res.exit === 1) return '';
  if (res.exit !== 0) throw new Error(res.stderr.toString('utf8').trim() || `rg 退出码 ${res.exit}`);
  const lines = res.stdout.toString('utf8').split('\n').filter(Boolean);
  return applyLimit(lines, options).join('\n');
}

function displayPath(base: string, cwd: string, env: HostEnv): string {
  if (isSubPath(cwd, base, env)) return toPosix(env.path.relative(cwd, base), env) || '.';
  return base;
}

async function runJs(env: HostEnv, options: GrepOptions, signal: AbortSignal): Promise<string> {
  const { searchPath } = options;
  const info = await env.fs.stat(searchPath).catch(() => undefined);
  if (!info || info.type === 'other') return '';
  const isDir = info.type === 'dir';
  const files = isDir ? await env.fs.walk(searchPath, { maxEntries: 20_000, signal, linkedFiles: true }) : [searchPath];

  let regex: RegExp;
  try {
    regex = new RegExp(options.pattern, `${options.caseInsensitive ? 'i' : ''}${options.multiline ? 'gm' : ''}`);
  } catch (err) {
    throw new Error(`无效的正则表达式: ${(err as Error).message}`);
  }

  const entries: string[] = [];
  for (const file of files) {
    if (signal.aborted) break;
    const rel = isDir ? toPosix(env.path.relative(searchPath, file), env) : env.path.basename(file);
    if (options.glob && !matchGlob(rel, options.glob)) continue;

    let host;
    try {
      host = await env.fs.read(file, MAX_FILE_BYTES);
    } catch {
      continue;
    }
    if (host.size > MAX_FILE_BYTES) continue;
    const content = host.data.toString('utf8');
    if (content.includes('\0')) continue; // 跳过二进制文件

    const shown = displayPath(file, options.cwd, env) || file;
    if (options.mode === 'content') {
      if (options.multiline) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        let guard = 0;
        while ((match = regex.exec(content)) !== null && guard++ < 1000) {
          if (!match[0]) {
            regex.lastIndex++;
            continue;
          }
          const lineNo = content.slice(0, match.index).split('\n').length;
          const text = match[0].split('\n')[0].slice(0, 300);
          entries.push(
            options.lineNumbers ? `${shown}:${lineNo}:${text}` : `${shown}:${text}`,
          );
        }
      } else {
        const lines = content.split(/\r?\n/);
        const hitLines: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) hitLines.push(i);
        }
        if (hitLines.length === 0) continue;
        if (options.before === 0 && options.after === 0) {
          for (const i of hitLines) {
            entries.push(
              options.lineNumbers ? `${shown}:${i + 1}:${lines[i]}` : `${shown}:${lines[i]}`,
            );
          }
        } else {
          const wanted = new Set<number>();
          for (const i of hitLines) {
            for (let j = Math.max(0, i - options.before); j <= Math.min(lines.length - 1, i + options.after); j++) {
              wanted.add(j);
            }
          }
          let prev = -2;
          for (const i of [...wanted].sort((a, b) => a - b)) {
            if (prev >= 0 && i > prev + 1) entries.push('--');
            entries.push(
              options.lineNumbers ? `${shown}:${i + 1}:${lines[i]}` : `${shown}:${lines[i]}`,
            );
            prev = i;
          }
        }
      }
    } else if (options.mode === 'files_with_matches') {
      if (options.multiline) {
        regex.lastIndex = 0;
        if (regex.test(content)) entries.push(shown);
      } else if (content.split(/\r?\n/).some((line) => regex.test(line))) {
        entries.push(shown);
      }
    } else {
      let count = 0;
      if (options.multiline) {
        regex.lastIndex = 0;
        while (regex.exec(content) && count < 100_000) count++;
      } else {
        for (const line of content.split(/\r?\n/)) {
          regex.lastIndex = 0;
          if (regex.test(line)) count++;
        }
      }
      if (count > 0) entries.push(`${shown}:${count}`);
    }
  }

  return applyLimit(entries, options).join('\n');
}
