// C 组：其他 M1 验收项（C15–C21）。C15–C19 共用一个执行器；C20、C21 各自独立进程。
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sha256Hex } from './protocol.js';
import {
  createSandbox,
  forEachTarget,
  hasher,
  HEARTBEAT_MS,
  MIB,
  okOrThrow,
  remoteRead,
  remoteWrite,
  runCleanups,
  sleep,
  startExecutor,
  startSampler,
  text,
  waitUntil,
  Workstation,
  type Conn,
  type Sandbox,
  type Target,
} from './harness.js';

// 大文件默认大小（Linux 上 1 GiB 实测写+读约 11 秒，取 1 GiB）。TANDEM_EXEC_BIG_MB 可覆盖。
const DEFAULT_BIG_MB: Record<Target, number> = { linux: 1024, windows: 256 };
const CHUNK = 64 * 1024;

forEachTarget('C M1 验收项', (target: Target) => {
  const linux = target === 'linux';
  const pl = linux ? path.posix : path.win32;
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

  test('C15 [both] fs.mkdir（recursive 与 EEXIST）、fs.rename（overwrite 与 EEXIST）、fs.remove（递归；根目录 EINVAL）', async () => {
    const base = sb.nat('c15');
    okOrThrow(await conn.request('fs.mkdir', { path: base, recursive: true }));
    okOrThrow(await conn.request('fs.mkdir', { path: pl.join(base, 'a') }));
    const dup = await conn.request('fs.mkdir', { path: pl.join(base, 'a') });
    expect(dup.error?.code).toBe('EEXIST');
    okOrThrow(await conn.request('fs.mkdir', { path: pl.join(base, 'a'), recursive: true }));
    okOrThrow(await conn.request('fs.mkdir', { path: pl.join(base, 'x', 'y', 'z'), recursive: true }));
    expect(okOrThrow(await conn.request('fs.stat', { path: pl.join(base, 'x', 'y', 'z') })).end.type).toBe('dir');

    const f1 = pl.join(base, 'f1');
    const f2 = pl.join(base, 'f2');
    const f3 = pl.join(base, 'f3');
    await remoteWrite(conn, f1, 'one');
    okOrThrow(await conn.request('fs.rename', { from: f1, to: f2 }));
    await remoteWrite(conn, f3, 'three');
    const clash = await conn.request('fs.rename', { from: f2, to: f3 });
    expect(clash.error?.code).toBe('EEXIST');
    okOrThrow(await conn.request('fs.rename', { from: f2, to: f3, overwrite: true }));
    expect(text((await remoteRead(conn, f3)).data)).toBe('one');
    expect((await conn.request('fs.stat', { path: f2 })).error?.code).toBe('ENOENT');

    okOrThrow(await conn.request('fs.remove', { path: pl.join(base, 'x'), recursive: true }));
    expect((await conn.request('fs.stat', { path: pl.join(base, 'x') })).error?.code).toBe('ENOENT');

    // 根目录只做非递归删除：根非空，正确实现必须在检查阶段返回 EINVAL；若实现错误，也不会误删整个文件系统。
    const root = pl.parse(sb.root).root;
    const rootRm = await conn.request('fs.remove', { path: root });
    expect(rootRm.error?.code).toBe('EINVAL');
  }, 60_000);

  test('C16 [both] 未知 op → EUNSUPPORTED，同一连接之后的请求仍然正常', async () => {
    const r = await conn.request('fs.bogus', { path: sb.root });
    expect(r.error?.code).toBe('EUNSUPPORTED');
    const info = okOrThrow(await conn.request('sys.info')).end;
    expect(info.protocol).toBe(1);
  }, 30_000);

  test('C17 [both] 写入中途 CANCEL：目标保持旧内容，临时文件被删除，END error ECANCELED', async () => {
    const dir = sb.nat('c17');
    const file = pl.join(dir, 'target.bin');
    await remoteWrite(conn, file, 'OLD-CONTENT');

    const h = conn.start('fs.write', { path: file, mkdirp: true });
    await h.sendData(Buffer.alloc(300 * 1024, 0x41));
    h.cancel();
    const r = await h.done;
    expect(r.error?.code).toBe('ECANCELED');

    expect((await remoteRead(conn, file)).data.toString('utf8')).toBe('OLD-CONTENT');
    const names = okOrThrow(await conn.request('fs.list', { path: dir })).end.entries.map(
      (e: { name: string }) => e.name,
    );
    expect(names).toEqual(['target.bin']);
  }, 60_000);

  test('C18 [both] 32 并发 exec.shell 全部正确完成，第 33 个排队后也完成', async () => {
    const cmdFor = (i: number) => (linux ? `sleep 1; echo job-${i}` : `ping -n 2 127.0.0.1 >nul & echo job-${i}`);
    const running = Array.from({ length: 32 }, (_, i) =>
      conn.request('exec.shell', { command: cmdFor(i), cwd: sb.root, timeoutMs: 60_000 }),
    );
    const queued = conn.request('exec.shell', { command: cmdFor(32), cwd: sb.root, timeoutMs: 60_000 });
    const results = (await Promise.all([...running, queued])).map((r) => okOrThrow(r));
    results.forEach((r, i) => {
      expect(r.end.exit).toBe(0);
      expect(text(r.stdout)).toBe(`job-${i}`);
    });
  }, 120_000);

  test('C19 [both] 流控：暂停回 FLOW 时服务端收到的 OUT 不超过 1 MiB 窗口加一帧，恢复后数据完整', async () => {
    const size = 4 * MIB;
    const file = sb.nat('c19', 'four-mib.txt');
    await remoteWrite(conn, file, Buffer.alloc(size, 0x61));

    conn.pauseFlow();
    const h = conn.start(
      'exec.shell',
      { command: linux ? `cat '${file}'` : `type "${file}"`, cwd: sb.root },
      { timeoutMs: 120_000 },
    );
    await sleep(2000);
    const during = h.stats().outBytes;
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThanOrEqual(MIB + CHUNK);

    conn.resumeFlow();
    const r = okOrThrow(await h.done);
    expect(r.end.exit).toBe(0);
    expect(r.stdout.length).toBe(size);
    expect(sha256Hex(r.stdout)).toBe(sha256Hex(Buffer.alloc(size, 0x61)));
  }, 120_000);

  test('C20 [both] 大文件：fs.write 后分块 fs.read 比对 sha256；heapInuse < 64 MiB，Linux VmHWM < 128 MiB', async () => {
    const mb = Number(process.env.TANDEM_EXEC_BIG_MB ?? DEFAULT_BIG_MB[target]);
    const size = mb * MIB;
    const bigSb = createSandbox(target);
    const proc = startExecutor({ target, sandbox: bigSb, home: bigSb.home('home'), server: ws.url, token: ws.issueToken() });
    const big = await ws.waitReady({ timeoutMs: 20_000 });
    const file = bigSb.nat('big', 'blob.bin');

    const wHash = hasher();
    async function* source(): AsyncGenerator<Buffer> {
      for (let left = size; left > 0; ) {
        const n = Math.min(CHUNK, left);
        const c = randomBytes(n);
        wHash.update(c);
        left -= n;
        yield c;
      }
    }

    const sampler = startSampler(big);
    const tw = Date.now();
    const w = big.start('fs.write', { path: file, mkdirp: true }, { timeoutMs: 15 * 60_000 });
    await w.sendBody(source());
    const wr = okOrThrow(await w.done);
    const writeMs = Date.now() - tw;
    expect(wr.end.size).toBe(size);
    const expected = wHash.hex();

    const rHash = hasher();
    const READ_CHUNK = 16 * MIB;
    const tr = Date.now();
    for (let off = 0; off < size; off += READ_CHUNK) {
      const len = Math.min(READ_CHUNK, size - off);
      const r = okOrThrow(
        await big.request(
          'fs.read',
          { path: file, offset: off, length: len },
          { collect: false, onData: (c) => rHash.update(c), timeoutMs: 5 * 60_000 },
        ),
      );
      expect(r.end.bytes).toBe(len);
    }
    const readMs = Date.now() - tr;
    const peak = await sampler.stop();
    const rssKb = proc.peakRssKb();
    await proc.stop();

    console.info(
      `[C20 ${target}] 大小 ${mb} MiB，写入 ${writeMs}ms，读回 ${readMs}ms，heapInuse 峰值 ${(peak.max / MIB).toFixed(1)} MiB（${peak.samples} 次采样），VmHWM ${rssKb === undefined ? '不可用' : `${(rssKb / 1024).toFixed(1)} MiB`}`,
    );
    expect(rHash.hex()).toBe(expected);
    expect(peak.samples).toBeGreaterThan(0);
    expect(peak.max).toBeLessThan(64 * MIB);
    if (linux) {
      expect(rssKb).toBeDefined();
      expect(rssKb! * 1024).toBeLessThan(128 * MIB);
    }
  }, 15 * 60_000);

  test('C21 [both] 长连接心跳：服务端每 15 秒发 PING，执行器回 PONG', async () => {
    const hbSb = createSandbox(target);
    startExecutor({ target, sandbox: hbSb, home: hbSb.home('home'), server: ws.url, token: ws.issueToken() });
    const hb = await ws.waitReady({ timeoutMs: 20_000 });
    await waitUntil(() => hb.pongs > 0, HEARTBEAT_MS + 10_000, 'PONG');
    expect(hb.pingTimes.length).toBeGreaterThan(0);
    const firstPingAfter = hb.pingTimes[0] - hb.readyAt;
    expect(firstPingAfter).toBeGreaterThanOrEqual(HEARTBEAT_MS - 1000);
    expect(firstPingAfter).toBeLessThanOrEqual(HEARTBEAT_MS + 2000);
  }, 60_000);
});
