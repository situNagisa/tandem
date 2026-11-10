// 项目所在机器的访问接口：工具只经 ctx.env 读写文件、遍历目录、执行命令。
// 本机实现是 localHostEnv；远端实现是 executor/remote-env.ts 的 RemoteHostEnv。
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path, { type PlatformPath } from 'node:path';
import { detectSandboxEngine, type SandboxEngine } from './sandbox.js';
import { cmdUtf8Command } from './util/encoding.js';

export interface HostStat {
  type: 'file' | 'dir' | 'other';
  size: number;
  /** 修改时间（毫秒）。远端执行器返回整毫秒。 */
  mtimeMs: number;
}

export interface HostFile {
  /** 文件真实大小，即使 data 被 maxBytes 截断。 */
  size: number;
  data: Buffer;
}

export interface WalkOptions {
  /** 跳过的目录名，默认 node_modules、.git。 */
  ignore?: string[];
  maxEntries?: number;
  maxDepth?: number;
  /** 指向普通文件的符号链接是否计入结果；指向目录的链接从不跟随。 */
  linkedFiles?: boolean;
  signal?: AbortSignal;
}

export interface WriteOptions {
  /** 父目录不存在时创建。 */
  mkdirp?: boolean;
  /** 目标当前的修改时间（毫秒）；不一致时抛出 code 为 ECONFLICT 的错误且不写入。 */
  expectMtime?: number;
}

export interface ExecRequest {
  /** [可执行文件, ...参数]，不经 shell。 */
  argv: string[];
  cwd: string;
  signal?: AbortSignal;
  /** 每个输出流保留的字节上限，超出部分丢弃，进程继续运行。 */
  outputLimit?: number;
}

export interface ExecResult {
  exit: number;
  signal?: string;
  stdout: Buffer;
  stderr: Buffer;
}

export interface ShellRequest {
  /** 经 shell 执行：POSIX 为 /bin/bash -c；Windows 为 cmd（以 UTF-8 批处理方式）。 */
  command: string;
  cwd: string;
  env?: Record<string, string>;
  /** 沙箱启动前缀（仅 POSIX），之后接 shell 与命令。 */
  wrap?: string[];
  /** 中断时杀掉整棵进程树。调用方以自己的 signal 状态判断中断原因，不依赖结束方式（远端会以 AbortError 结束）。 */
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface ShellResult {
  exit: number;
  signal?: string;
}

export interface HostEnv {
  readonly platform: NodeJS.Platform;
  /** 该机器的路径语义：远端 Windows 用 win32，其余用 posix。 */
  readonly path: PlatformPath;
  readonly home: string;
  readonly tmp: string;
  exec(req: ExecRequest): Promise<ExecResult>;
  /** 经 shell 执行并流式返回输出；结束码非零不算失败，只有无法启动或连接中断才 reject。 */
  shell(req: ShellRequest): Promise<ShellResult>;
  /** 该机器可用的沙箱引擎；没有时返回 undefined。 */
  sandboxEngine(): Promise<SandboxEngine | undefined>;
  hasRipgrep(): Promise<boolean>;
  readonly fs: {
    /** 跟随符号链接；路径不存在时抛出带 code 的错误（ENOENT 等）。 */
    stat(p: string): Promise<HostStat>;
    /** 读取前 maxBytes 字节（缺省整个文件）。 */
    read(p: string, maxBytes?: number): Promise<HostFile>;
    /** 原子写：同目录临时文件再 rename；符号链接指向的文件被改写。 */
    write(p: string, data: Buffer, opts?: WriteOptions): Promise<{ size: number; mtimeMs: number }>;
    /** 返回文件的绝对路径；不跟随目录符号链接，根目录不存在时返回空数组。 */
    walk(root: string, opts?: WalkOptions): Promise<string[]>;
  };
}

export const WALK_DEFAULTS = {
  ignore: ['node_modules', '.git'],
  maxEntries: 20_000,
  maxDepth: 16,
};

let ripgrepAvailable: boolean | undefined;

/** 按字节上限收集输出，超出部分丢弃。 */
export function outputCollector(limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(chunk: Buffer) {
      if (size >= limit) return;
      const part = chunk.subarray(0, limit - size);
      chunks.push(part);
      size += part.length;
    },
    buffer: () => Buffer.concat(chunks),
  };
}

/** 杀掉整棵进程树：POSIX 为进程组，Windows 为 taskkill /T。 */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export const localHostEnv: HostEnv = {
  platform: process.platform,
  path,
  get home() {
    return os.homedir();
  },
  get tmp() {
    return os.tmpdir();
  },
  exec(req) {
    return new Promise<ExecResult>((resolve, reject) => {
      const [file, ...args] = req.argv;
      const child = spawn(file, args, { cwd: req.cwd, signal: req.signal });
      const limit = req.outputLimit ?? Infinity;
      const stdout = outputCollector(limit);
      const stderr = outputCollector(limit);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (err) => reject(err));
      child.on('close', (code, signal) => {
        resolve({
          exit: code ?? -1,
          signal: signal ?? undefined,
          stdout: stdout.buffer(),
          stderr: stderr.buffer(),
        });
      });
    });
  },
  shell(req) {
    return new Promise<ShellResult>((resolve, reject) => {
      const win = process.platform === 'win32';
      const [file, ...args] = win
        ? [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', cmdUtf8Command(req.command)]
        : [...(req.wrap ?? []), '/bin/bash', '-c', req.command];
      const child = spawn(file, args, {
        cwd: req.cwd,
        detached: !win,
        windowsHide: true,
        env: { ...process.env, ...req.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const onAbort = () => killTree(child);
      req.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => req.onStdout?.(chunk));
      child.stderr?.on('data', (chunk: Buffer) => req.onStderr?.(chunk));
      child.on('error', (err) => {
        req.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
      child.on('close', (code, signal) => {
        req.signal?.removeEventListener('abort', onAbort);
        resolve({ exit: code ?? -1, signal: signal ?? undefined });
      });
    });
  },
  async sandboxEngine() {
    return detectSandboxEngine();
  },
  async hasRipgrep() {
    if (ripgrepAvailable === undefined) {
      try {
        const res = spawnSync('rg', ['--version'], { stdio: 'ignore', timeout: 3000 });
        ripgrepAvailable = res.status === 0;
      } catch {
        ripgrepAvailable = false;
      }
    }
    return ripgrepAvailable;
  },
  fs: {
    async stat(p) {
      const st = await fsp.stat(p);
      return {
        type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
        size: st.size,
        mtimeMs: st.mtimeMs,
      };
    },
    async read(p, maxBytes = Infinity) {
      const fh = await fsp.open(p, 'r');
      try {
        const { size } = await fh.stat();
        const want = Math.min(size, maxBytes);
        const data = Buffer.alloc(want);
        let off = 0;
        while (off < want) {
          const { bytesRead } = await fh.read(data, off, want - off, off);
          if (bytesRead === 0) break;
          off += bytesRead;
        }
        return { size, data: data.subarray(0, off) };
      } finally {
        await fh.close();
      }
    },
    async write(p, data, opts = {}) {
      const target = await fsp.realpath(p).catch(() => p);
      const st = await fsp.stat(target).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      });
      if (st?.isDirectory()) throw Object.assign(new Error(`是目录：${p}`), { code: 'EISDIR' });
      if (opts.expectMtime !== undefined && st && st.mtimeMs !== opts.expectMtime) {
        throw Object.assign(new Error(`文件已被修改：${p}`), { code: 'ECONFLICT' });
      }
      const dir = path.dirname(target);
      if (opts.mkdirp) await fsp.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
      try {
        await fsp.writeFile(tmp, data, { mode: st ? st.mode & 0o777 : 0o666 });
        await fsp.rename(tmp, target);
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      const after = await fsp.stat(target);
      return { size: after.size, mtimeMs: after.mtimeMs };
    },
    async walk(root, opts = {}) {
      const ignore = new Set(opts.ignore ?? WALK_DEFAULTS.ignore);
      const maxEntries = opts.maxEntries ?? WALK_DEFAULTS.maxEntries;
      const maxDepth = opts.maxDepth ?? WALK_DEFAULTS.maxDepth;
      const result: string[] = [];
      const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
      while (stack.length > 0 && result.length < maxEntries) {
        if (opts.signal?.aborted) break;
        const { dir, depth } = stack.pop()!;
        let entries: Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (result.length >= maxEntries) break;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!ignore.has(entry.name) && depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
          } else if (entry.isFile()) {
            result.push(full);
          } else if (entry.isSymbolicLink() && opts.linkedFiles) {
            try {
              if ((await fsp.stat(full)).isFile()) result.push(full);
            } catch {
              // 失效链接
            }
          }
        }
      }
      return result;
    },
  },
};
