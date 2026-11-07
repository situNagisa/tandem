// 后台任务：Bash run_in_background 启动的长期命令。
// 每个任务有内存环形输出缓冲（最多 1MB）与落盘日志 ~/.tandem/tasks/<id>.log；
// Host 重启后运行中的任务标记为 lost，已结束任务保留可查看。
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { BackgroundTask, BackgroundTaskOutput } from '@tandem/protocol';
import { cmdUtf8Command, decodeProcessOutput } from './util/encoding.js';
import { errorMessage } from './util/text.js';

const RING_LIMIT = 1_000_000;
const EMIT_INTERVAL_MS = 200;

interface TaskInternal {
  task: BackgroundTask;
  logPath: string;
  child?: ChildProcess;
  /** 环形缓冲（最近 RING_LIMIT 个字符）。 */
  output: string;
  /** 已丢弃的字符数 = 环形缓冲起点位移。 */
  dropped: number;
  /** 模型通过 BashOutput 已读到的位移。 */
  readCursor: number;
  pending: Buffer[];
  flushScheduled: boolean;
  lastEmit: number;
  /** 已随 WS 推送到的位移。 */
  sent: number;
  killed: boolean;
  /** 输出进入缓冲/日志前先按项目 secrets 打码。 */
  redact?: (text: string) => string;
}

export type TaskUpdateListener = (
  task: BackgroundTask,
  content?: string,
  truncated?: boolean,
) => void;

export class BackgroundTaskManager {
  private tasks = new Map<string, TaskInternal>();
  private timer?: NodeJS.Timeout;
  private readonly dir: string;
  /** 本次启动从运行中改写为 lost 的任务，供 Host 在会话里补提示（只取一次）。 */
  private newlyLost: BackgroundTask[] = [];

  constructor(
    private readonly home: string,
    private readonly emit: TaskUpdateListener,
  ) {
    this.dir = path.join(home, 'tasks');
    mkdirSync(this.dir, { recursive: true });
    this.load();
    // 兜底节流：即使进程静默也定期把未推送输出发出去
    this.timer = setInterval(() => {
      for (const item of this.tasks.values()) {
        if (item.task.status === 'running' && item.pending.length === 0) this.flush(item, false);
      }
    }, 1000);
    this.timer.unref?.();
  }

  private load(): void {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const file of files) {
      try {
        const task = JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')) as BackgroundTask;
        if (!task?.id) continue;
        const logPath = this.logPath(task.id);
        let output = '';
        try {
          output = readFileSync(logPath, 'utf8');
        } catch {
          output = '';
        }
        const chars = output.length;
        if (task.status === 'running') {
          task.status = 'lost';
          task.endedAt = task.endedAt ?? Date.now();
          this.newlyLost.push({ ...task });
        }
        task.outputChars = chars;
        const dropped = Math.max(0, chars - RING_LIMIT);
        this.tasks.set(task.id, {
          task,
          logPath,
          output: dropped > 0 ? output.slice(dropped) : output,
          dropped,
          readCursor: task.outputChars,
          pending: [],
          flushScheduled: false,
          lastEmit: 0,
          sent: dropped,
          killed: false,
        });
        this.persist(task);
      } catch {
        // 损坏的任务文件忽略
      }
    }
  }

  private logPath(id: string): string {
    return path.join(this.dir, `${id}.log`);
  }

  private metaPath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private persist(task: BackgroundTask): void {
    try {
      writeFileSync(this.metaPath(task.id), JSON.stringify(task));
    } catch {
      // 磁盘异常不影响任务运行
    }
  }

  /** Host 启动恢复时取走「重启时仍在运行」的任务（清空，避免重复提示）。 */
  takeNewlyLost(): BackgroundTask[] {
    const lost = this.newlyLost;
    this.newlyLost = [];
    return lost;
  }

  list(sessionId?: string): BackgroundTask[] {
    const list = [...this.tasks.values()]
      .map((item) => item.task)
      .filter((task) => !sessionId || task.sessionId === sessionId);
    return list.sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id)?.task;
  }

  output(id: string, since = 0): BackgroundTaskOutput | undefined {
    const item = this.tasks.get(id);
    if (!item) return undefined;
    const offset = Math.max(0, Math.floor(since));
    const start = item.dropped;
    const truncated = offset < start;
    const from = Math.max(offset, start) - start;
    return {
      task: { ...item.task },
      content: item.output.slice(from),
      since: item.task.outputChars,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /** BashOutput：读取自上次该工具调用以来的新增输出，并推进游标。 */
  readNew(id: string, filter?: string): { task: BackgroundTask; content: string; truncated: boolean } | undefined {
    const item = this.tasks.get(id);
    if (!item) return undefined;
    const start = item.dropped;
    const cursor = Math.max(item.readCursor, start);
    const truncated = item.readCursor < start;
    let content = item.output.slice(cursor - start);
    item.readCursor = item.task.outputChars;
    if (filter) {
      let re: RegExp;
      try {
        re = new RegExp(filter);
      } catch (err) {
        throw new Error(`filter 不是合法正则：${errorMessage(err)}`);
      }
      content = content
        .split('\n')
        .filter((line) => re.test(line))
        .join('\n');
    }
    return { task: { ...item.task }, content, truncated };
  }

  async start(input: {
    sessionId: string;
    command: string;
    cwd: string;
    description?: string;
    /** 项目/全局 secrets 注入（bash 作用范围）。 */
    env?: Record<string, string>;
    /** 输出在写入内存缓冲、日志与 WS 推送前打码。 */
    redact?: (text: string) => string;
    /** 沙箱启动命令（bwrap / sandbox-exec）；缺省直接跑 bash。 */
    sandbox?: { file: string; args: string[] };
  }): Promise<BackgroundTask> {
    const id = `bash_${randomUUID().slice(0, 8)}`;
    const task: BackgroundTask = {
      id,
      sessionId: input.sessionId,
      command: input.command,
      ...(input.description ? { description: input.description } : {}),
      cwd: input.cwd,
      startedAt: Date.now(),
      status: 'running',
      outputChars: 0,
    };
    const item: TaskInternal = {
      task,
      logPath: this.logPath(id),
      output: '',
      dropped: 0,
      readCursor: 0,
      pending: [],
      flushScheduled: false,
      lastEmit: 0,
      sent: 0,
      killed: false,
      ...(input.redact ? { redact: input.redact } : {}),
    };
    this.tasks.set(id, item);
    this.persist(task);
    try {
      writeFileSync(item.logPath, '');
    } catch {
      // 日志不可写时仍保留内存输出
    }

    const isWin = process.platform === 'win32';
    const child =
      !isWin && input.sandbox
        ? spawn(input.sandbox.file, input.sandbox.args, {
            cwd: input.cwd,
            detached: true,
            env: { ...process.env, ...input.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : isWin
          ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdUtf8Command(input.command)], {
              cwd: input.cwd,
              windowsHide: true,
              env: { ...process.env, ...input.env },
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          : spawn('/bin/bash', ['-c', input.command], {
              cwd: input.cwd,
              detached: true,
              env: { ...process.env, ...input.env },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
    item.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.collect(item, chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.collect(item, chunk));
    child.on('error', (err) => {
      this.collect(item, Buffer.from(`\n[无法启动命令: ${err.message}]\n`, 'utf8'));
      item.task.status = 'exited';
      item.task.exitCode = -1;
      item.task.endedAt = Date.now();
      this.finish(item);
    });
    child.on('close', (code) => {
      if (item.task.status === 'running') {
        item.task.status = item.killed ? 'killed' : 'exited';
        item.task.exitCode = code ?? undefined;
      }
      item.task.endedAt = item.task.endedAt ?? Date.now();
      this.finish(item);
    });

    this.emit({ ...task });
    return { ...task };
  }

  private collect(item: TaskInternal, chunk: Buffer): void {
    if (item.task.status !== 'running') return;
    item.pending.push(chunk);
    if (item.flushScheduled) return;
    item.flushScheduled = true;
    setImmediate(() => this.flush(item, true));
  }

  private flush(item: TaskInternal, throttle: boolean): void {
    item.flushScheduled = false;
    if (item.pending.length > 0) {
      const bytes = Buffer.concat(item.pending);
      item.pending = [];
      const text = decodeProcessOutput(bytes);
      if (text) this.append(item, text);
    }
    if (throttle && Date.now() - item.lastEmit < EMIT_INTERVAL_MS) return;
    this.emitPending(item);
  }

  private append(item: TaskInternal, text: string): void {
    text = item.redact ? item.redact(text) : text;
    item.output += text;
    if (item.output.length > RING_LIMIT) {
      const overflow = item.output.length - RING_LIMIT;
      item.output = item.output.slice(overflow);
      item.dropped += overflow;
    }
    item.task.outputChars += text.length;
    try {
      appendFileSync(item.logPath, text);
    } catch {
      // 忽略日志写入失败
    }
  }

  /** 把自上次推送后的新增文本随 task_updated 发出。 */
  private emitPending(item: TaskInternal): void {
    item.lastEmit = Date.now();
    const truncated = item.sent < item.dropped;
    const start = Math.max(item.sent, item.dropped);
    const content = item.output.slice(start - item.dropped);
    item.sent = item.task.outputChars;
    if (!content && !truncated) return;
    this.emit({ ...item.task }, content || undefined, truncated || undefined);
  }

  private finish(item: TaskInternal): void {
    this.flush(item, false);
    item.child = undefined;
    this.persist(item.task);
    this.emit({ ...item.task });
  }

  async kill(id: string): Promise<BackgroundTask | undefined> {
    const item = this.tasks.get(id);
    if (!item) return undefined;
    if (item.task.status !== 'running') return { ...item.task };
    item.killed = true;
    item.task.status = 'killed';
    item.task.endedAt = Date.now();
    this.persist(item.task);
    try {
      const child = item.child;
      if (child?.pid && process.platform !== 'win32') {
        process.kill(-child.pid, 'SIGKILL');
      } else {
        child?.kill('SIGKILL');
      }
    } catch {
      try {
        item.child?.kill('SIGKILL');
      } catch {
        // 进程可能已退出
      }
    }
    this.finish(item);
    return { ...item.task };
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
