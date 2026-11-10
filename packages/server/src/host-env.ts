// 项目所在机器的访问接口：工具只经 ctx.env 读文件、遍历目录、执行命令。
// 本机实现是 localHostEnv；远端实现是 executor/remote-env.ts 的 RemoteHostEnv。
import { spawn, spawnSync } from 'node:child_process';
import type { Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path, { type PlatformPath } from 'node:path';

export interface HostStat {
  type: 'file' | 'dir' | 'other';
  size: number;
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

export interface HostEnv {
  readonly platform: NodeJS.Platform;
  /** 该机器的路径语义：远端 Windows 用 win32，其余用 posix。 */
  readonly path: PlatformPath;
  readonly home: string;
  exec(req: ExecRequest): Promise<ExecResult>;
  hasRipgrep(): Promise<boolean>;
  readonly fs: {
    /** 跟随符号链接；路径不存在时抛出带 code 的错误（ENOENT 等）。 */
    stat(p: string): Promise<HostStat>;
    /** 读取前 maxBytes 字节（缺省整个文件）。 */
    read(p: string, maxBytes?: number): Promise<HostFile>;
    /** 返回文件的绝对路径；不跟随目录符号链接，根目录不存在时返回空数组。 */
    walk(root: string, opts?: WalkOptions): Promise<string[]>;
  };
}

const DEFAULT_IGNORE = ['node_modules', '.git'];

let ripgrepAvailable: boolean | undefined;

function collector(limit: number) {
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

export const localHostEnv: HostEnv = {
  platform: process.platform,
  path,
  get home() {
    return os.homedir();
  },
  exec(req) {
    return new Promise<ExecResult>((resolve, reject) => {
      const [file, ...args] = req.argv;
      const child = spawn(file, args, { cwd: req.cwd, signal: req.signal });
      const limit = req.outputLimit ?? Infinity;
      const stdout = collector(limit);
      const stderr = collector(limit);
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
    async walk(root, opts = {}) {
      const ignore = new Set(opts.ignore ?? DEFAULT_IGNORE);
      const maxEntries = opts.maxEntries ?? 20_000;
      const maxDepth = opts.maxDepth ?? 16;
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
