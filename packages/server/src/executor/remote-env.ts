// 远端主机环境：把 HostEnv 的调用翻译成执行器操作（exec.argv、exec.shell、fs.*、sys.info）。路径语义取远端系统。
import path from 'node:path';
import {
  outputCollector,
  WALK_DEFAULTS,
  type ExecRequest,
  type ExecResult,
  type HostEnv,
  type HostStat,
  type ShellRequest,
  type ShellResult,
} from '../host-env.js';
import type { ExecutorConn } from './conn.js';

interface SysInfo {
  os: string;
  home: string;
  tmp: string;
  tools: Record<string, boolean>;
}

function kindOf(type: string): HostStat['type'] {
  return type === 'dir' ? 'dir' : type === 'file' ? 'file' : 'other';
}

export class RemoteHostEnv implements HostEnv {
  readonly platform: NodeJS.Platform;
  readonly path: path.PlatformPath;
  readonly home: string;
  readonly tmp: string;
  private readonly ripgrep: boolean;
  private readonly bwrap: boolean;

  readonly fs: HostEnv['fs'] = {
    stat: async (p) => {
      const r = await this.conn.request('fs.stat', { path: p });
      return { type: kindOf(r.type), size: r.size, mtimeMs: r.mtimeMs };
    },
    read: async (p, maxBytes = Infinity) => {
      const chunks: Buffer[] = [];
      const args = Number.isFinite(maxBytes) ? { path: p, length: maxBytes } : { path: p };
      const end = await this.conn.request('fs.read', args, { onData: (c) => chunks.push(c) });
      return { size: end.size, data: Buffer.concat(chunks) };
    },
    write: async (p, data, opts = {}) => {
      const end = await this.conn.request(
        'fs.write',
        { path: p, mkdirp: opts.mkdirp === true, expectMtime: opts.expectMtime },
        {},
        undefined,
        data,
      );
      return { size: end.size, mtimeMs: end.mtimeMs };
    },
    walk: async (root, opts = {}) => {
      const chunks: Buffer[] = [];
      try {
        await this.conn.request(
          'fs.walk',
          {
            root,
            ignore: opts.ignore ?? WALK_DEFAULTS.ignore,
            maxEntries: opts.maxEntries ?? WALK_DEFAULTS.maxEntries,
            maxDepth: opts.maxDepth ?? WALK_DEFAULTS.maxDepth,
            linkedFiles: opts.linkedFiles === true,
          },
          { onData: (c) => chunks.push(c) },
          opts.signal,
        );
      } catch (err) {
        // 取消时与本机遍历一样返回已拿到的部分结果
        if (!opts.signal?.aborted) throw err;
      }
      const parts = Buffer.concat(chunks).toString('utf8').split('\0');
      parts.pop();
      return parts;
    },
  };

  private constructor(
    private readonly conn: ExecutorConn,
    info: SysInfo,
  ) {
    this.platform = (info.os === 'windows' ? 'win32' : info.os) as NodeJS.Platform;
    this.path = this.platform === 'win32' ? path.win32 : path.posix;
    this.home = info.home;
    this.tmp = info.tmp;
    this.ripgrep = info.tools.rg === true;
    this.bwrap = info.tools.bwrap === true;
  }

  static async open(conn: ExecutorConn): Promise<RemoteHostEnv> {
    return new RemoteHostEnv(conn, (await conn.request('sys.info')) as SysInfo);
  }

  async hasRipgrep(): Promise<boolean> {
    return this.ripgrep;
  }

  async sandboxEngine() {
    return this.platform === 'linux' && this.bwrap ? { engine: 'bwrap' as const, binary: 'bwrap' } : undefined;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const [file, ...args] = req.argv;
    const limit = req.outputLimit ?? Infinity;
    const stdout = outputCollector(limit);
    const stderr = outputCollector(limit);
    const end = await this.conn.request(
      'exec.argv',
      { file, args, cwd: req.cwd },
      { onStdout: (c) => stdout.push(c), onStderr: (c) => stderr.push(c) },
      req.signal,
    );
    return {
      exit: end.exit,
      signal: end.signal || undefined,
      stdout: stdout.buffer(),
      stderr: stderr.buffer(),
    };
  }

  async shell(req: ShellRequest): Promise<ShellResult> {
    const end = await this.conn.request(
      'exec.shell',
      { command: req.command, cwd: req.cwd, env: req.env ?? {}, wrap: req.wrap ?? [] },
      { onStdout: req.onStdout, onStderr: req.onStderr },
      req.signal,
    );
    return { exit: end.exit, signal: end.signal || undefined };
  }
}
