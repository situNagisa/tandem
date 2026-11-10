// Bash：在会话 cwd 内执行命令，超时终止，输出截断。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { errorMessage, truncateMiddle } from '../util/text.js';
import { decodeProcessOutput } from '../util/encoding.js';
import type { BackgroundTaskManager } from '../tasks.js';
import { sandboxWrap, type SandboxProfile } from '../sandbox.js';

const MAX_BUFFER = 2_000_000;

export const definition: ToolDefinition = {
  name: 'Bash',
  readOnly: false,
  requiresApproval: true,
  description:
    'Executes a shell command in the session working directory and returns its output. ' +
    'Use for builds, tests, git, package managers, etc. Avoid interactive commands. ' +
    'On Windows the command runs through cmd.exe.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute.' },
      description: {
        type: 'string',
        description: 'Clear, concise description of what this command does (5-10 words).',
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (default 120000, max 600000).',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'Run the command in the background and return a bash_id immediately. Use BashOutput to read new output and KillBash to stop it.',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
};

/** 沙箱前缀；该机器没有可用引擎时不包装，并返回一句提示。 */
async function sandboxFor(ctx: ToolContext): Promise<{ wrap?: string[]; notice?: string }> {
  const profile = (ctx as ToolContext & { sandbox?: SandboxProfile }).sandbox;
  if (!profile) return {};
  const wrap = await sandboxWrap(ctx.env, ctx.cwd, profile);
  if (wrap) return { wrap };
  const notice =
    ctx.env.platform === 'linux'
      ? '[未检测到 bwrap，本次命令未在沙箱中运行。可安装：sudo apt install bubblewrap]'
      : ctx.env.platform === 'win32'
        ? '[该机器不支持文件系统沙箱，本次命令仅做静态检查]'
        : '[该机器没有可用的沙箱，本次命令未在沙箱中运行]';
  return { notice };
}

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return { content: '缺少 command 参数', isError: true };
  const { wrap, notice } = await sandboxFor(ctx);
  if (input.run_in_background === true) {
    const manager = (ctx as ToolContext & { backgroundTasks?: BackgroundTaskManager }).backgroundTasks;
    if (!manager) return { content: '后台任务管理器不可用', isError: true };
    const task = await manager.start({
      sessionId: ctx.session.id,
      command,
      cwd: ctx.cwd,
      env: ctx.env,
      ...(wrap ? { wrap } : {}),
      ...(typeof input.description === 'string' && input.description.trim()
        ? { description: input.description.trim() }
        : {}),
      ...(ctx.secretEnv ? { secretEnv: ctx.secretEnv } : {}),
      ...(ctx.redact ? { redact: ctx.redact } : {}),
    });
    return {
      content: `${notice ? `${notice}\n` : ''}Command running in background with ID: ${task.id}\nOutput is being written to ~/.tandem/tasks/${task.id}.log. Use BashOutput with bash_id "${task.id}" to read new output.`,
    };
  }

  let timeout = Number(input.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = 120_000;
  timeout = Math.min(Math.max(timeout, 1_000), 600_000);

  if (ctx.signal.aborted) return { content: '用户中断', isError: true };

  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let truncated = false;

  const collect = (target: 'out' | 'err', chunk: Buffer) => {
    const used = target === 'out' ? outBytes : errBytes;
    if (used >= MAX_BUFFER * 2) {
      truncated = true;
      return;
    }
    // 先按字节攒起来，结束时统一解码：Windows 中文输出是 GBK，按块 toString('utf8')
    // 既会乱码，也可能把多字节字符从中间截断。
    if (target === 'out') {
      outChunks.push(chunk);
      outBytes += chunk.length;
    } else {
      errChunks.push(chunk);
      errBytes += chunk.length;
    }
    if (used + chunk.length > MAX_BUFFER * 2) truncated = true;
  };

  const abort = new AbortController();
  const onAbort = () => abort.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, timeout);

  let exit: number | undefined;
  let failure: string | undefined;
  try {
    const res = await ctx.env.shell({
      command,
      cwd: ctx.cwd,
      env: ctx.secretEnv,
      wrap,
      signal: abort.signal,
      onStdout: (chunk) => collect('out', chunk),
      onStderr: (chunk) => collect('err', chunk),
    });
    exit = res.exit;
  } catch (err) {
    failure = errorMessage(err);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }

  if (ctx.signal.aborted) return { content: '用户中断', isError: true };
  if (failure !== undefined && !timedOut) return { content: `执行失败: ${failure}`, isError: true };

  const stdout = decodeProcessOutput(Buffer.concat(outChunks));
  const stderr = decodeProcessOutput(Buffer.concat(errChunks));
  const parts: string[] = [];
  if (stdout) parts.push(stdout.replace(/\s+$/, '').slice(0, MAX_BUFFER));
  if (stderr) parts.push(`[stderr]\n${stderr.replace(/\s+$/, '').slice(0, MAX_BUFFER)}`);
  if (parts.length === 0) parts.push('(无输出)');
  let text = parts.join('\n');
  if (truncated) text += '\n[输出过长，已截断]';
  if (timedOut) text += `\n[命令超时（${timeout}ms），已终止]`;
  else if (exit !== 0) text += `\n[退出码: ${exit === -1 || exit === undefined ? '未知' : exit}]`;
  if (notice) text = `${notice}\n${text}`;
  return {
    content: truncateMiddle(text),
    isError: timedOut || exit !== 0,
  };
}
