// B 组：原型 14 项（B0 为 --version 互操作冒烟）。一个 target 共用一个已登记的执行器，B13 最后做重连。
import { existsSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sha256Hex } from './protocol.js';
import {
  createSandbox,
  dropAndRejoin,
  forEachTarget,
  isAlive,
  okOrThrow,
  remoteRead,
  remoteWrite,
  runCleanups,
  sleep,
  spawnExecutor,
  startExecutor,
  text,
  waitUntil,
  Workstation,
  type Conn,
  type Sandbox,
  type Target,
} from './harness.js';

const MIB = 1024 * 1024;

forEachTarget('B 原型 14 项', (target: Target) => {
  const linux = target === 'linux';
  let ws: Workstation;
  let sb: Sandbox;
  let conn: Conn;

  beforeAll(async () => {
    ws = await Workstation.start();
    sb = createSandbox(target);
    startExecutor({ target, sandbox: sb, home: sb.home('home'), server: ws.url, token: ws.issueToken() });
    conn = await ws.waitReady({ timeoutMs: 20_000 });
  }, 60_000);

  afterAll(runCleanups);

  test('B0 [both] tandem-exec --version 可运行（互操作冒烟）', async () => {
    const proc = spawnExecutor({ target, sandbox: sb, home: sb.home('version') }, ['--version']);
    await waitUntil(() => proc.exited, 15_000, '--version 退出');
    expect(proc.exitCode).toBe(0);
    expect(proc.output().trim()).not.toBe('');
  }, 30_000);

  test('B1 [both] HELLO 平台与版本：sys.info 返回 os、protocol=1、version', async () => {
    const info = okOrThrow(await conn.request('sys.info')).end;
    expect(info.os).toBe(linux ? 'linux' : 'windows');
    expect(typeof info.arch).toBe('string');
    expect(info.arch.length).toBeGreaterThan(0);
    expect(info.protocol).toBe(1);
    expect(typeof info.version).toBe('string');
    expect(typeof info.heapInuse).toBe('number');
  }, 30_000);

  test('B2 [both] exec 基本输出，且工作目录为 cwd', async () => {
    const r = okOrThrow(
      await conn.request('exec.shell', { command: linux ? 'echo hello && pwd -P' : 'echo hello & cd', cwd: sb.root }),
    );
    expect(r.end.exit).toBe(0);
    const lines = text(r.stdout)
      .split(/\r?\n/)
      .map((l) => l.trim());
    expect(lines[0]).toBe('hello');
    expect(lines[1]).toBe(linux ? realpathSync(sb.local) : sb.root);
  }, 30_000);

  test('B3 [both] 退出码、stderr 与 stdout 分离、UTF-8 中文输出', async () => {
    const command = linux ? 'echo 你好; echo oops 1>&2; exit 3' : 'echo 你好 & echo oops 1>&2 & exit /b 3';
    const r = okOrThrow(await conn.request('exec.shell', { command, cwd: sb.root }));
    expect(r.end.exit).toBe(3);
    expect(r.stdout.toString('utf8')).toContain('你好');
    expect(r.stdout.toString('utf8')).not.toContain('oops');
    expect(r.stderr.toString('utf8')).toContain('oops');
    expect(r.stderr.toString('utf8')).not.toContain('你好');
  }, 30_000);

  test('B4 [both] cwd 不存在 → END error ENOENT', async () => {
    const r = await conn.request('exec.shell', { command: 'echo should-not-run', cwd: sb.nat('no-such-dir') });
    expect(r.error?.code).toBe('ENOENT');
    expect(r.stdout.length).toBe(0);
  }, 30_000);

  test('B5 [both] 命令不存在 → 非零退出且 stderr 非空', async () => {
    const r = okOrThrow(await conn.request('exec.shell', { command: 'definitely-not-a-command-xyz', cwd: sb.root }));
    expect(r.end.exit).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  }, 30_000);

  test('B6 [both] fs.write 1 MiB 随机二进制（含子目录）后 fs.read 回读 sha256 一致', async () => {
    const data = randomBytes(MIB);
    const file = sb.nat('deep', 'sub', 'blob.bin');
    const w = await remoteWrite(conn, file, data);
    expect(w.end.size).toBe(MIB);

    const r = await remoteRead(conn, file);
    expect(sha256Hex(r.data)).toBe(sha256Hex(data));
    expect(r.end.size).toBe(MIB);
    expect(r.end.bytes).toBe(MIB);
    expect(r.end.eof).toBe(true);
    if (linux) expect(sha256Hex(readFileSync(sb.loc('deep', 'sub', 'blob.bin')))).toBe(sha256Hex(data));
  }, 60_000);

  test('B7 [both] fs.stat：文件、目录；Linux 上符号链接跟随', async () => {
    const file = sb.nat('deep', 'sub', 'blob.bin');
    const f = okOrThrow(await conn.request('fs.stat', { path: file })).end;
    expect(f).toMatchObject({ type: 'file', size: MIB, symlink: false });
    expect(typeof f.mtimeMs).toBe('number');

    const d = okOrThrow(await conn.request('fs.stat', { path: sb.nat('deep') })).end;
    expect(d).toMatchObject({ type: 'dir', symlink: false });

    if (linux) {
      symlinkSync(sb.loc('deep', 'sub', 'blob.bin'), sb.loc('deep', 'link.bin'));
      const l = okOrThrow(await conn.request('fs.stat', { path: sb.nat('deep', 'link.bin') })).end;
      expect(l).toMatchObject({ type: 'file', size: MIB, symlink: true });
    }
  }, 30_000);

  test('B8 [both] fs.list 按 name 排序，limit 生效', async () => {
    await remoteWrite(conn, sb.nat('list', 'b.txt'), 'bbb');
    await remoteWrite(conn, sb.nat('list', 'a.txt'), 'aa');
    await remoteWrite(conn, sb.nat('list', 'c-dir', 'x.txt'), 'x');

    const l = okOrThrow(await conn.request('fs.list', { path: sb.nat('list') })).end;
    expect(l.entries.map((e: { name: string }) => e.name)).toEqual(['a.txt', 'b.txt', 'c-dir']);
    expect(l.entries.map((e: { type: string }) => e.type)).toEqual(['file', 'file', 'dir']);
    expect(l.entries[0].size).toBe(2);
    expect(l.truncated).toBe(false);

    const limited = okOrThrow(await conn.request('fs.list', { path: sb.nat('list'), limit: 2 })).end;
    expect(limited.entries).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  }, 30_000);

  test('B9 [both] fs.read 不存在的文件 → ENOENT', async () => {
    const r = await conn.request('fs.read', { path: sb.nat('no-such-file.bin') });
    expect(r.error?.code).toBe('ENOENT');
  }, 30_000);

  test('B10 [both] 并发：慢命令运行中，快命令 1 秒内返回', async () => {
    const slowCommand = linux ? 'sleep 3; echo slow-done' : 'ping -n 4 127.0.0.1 >nul & echo slow-done';
    let slowDone = false;
    const slow = conn.request('exec.shell', { command: slowCommand, cwd: sb.root, timeoutMs: 30_000 });
    slow.then(() => {
      slowDone = true;
    });
    await sleep(300);

    const quick = okOrThrow(await conn.request('exec.shell', { command: 'echo quick', cwd: sb.root }));
    expect(quick.end.exit).toBe(0);
    expect(text(quick.stdout)).toBe('quick');
    expect(quick.elapsedMs).toBeLessThan(1000);
    expect(slowDone).toBe(false);

    const s = okOrThrow(await slow);
    expect(s.end.exit).toBe(0);
    expect(text(s.stdout)).toBe('slow-done');
  }, 60_000);

  test('B11 [both] 约 1 MB 文本输出完整回传', async () => {
    const body = Buffer.from(`${'x'.repeat(999_999)}\n`, 'utf8');
    const file = sb.nat('big-text.txt');
    await remoteWrite(conn, file, body);
    const r = okOrThrow(
      await conn.request('exec.shell', {
        command: linux ? `cat '${file}'` : `type "${file}"`,
        cwd: sb.root,
        timeoutMs: 60_000,
      }),
    );
    expect(r.end.exit).toBe(0);
    expect(r.stdout.length).toBe(body.length);
    expect(sha256Hex(r.stdout)).toBe(sha256Hex(body));
  }, 90_000);

  test('B12 [both] cancel：长命令中途取消，END 在 2 秒内到达且 canceled=true', async () => {
    if (linux) {
      const pidFile = sb.loc('cancel.pid');
      const h = conn.start(
        'exec.shell',
        { command: `sh -c 'sleep 60 & echo $! > ${sb.nat('cancel.pid')}; wait'`, cwd: sb.root },
        { timeoutMs: 60_000 },
      );
      const pid = Number(
        await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim(), 10_000, '孙进程 pid 文件'),
      );
      const t0 = Date.now();
      h.cancel();
      const r = okOrThrow(await h.done);
      const ms = Date.now() - t0;
      expect(r.end.canceled).toBe(true);
      expect(ms).toBeLessThan(2000);
      await waitUntil(() => !isAlive(pid), 3000, `孙进程 ${pid} 被杀掉`);
    } else {
      const h = conn.start('exec.shell', { command: 'ping -n 60 127.0.0.1 >nul', cwd: sb.root }, { timeoutMs: 90_000 });
      await sleep(1500);
      const t0 = Date.now();
      h.cancel();
      const r = okOrThrow(await h.done);
      const ms = Date.now() - t0;
      expect(r.end.canceled).toBe(true);
      expect(ms).toBeLessThan(2000);
    }
  }, 60_000);

  test('B14 [both] fs.write 的 expectMtime 冲突 → ECONFLICT，目标不变、无残留临时文件', async () => {
    const file = sb.nat('cfg', 'app.txt');
    await remoteWrite(conn, file, 'version-1');
    const mtime = okOrThrow(await conn.request('fs.stat', { path: file })).end.mtimeMs as number;

    const h = conn.start('fs.write', { path: file, expectMtime: mtime - 60_000 });
    await h.sendBody(Buffer.from('version-2'));
    const conflict = await h.done;
    expect(conflict.error?.code).toBe('ECONFLICT');

    expect(text((await remoteRead(conn, file)).data)).toBe('version-1');
    const names = okOrThrow(await conn.request('fs.list', { path: sb.nat('cfg') })).end.entries.map(
      (e: { name: string }) => e.name,
    );
    expect(names).toEqual(['app.txt']);

    await remoteWrite(conn, file, 'version-3');
    expect(text((await remoteRead(conn, file)).data)).toBe('version-3');
  }, 60_000);

  test('B13 [both] 断线重连：同一 hostId 重新认证，之后 exec 可用', async () => {
    const t0 = Date.now();
    conn = await dropAndRejoin(ws, conn);
    expect(Date.now() - t0).toBeLessThan(4000);
    const info = okOrThrow(await conn.request('sys.info')).end;
    expect(info.protocol).toBe(1);
  }, 60_000);
});
