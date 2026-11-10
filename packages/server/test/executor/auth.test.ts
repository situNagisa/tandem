// A 组：认证与登记（A1–A7）。
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import * as P from './protocol.js';
import { fakeHandshake } from './fake-exec.js';
import {
  createSandbox,
  dropAndRejoin,
  forEachTarget,
  runCleanups,
  sleep,
  startExecutor,
  waitUntil,
  Workstation,
} from './harness.js';

afterEach(runCleanups);

forEachTarget('A 认证与登记', (target) => {
  test('A1 [both] 首次登记：分配 hostId、写入身份文件、收到 AUTH_OK', async () => {
    const ws = await Workstation.start();
    const sb = createSandbox(target);
    const home = sb.home('home');
    startExecutor({ target, sandbox: sb, home, server: ws.url, token: ws.issueToken() });
    const conn = await ws.waitReady({ timeoutMs: 20_000 });
    expect(conn.hostId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);

    const identity = path.join(home.local, 'identity.json');
    await waitUntil(() => existsSync(identity), 5000, 'identity.json 写入');
    expect(JSON.parse(readFileSync(identity, 'utf8')).hostId).toBe(conn.hostId);
    if (target === 'linux') expect(statSync(identity).mode & 0o777).toBe(0o600);

    const info = await conn.request('sys.info');
    expect(info.error).toBeUndefined();
  }, 60_000);

  test('A2 [both] 令牌一次性：第二次登记被拒，第二个执行器拿不到 hostId', async () => {
    const ws = await Workstation.start();
    const sb = createSandbox(target);
    const token = ws.issueToken();
    startExecutor({ target, sandbox: sb, home: sb.home('h1'), server: ws.url, token });
    await ws.waitReady({ timeoutMs: 20_000 });
    const readyBefore = ws.readyLog.length;
    const h2 = sb.home('h2');
    startExecutor({ target, sandbox: sb, home: h2, server: ws.url, token });

    await waitUntil(() => ws.rejects.some((r) => r.reason === 'token-used'), 20_000, '第二次登记被拒');
    expect(ws.readyLog.length).toBe(readyBefore);
    expect(ws.hosts.size).toBe(1);
    expect(existsSync(path.join(h2.local, 'identity.json'))).toBe(false);
  }, 60_000);

  test('A3 [both] 工作站公钥与令牌指纹不符：执行器不发 AUTH、不登记', async () => {
    const keyA = P.genKeyPair('ed25519');
    const keyB = P.genKeyPair('ed25519');
    const ws = await Workstation.start({ identity: keyB });
    const sb = createSandbox(target);
    startExecutor({
      target,
      sandbox: sb,
      home: sb.home('home'),
      server: ws.url,
      token: ws.issueToken({ fpOf: keyA.pub }),
    });
    await waitUntil(() => ws.welcomes.length > 0, 20_000, '执行器收到 WELCOME');
    await sleep(3000);
    expect(ws.authFrames).toBe(0);
    expect(ws.readyLog.length).toBe(0);
    expect(ws.hosts.size).toBe(0);
  }, 60_000);

  test('A4 [both] 伪造执行器签名：服务端断开且不发 AUTH_OK', async () => {
    const ws = await Workstation.start();
    const exec = P.genKeyPair('ed25519');
    const attacker = P.genKeyPair('ed25519');

    // 正向对照：同一个伪造客户端用正确私钥必须能完成登记，否则下面的负面结果不可信。
    const control = await fakeHandshake({
      url: ws.wsUrl,
      token: ws.issueToken(),
      execPub: exec.pub,
      signWith: exec.priv,
      expectWsPub: ws.identity.pub,
    });
    expect(control.outcome).toBe('auth_ok');

    const forged = await fakeHandshake({
      url: ws.wsUrl,
      token: ws.issueToken(),
      execPub: exec.pub,
      signWith: attacker.priv,
      expectWsPub: ws.identity.pub,
    });
    expect(forged.welcome).toBeDefined();
    expect(forged.outcome).toBe('closed');
    expect(ws.rejects.some((r) => r.reason === 'AUTH 签名无效')).toBe(true);
    expect(ws.hosts.size).toBe(1);
  }, 30_000);

  test('A5 [both] 重放握手被拒，重放旧 WELCOME 时真实执行器不发 AUTH', async () => {
    const ws = await Workstation.start();
    const dev = P.genKeyPair('ed25519');
    const enrolled = await fakeHandshake({
      url: ws.wsUrl,
      token: ws.issueToken(),
      execPub: dev.pub,
      signWith: dev.priv,
      expectWsPub: ws.identity.pub,
    });
    expect(enrolled.outcome).toBe('auth_ok');
    const reconnect = await fakeHandshake({
      url: ws.wsUrl,
      hostId: enrolled.hostId,
      execPub: dev.pub,
      signWith: dev.priv,
      expectWsPub: ws.identity.pub,
    });
    expect(reconnect.outcome).toBe('auth_ok');

    const replayReconnect = await fakeHandshake({
      url: ws.wsUrl,
      replay: { hello: reconnect.hello!, auth: reconnect.auth! },
    });
    expect(replayReconnect.outcome).toBe('closed');

    const replayEnroll = await fakeHandshake({
      url: ws.wsUrl,
      replay: { hello: enrolled.hello!, auth: enrolled.auth! },
    });
    expect(replayEnroll.outcome).toBe('closed');
    expect(ws.hosts.size).toBe(1);

    // 旧 WELCOME 重放：先让真实执行器完成一次重连，取得它的 WELCOME，再在下一次握手中原样回放。
    const sb = createSandbox(target);
    const since = ws.readyLog.length;
    startExecutor({
      target,
      sandbox: sb,
      home: sb.home('home'),
      server: ws.url,
      token: ws.issueToken(),
    });
    const c1 = await ws.waitReady({ since, timeoutMs: 20_000 });
    const c2 = await dropAndRejoin(ws, c1);
    ws.welcomeReplay = c2.welcome!;
    const welcomesBefore = ws.welcomes.length;
    const authBefore = ws.authFrames;
    const readyBefore = ws.readyLog.length;
    c2.terminate();
    await sleep(4000);
    expect(ws.welcomes.length).toBeGreaterThan(welcomesBefore);
    expect(ws.authFrames).toBe(authBefore);
    expect(ws.readyLog.length).toBe(readyBefore);

    ws.welcomeReplay = null;
    const c3 = await ws.waitReady({ hostId: c1.hostId, since: readyBefore, timeoutMs: 40_000 });
    expect(c3.hostId).toBe(c1.hostId);
  }, 120_000);

  test('A6 [both] 篡改密文后执行器断开，随后用同一 hostId 重新认证', async () => {
    const ws = await Workstation.start();
    const sb = createSandbox(target);
    startExecutor({ target, sandbox: sb, home: sb.home('home'), server: ws.url, token: ws.issueToken() });
    const c1 = await ws.waitReady({ timeoutMs: 20_000 });
    const since = ws.readyLog.length;

    c1.tamperNext();
    const failed = c1.request('sys.info', {}, { timeoutMs: 15_000 }).catch((err: unknown) => err);
    await waitUntil(() => !c1.isOpen, 10_000, '服务端观察到连接关闭');
    expect(await failed).toBeInstanceOf(Error);

    const c2 = await ws.waitReady({ hostId: c1.hostId, since, timeoutMs: 20_000 });
    expect(c2.hostId).toBe(c1.hostId);
    const info = await c2.request('sys.info');
    expect(info.error).toBeUndefined();
  }, 90_000);

  test('A7 [both] 断线重连：约 1–3 秒内以同一 hostId 重新认证，之后 exec 可用', async () => {
    const ws = await Workstation.start();
    const sb = createSandbox(target);
    startExecutor({ target, sandbox: sb, home: sb.home('home'), server: ws.url, token: ws.issueToken() });
    const c1 = await ws.waitReady({ timeoutMs: 20_000 });

    const t0 = Date.now();
    const c2 = await dropAndRejoin(ws, c1);
    const tookMs = Date.now() - t0;
    expect(c2.hostId).toBe(c1.hostId);
    expect(tookMs).toBeLessThan(4000);

    const info = await c2.request('sys.info');
    expect(info.error).toBeUndefined();
  }, 60_000);
});
