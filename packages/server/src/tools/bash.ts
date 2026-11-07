// Bash：在会话 cwd 内执行命令，超时终止，输出截断。
import { spawn } from 'node:child_process';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { truncateMiddle } from '../util/text.js';
import { cmdUtf8Command, decodeProcessOutput } from '../util/encoding.js';
import type { BackgroundTaskManager } from '../tasks.js';
import { sandboxCommand, type SandboxProfile } from '../sandbox.js';

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

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return { content: '缺少 command 参数', isError: true };
  const profile = (ctx as ToolContext & { sandbox?: SandboxProfile }).sandbox;
  if (input.run_in_background === true) {
    const manager = (ctx as ToolContext & { backgroundTasks?: BackgroundTaskManager }).backgroundTasks;
    if (!manager) return { content: '后台任务管理器不可用', isError: true };
    const task = await manager.start({
      sessionId: ctx.session.id,
      command,
      cwd: ctx.cwd,
      ...(profile ? { sandbox: sandboxCommand(command, ctx.cwd, profile) } : {}),
      ...(typeof input.description === 'string' && input.description.trim()
        ? { description: input.description.trim() }
        : {}),
      ...(ctx.secretEnv ? { env: ctx.secretEnv } : {}),
      ...(ctx.redact ? { redact: ctx.redact } : {}),
    });
    return {
      content: `Command running in background with ID: ${task.id}\nOutput is being written to ~/.tandem/tasks/${task.id}.log. Use BashOutput with bash_id "${task.id}" to read new output.`,
    };
  }

  let timeout = Number(input.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = 120_000;
  timeout = Math.min(Math.max(timeout, 1_000), 600_000);

  if (ctx.signal.aborted) return { content: '用户中断', isError: true };

  const isWin = process.platform === 'win32';
  const sandboxed = isWin ? undefined : sandboxCommand(command, ctx.cwd, profile);
  const child = sandboxed
    ? spawn(sandboxed.file, sandboxed.args, {
        cwd: ctx.cwd,
        detached: true,
        env: { ...process.env, ...ctx.secretEnv },
      })
    : isWin
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdUtf8Command(command)], {
          cwd: ctx.cwd,
          windowsHide: true,
          env: { ...process.env, ...ctx.secretEnv },
        })
      : spawn('/bin/bash', ['-c', command], {
          cwd: ctx.cwd,
          detached: true,
          env: { ...process.env, ...ctx.secretEnv },
        });

  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let truncated = false;
  let timedOut = false;

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

  child.stdout?.on('data', (chunk: Buffer) => collect('out', chunk));
  child.stderr?.on('data', (chunk: Buffer) => collect('err', chunk));

  const result = await new Promise<ToolResult>((resolve) => {
    let settled = false;
    const finish = (res: ToolResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    };
    const kill = () => {
      try {
        if (!isWin && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    };
    const onAbort = () => {
      kill();
      finish({ content: '用户中断', isError: true });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      finish({ content: `无法启动命令: ${err.message}`, isError: true });
    });
    child.on('close', (code) => {
      const stdout = decodeProcessOutput(Buffer.concat(outChunks));
      const stderr = decodeProcessOutput(Buffer.concat(errChunks));
      const parts: string[] = [];
      if (stdout) parts.push(stdout.replace(/\s+$/, '').slice(0, MAX_BUFFER));
      if (stderr) parts.push(`[stderr]\n${stderr.replace(/\s+$/, '').slice(0, MAX_BUFFER)}`);
      if (parts.length === 0) parts.push('(无输出)');
      let text = parts.join('\n');
      if (truncated) text += '\n[输出过长，已截断]';
      if (timedOut) text += `\n[命令超时（${timeout}ms），已终止]`;
      else if (code !== 0) text += `\n[退出码: ${code ?? '未知'}]`;
      finish({ content: truncateMiddle(text), isError: timedOut || code !== 0 });
    });
  });

  return result;
}
