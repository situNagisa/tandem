// M2：同一组接口与工具用例分别跑 LocalHostEnv 与连接本机执行器的 RemoteHostEnv，结果必须一致。
// Linux 远端用 linux-amd64 执行器；Windows 远端经 WSL 互操作运行 windows-amd64.exe，fixture 放在 Windows 临时目录下。
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { localHostEnv, type HostEnv } from '../../src/host-env.js';
import { ExecutorConn, type ExecutorAuth } from '../../src/executor/conn.js';
import { RemoteHostEnv } from '../../src/executor/remote-env.js';
import * as P from '../../src/executor/wire.js';
import type { ToolContext } from '../../src/types.js';
import { run as runRead } from '../../src/tools/read.js';
import { run as runGlob } from '../../src/tools/glob.js';
import { run as runGrep } from '../../src/tools/grep.js';
import { CMD_EXE, forEachTarget, runCleanups, startExecutor, WINDOWS_AVAILABLE, type Sandbox, type Target } from './harness.js';

const WIN_TEMP = '/mnt/c/Users/JDHC/AppData/Local/Temp';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const FILES: Array<[string, string | Buffer]> = [
  ['README.md', '# 标题\nhello world\nTODO: readme\n'],
  ['src/app.ts', 'export const x = 1;\n// TODO: fix\nconst y = "todo";\n'],
  ['src/中文 目录/文件.ts', "const 中文 = '你好';\n// TODO 中文\n"],
  ['src/Mixed.TS', 'let m = 1; // todo mixed\n'],
  ['docs/notes.txt', 'notes\nTODO in notes\n'],
  ['node_modules/pkg/index.js', 'TODO in node_modules\n'],
  ['.git/config', 'TODO in git\n'],
  ['img.png', PNG],
  ['bin.dat', Buffer.from([1, 2, 0, 3, 84, 79, 68, 79])],
  ['big.txt', `${'a'.repeat(2_100_000)}\nTODO big\n`],
];
const LINKS: Array<[string, string, boolean]> = [
  ['link-file.txt', 'README.md', false],
  ['link-dir', 'src', true],
  ['broken', 'nope', false],
];

interface Fixture {
  sandbox: Sandbox;
  /** 工作站看到的仓库路径（Linux 形式）。 */
  localRepo: string;
  /** 远端看到的仓库路径（远端系统形式）。 */
  nativeRepo: string;
  remove(): void;
}

/** 经 cmd 的 mklink 创建 Windows 符号链接；路径作为独立参数传入，避免 WSL 互操作对内嵌引号的转义问题。 */
function mklink(link: string, target: string, dir: boolean): void {
  execFileSync(CMD_EXE, ['/d', '/c', 'mklink', ...(dir ? ['/D'] : []), link, target], { cwd: '/mnt/c/Windows', stdio: 'ignore' });
}

function probeSymlinks(target: Target): boolean {
  if (target === 'linux') return true;
  const dir = mkdtempSync(path.join(WIN_TEMP, 'tandem-m2-probe-'));
  try {
    writeFileSync(path.join(dir, 'a.txt'), 'a');
    const win = execFileSync('wslpath', ['-w', dir], { encoding: 'utf8' }).trim();
    mklink(`${win}\\b.txt`, `${win}\\a.txt`, false);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createFixture(target: Target): Fixture {
  const linux = target === 'linux';
  const localTop = linux ? mkdtempSync(path.join(os.tmpdir(), 'tandem-m2-')) : mkdtempSync(path.join(WIN_TEMP, 'tandem-m2-'));
  try {
    return fillFixture(target, localTop);
  } catch (err) {
    rmSync(localTop, { recursive: true, force: true });
    throw err;
  }
}

function fillFixture(target: Target, localTop: string): Fixture {
  const linux = target === 'linux';
  const nativeTop = linux ? localTop : execFileSync('wslpath', ['-w', localTop], { encoding: 'utf8' }).trim();
  const pl = linux ? path.posix : path.win32;
  const binDir = path.join(localTop, 'bin');
  mkdirSync(binDir);
  const localRepo = path.join(localTop, 'repo');
  const nativeRepo = pl.join(nativeTop, 'repo');
  mkdirSync(localRepo);
  const sandbox: Sandbox = {
    target,
    root: nativeTop,
    local: binDir,
    nat: (...parts) => pl.join(nativeTop, ...parts),
    loc: (...parts) => path.join(localTop, ...parts),
    home(name) {
      const dir = path.join(localTop, name);
      mkdirSync(dir, { recursive: true });
      return { native: pl.join(nativeTop, name), local: dir };
    },
  };

  let t = 1_700_000_000;
  const stamp = (file: string) => {
    t += 60;
    utimesSync(file, t, t);
  };
  for (const [rel, body] of FILES) {
    const file = path.join(localRepo, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
    stamp(file);
  }
  for (const [name, target, isDir] of LINKS) {
    const link = path.join(localRepo, name);
    if (linux) {
      symlinkSync(path.join(localRepo, target), link, isDir ? 'dir' : 'file');
    } else {
      mklink(pl.join(nativeRepo, name), pl.join(nativeRepo, target), isDir);
      if (!lstatSync(link).isSymbolicLink()) throw new Error(`符号链接未创建：${link}`);
    }
  }
  return {
    sandbox,
    localRepo,
    nativeRepo,
    remove: () => rmSync(localTop, { recursive: true, force: true }),
  };
}

async function startAcceptor() {
  const identity = P.genKeyPair('ed25519');
  const hosts = new Map<string, Buffer>();
  const tokens = new Set<string>();
  const auth: ExecutorAuth = {
    identity,
    execPubOf: (hostId) => hosts.get(hostId),
    enroll({ token, execPub }) {
      if (!tokens.delete(token)) throw new Error('令牌无效');
      const hostId = randomBytes(12).toString('base64url');
      hosts.set(hostId, execPub);
      return hostId;
    },
  };
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: P.WS_PATH, perMessageDeflate: false });
  await once(wss, 'listening');
  const accepted: ExecutorConn[] = [];
  const waiting: Array<(conn: ExecutorConn) => void> = [];
  wss.on('connection', (sock: WebSocket) => {
    ExecutorConn.accept(sock, auth).then(
      (conn) => {
        const next = waiting.shift();
        if (next) next(conn);
        else accepted.push(conn);
      },
      () => sock.close(),
    );
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    issueToken() {
      const token = `ach_${randomBytes(24).toString('hex')}.${P.fingerprint(identity.pub)}`;
      tokens.add(token);
      return token;
    },
    nextConn(timeoutMs = 20_000): Promise<ExecutorConn> {
      const ready = accepted.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待执行器连接超时')), timeoutMs);
        waiting.push((conn) => {
          clearTimeout(timer);
          resolve(conn);
        });
      });
    },
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

interface Side {
  name: 'local' | 'remote';
  env: HostEnv;
  root: string;
}

/** 失败只比较错误码：Node 与 Go 的错误文案不同。 */
async function settle<T>(fn: () => Promise<T>): Promise<T | { rejected: string | undefined }> {
  try {
    return await fn();
  } catch (err) {
    return { rejected: (err as { code?: string }).code };
  }
}

function withRipgrep(env: HostEnv, on: boolean): HostEnv {
  return Object.create(env, { hasRipgrep: { value: async () => on } }) as HostEnv;
}

function ctxFor(side: Side): ToolContext {
  return {
    cwd: side.root,
    session: {} as ToolContext['session'],
    signal: new AbortController().signal,
    updateTodos: () => {},
    env: side.env,
  } as ToolContext;
}

/** 远端 Windows 的路径写法：盘符 + 反斜杠、盘符 + 正斜杠、相对路径带反斜杠；其余远端只有原生形式。 */
function pathForms(side: Side, rel: string): string[] {
  const native = side.env.path.join(side.root, rel);
  if (side.env.platform !== 'win32') return [native];
  return [
    native,
    `${side.root}\\${rel.replaceAll('/', '\\')}`,
    `${side.root.replaceAll('\\', '/')}/${rel}`,
    rel.replaceAll('/', '\\'),
  ];
}

forEachTarget('M2 Local/Remote 对照', (target) => {
  const symlinks = target === 'linux' || (WINDOWS_AVAILABLE && probeSymlinks(target));
  const linkTest = symlinks ? test : test.skip;
  const rgTest = target === 'linux' ? test : test.skip;

  let fx: Fixture;
  let acceptor: Awaited<ReturnType<typeof startAcceptor>>;
  let conn: ExecutorConn;
  let local: Side;
  let remote: Side;
  let roots: string[];

  const norm = (text: string): string => {
    let out = text.replaceAll('\\', '/');
    for (const root of roots) out = out.split(root).join('<ROOT>');
    return out;
  };

  const runTool = async (side: Side, name: 'Read' | 'Glob' | 'Grep', input: Record<string, unknown>) => {
    const tool = name === 'Read' ? runRead : name === 'Glob' ? runGlob : runGrep;
    const res = await tool(input, ctxFor(side));
    return { content: norm(res.content), isError: res.isError === true, images: res.images };
  };

  const sorted = (lines: string): string[] => norm(lines).split('\n').filter(Boolean).sort();

  beforeAll(async () => {
    fx = createFixture(target);
    acceptor = await startAcceptor();
    startExecutor({
      target,
      sandbox: fx.sandbox,
      home: fx.sandbox.home('home'),
      server: acceptor.url,
      token: acceptor.issueToken(),
    });
    conn = await acceptor.nextConn();
    expect(conn.hostId).toMatch(/^[\w-]+$/);
    const env = await RemoteHostEnv.open(conn);
    local = { name: 'local', env: localHostEnv, root: fx.localRepo };
    remote = { name: 'remote', env, root: fx.nativeRepo };
    roots = [fx.localRepo, fx.nativeRepo.replaceAll('\\', '/')];
  }, 120_000);

  afterAll(async () => {
    conn?.close();
    await acceptor?.close();
    await runCleanups();
    fx?.remove();
  });

  const both = async <T>(fn: (side: Side) => Promise<T>): Promise<[unknown, unknown]> => [
    await settle(() => fn(local)),
    await settle(() => fn(remote)),
  ];

  test('stat：文件、目录、不存在的路径结果一致（mtime 按整毫秒比较；目录大小是平台相关值，不比较）', async () => {
    for (const rel of ['README.md', 'src', 'docs/不存在.txt']) {
      const [l, r] = await both(async (s) => {
        const st = await s.env.fs.stat(s.env.path.join(s.root, rel));
        return { type: st.type, size: st.type === 'file' ? st.size : undefined, mtimeMs: Math.floor(st.mtimeMs) };
      });
      expect(r).toEqual(l);
    }
  });

  linkTest('stat：失效符号链接都报 ENOENT', async () => {
    const [l, r] = await both((s) => s.env.fs.stat(s.env.path.join(s.root, 'broken')));
    expect(l).toEqual({ rejected: 'ENOENT' });
    expect(r).toEqual(l);
  });

  test('read：整文件、按字节截断、中文路径结果一致', async () => {
    const [l, r] = await both(async (s) => (await s.env.fs.read(s.env.path.join(s.root, 'README.md'))).data.toString('utf8'));
    expect(r).toEqual(l);
    const [lz, rz] = await both(async (s) => (await s.env.fs.read(s.env.path.join(s.root, 'src/中文 目录/文件.ts'))).data.toString('utf8'));
    expect(rz).toEqual(lz);

    const [lp, rp] = await both(async (s) => {
      const f = await s.env.fs.read(s.env.path.join(s.root, 'src/app.ts'), 5);
      return { size: f.size, hex: f.data.toString('hex') };
    });
    expect(rp).toEqual(lp);
  });

  test('walk：默认忽略 node_modules 与 .git，结果集合一致，截断数量一致', async () => {
    const [l, r] = await both(async (s) => (await s.env.fs.walk(s.root)).map(norm).sort());
    expect(r).toEqual(l);
    expect(l).toEqual(expect.arrayContaining(['<ROOT>/README.md', '<ROOT>/src/中文 目录/文件.ts']));
    expect((l as string[]).some((p) => p.includes('node_modules') || p.includes('.git/'))).toBe(false);

    const [lc, rc] = await both(async (s) => (await s.env.fs.walk(s.root, { maxEntries: 3 })).length);
    expect(rc).toEqual(lc);
    expect(lc).toBe(3);

    const [lm, rm] = await both(async (s) => (await s.env.fs.walk(s.env.path.join(s.root, 'no-such-dir'))).length);
    expect(rm).toEqual(lm);
    expect(lm).toBe(0);
  });

  linkTest('walk：linkedFiles 只把指向普通文件的链接计入，目录链接不跟随', async () => {
    const [l, r] = await both(async (s) => (await s.env.fs.walk(s.root, { linkedFiles: true })).map(norm).sort());
    expect(r).toEqual(l);
    expect(l).toEqual(expect.arrayContaining(['<ROOT>/link-file.txt']));
    expect(l).not.toEqual(expect.arrayContaining(['<ROOT>/link-dir/app.ts']));
    const [lf, rf] = await both(async (s) => (await s.env.fs.walk(s.root)).map(norm));
    expect(rf).toEqual(lf);
    expect(lf).not.toContain('<ROOT>/link-file.txt');
  });

  test('exec：退出码、stdout、stderr 一致（Windows 远端用 cmd，本机用 sh）', async () => {
    const probe = (s: Side) =>
      s.env.platform === 'win32'
        ? ['cmd.exe', '/d', '/c', 'echo hi & echo err 1>&2 & exit /b 3']
        : ['/bin/sh', '-c', 'printf hi; printf err 1>&2; exit 3'];
    const run = async (s: Side) => {
      const res = await s.env.exec({ argv: probe(s), cwd: s.root });
      return { exit: res.exit, stdout: res.stdout.toString('utf8').trim(), stderr: res.stderr.toString('utf8').trim() };
    };
    const l = await run(local);
    const r = await run(remote);
    expect(l).toEqual({ exit: 3, stdout: 'hi', stderr: 'err' });
    expect(r).toEqual(l);
  });

  test('exec：工作目录不存在时都报 ENOENT；outputLimit 按字节截断', async () => {
    const [l, r] = await both((s) => s.env.exec({ argv: s.env.platform === 'win32' ? ['cmd.exe', '/c', 'echo x'] : ['/bin/sh', '-c', 'echo x'], cwd: s.env.path.join(s.root, 'nope') }));
    expect(l).toEqual({ rejected: 'ENOENT' });
    expect(r).toEqual(l);

    const limited = async (s: Side) => {
      const argv = s.env.platform === 'win32' ? ['cmd.exe', '/d', '/c', 'echo 0123456789ABCDEF'] : ['/bin/sh', '-c', 'printf 0123456789ABCDEF'];
      return (await s.env.exec({ argv, cwd: s.root, outputLimit: 4 })).stdout.toString('utf8');
    };
    expect(await limited(local)).toBe('0123');
    expect(await limited(remote)).toBe('0123');
  });

  test('exec：中断后以 AbortError 结束，连接仍可继续使用', async () => {
    const sleepFor = (s: Side) =>
      s.env.platform === 'win32' ? ['cmd.exe', '/d', '/c', 'ping -n 11 127.0.0.1 >nul'] : ['/bin/sh', '-c', 'sleep 10'];
    const aborted = async (s: Side) => {
      const ac = new AbortController();
      const started = Date.now();
      setTimeout(() => ac.abort(), 300);
      try {
        await s.env.exec({ argv: sleepFor(s), cwd: s.root, signal: ac.signal });
        return { error: 'resolved', elapsed: Date.now() - started };
      } catch (err) {
        return { error: { name: (err as Error).name, message: (err as Error).message }, elapsed: Date.now() - started };
      }
    };
    const l = await aborted(local);
    const r = await aborted(remote);
    expect(l.error).toEqual({ name: 'AbortError', message: 'The operation was aborted' });
    expect(r.error).toEqual(l.error);
    expect(r.elapsed).toBeLessThan(5000);
    expect((await remote.env.fs.stat(remote.root)).type).toBe('dir');
  });

  test('Read：常规文件、分页、中文与空格路径、大小写、图片、超大文件、二进制结果一致', async () => {
    const cases: Array<Record<string, unknown>> = [
      { file_path: 'README.md' },
      { file_path: 'src/app.ts', offset: 2, limit: 1 },
      { file_path: 'src/中文 目录/文件.ts' },
      { file_path: 'nope.txt' },
      { file_path: 'src' },
      { file_path: 'img.png' },
      { file_path: 'big.txt' },
      { file_path: 'bin.dat' },
      { file_path: 'readme.md' },
    ];
    for (const input of cases) {
      const fileRel = input.file_path as string;
      const l = await runTool(local, 'Read', { ...input, file_path: local.env.path.join(local.root, fileRel) });
      const r = await runTool(remote, 'Read', { ...input, file_path: remote.env.path.join(remote.root, fileRel) });
      expect(r, fileRel).toEqual(l);
    }
  });

  test('Read：盘符、反斜杠、正斜杠、相对路径写法读到同一文件', async () => {
    const expected = await runTool(local, 'Read', { file_path: path.posix.join(local.root, 'src/中文 目录/文件.ts') });
    for (const form of pathForms(remote, 'src/中文 目录/文件.ts')) {
      expect(await runTool(remote, 'Read', { file_path: form }), form).toEqual(expected);
    }
  });

  linkTest('Read：符号链接文件与失效链接结果一致', async () => {
    for (const rel of ['link-file.txt', 'broken']) {
      const l = await runTool(local, 'Read', { file_path: path.posix.join(local.root, rel) });
      const r = await runTool(remote, 'Read', { file_path: remote.env.path.join(remote.root, rel) });
      expect(r, rel).toEqual(l);
    }
  });

  test('Glob：模式、子目录、大小写、无匹配、路径不存在或不是目录，结果一致', async () => {
    const cases: Array<[string, string?]> = [
      ['**/*.ts'],
      ['src/**/*.{ts,txt}'],
      ['**/*.TS'],
      ['*.md', 'docs'],
      ['**/*.ts', 'src/中文 目录'],
      ['nomatch'],
      ['*', 'nope'],
      ['*', 'README.md'],
      ['**/*'],
    ];
    for (const [pattern, p] of cases) {
      const l = await runTool(local, 'Glob', { pattern, ...(p ? { path: p } : {}) });
      const r = await runTool(remote, 'Glob', { pattern, ...(p ? { path: p.replaceAll('/', remote.env.path.sep) } : {}) });
      expect(r, `${pattern} ${p ?? ''}`).toEqual(l);
    }
  });

  test('Grep：JS 实现（无 rg）内容、文件列表、计数、上下文、过滤、二进制、大文件结果集合一致', async () => {
    const cases: Array<Record<string, unknown>> = [
      { pattern: 'TODO' },
      { pattern: 'todo', '-i': true },
      { pattern: 'TODO', output_mode: 'files_with_matches' },
      { pattern: 'TODO', output_mode: 'count' },
      { pattern: 'TODO', '-C': 1 },
      { pattern: 'TODO', glob: '*.ts' },
      { pattern: '中文' },
      { pattern: 'TODO', path: 'src/app.ts' },
      { pattern: 'TODO', path: 'nope' },
      { pattern: '(' },
    ];
    const jsLocal = { ...local, env: withRipgrep(local.env, false) };
    const jsRemote = { ...remote, env: withRipgrep(remote.env, false) };
    for (const input of cases) {
      const l = await runTool(jsLocal, 'Grep', input);
      const r = await runTool(jsRemote, 'Grep', input);
      expect({ ...r, content: sorted(r.content) }, JSON.stringify(input)).toEqual({ ...l, content: sorted(l.content) });
    }
  });

  rgTest('Grep：ripgrep 路径（远端 Linux 的 rg）结果集合与本机一致', async () => {
    expect(await remote.env.hasRipgrep()).toBe(true);
    const cases: Array<Record<string, unknown>> = [
      { pattern: 'TODO' },
      { pattern: 'TODO', output_mode: 'count' },
      { pattern: 'todo', '-i': true, type: 'ts' },
    ];
    for (const input of cases) {
      const l = await runTool(local, 'Grep', input);
      const r = await runTool(remote, 'Grep', input);
      expect({ ...r, content: sorted(r.content) }, JSON.stringify(input)).toEqual({ ...l, content: sorted(l.content) });
    }
  });
});
