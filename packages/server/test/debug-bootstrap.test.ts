// 调试版工作站：默认自动创建调试账号、自动登记本机与演示主机（都在工作站进程内）；
// TANDEM_DEBUG_ACCOUNT=0 模拟发布语义，什么主机都不自动添加。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AccountLoginResult, WorkspaceHostInfo } from '@tandem/protocol';
import { createWorkstation } from '../src/workstation/server.js';
import { IS_DEBUG_FLAVOR } from '../src/flavor.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(fn: () => Promise<T | undefined>, timeout = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('等待超时');
    await sleep(200);
  }
}

function withDebugAccountEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TANDEM_DEBUG_ACCOUNT;
  if (value === undefined) delete process.env.TANDEM_DEBUG_ACCOUNT;
  else process.env.TANDEM_DEBUG_ACCOUNT = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.TANDEM_DEBUG_ACCOUNT;
    else process.env.TANDEM_DEBUG_ACCOUNT = previous;
  });
}

test('调试版：自动添加本机与演示主机，演示工作区可用', async () => {
  if (!IS_DEBUG_FLAVOR) return;
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-dbgdemo-'));
  const workstation = createWorkstation({ home, version: 'test' });
  try {
    await withDebugAccountEnv(undefined, () => workstation.listen(0, '127.0.0.1'));
    const base = `http://127.0.0.1:${(workstation.app.server.address() as { port: number }).port}`;
    const loginRes = await fetch(`${base}/api/debug/auto-login`, { method: 'POST' });
    assert.equal(loginRes.status, 200);
    const login = (await loginRes.json()) as AccountLoginResult;

    const hosts = await waitFor(async () => {
      const res = await fetch(`${base}/api/workstation/hosts`, {
        headers: { authorization: `Bearer ${login.accessToken}` },
      });
      const list = (await res.json()) as WorkspaceHostInfo[];
      return list.length === 2 && list.every((h) => h.online) ? list : undefined;
    });
    const local = hosts.find((h) => h.local);
    const demo = hosts.find((h) => h.demo);
    assert.ok(local, '调试账号应看到本机主机');
    assert.ok(demo, '调试账号应看到演示主机');
    assert.equal(local.id, workstation.localHostId, '本机主机的 hostId 应是本地上下文');
    assert.equal(demo.name, '演示主机');
    assert.equal(local.online, true);
    assert.equal(demo.online, true);
    assert.ok(existsSync(path.join(home, 'local-host', 'sessions')), '本机主机数据在 <工作站>/local-host');
    assert.ok(existsSync(path.join(home, 'demo-host')), '演示主机数据在 <工作站>/demo-host');
    if (process.platform !== 'win32') {
      assert.equal(statSync(path.join(home, 'debug-account.json')).mode & 0o777, 0o600);
    }

    // 演示主机经工作站 /h/<hostId> 访问，演示工作区已创建（内置演示模型/会话/设备）。
    const stateRes = await fetch(`${base}/h/${demo.id}/api/demo`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    const stateText = await stateRes.text();
    assert.equal(stateRes.status, 200, stateText);
    const state = JSON.parse(stateText) as { active?: boolean; profile?: { kind?: string }; scenarios?: unknown[] };
    assert.equal(state.active, true, '演示主机应有已创建的演示工作区');
    assert.equal(state.profile?.kind, 'demo');
    assert.ok((state.scenarios?.length ?? 0) > 0, '演示工作区应有预置场景');
  } finally {
    await workstation.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('TANDEM_DEBUG_ACCOUNT=0：不自动创建账号或主机（模拟发布语义）', async () => {
  if (!IS_DEBUG_FLAVOR) return;
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-dbgplain-'));
  let workstation: ReturnType<typeof createWorkstation> | undefined;
  try {
    await withDebugAccountEnv('0', async () => {
      workstation = createWorkstation({ home, version: 'test' });
      await workstation.listen(0, '127.0.0.1');
    });
    assert.ok(workstation);
    const base = `http://127.0.0.1:${(workstation.app.server.address() as { port: number }).port}`;
    const status = (await (await fetch(`${base}/api/workstation/status`)).json()) as { debug?: boolean; initialized?: boolean };
    assert.equal(status.debug, undefined, '关闭调试账号时状态不带 debug 标记');
    assert.equal(status.initialized, false, '关闭调试账号时不自动初始化工作站');
    const auto = await fetch(`${base}/api/debug/auto-login`, { method: 'POST' });
    assert.equal(auto.status, 404, '关闭调试账号时不应注册 auto-login 路由');
    const setup = await fetch(`${base}/api/workstation/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '普通工作站', username: 'real-admin', password: 'real-pass-123' }),
    });
    assert.equal(setup.status, 200);
    const login = (await setup.json()) as AccountLoginResult;
    const hosts = await fetch(`${base}/api/workstation/hosts`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    }).then((res) => res.json() as Promise<WorkspaceHostInfo[]>);
    assert.deepEqual(hosts, [], '不自动添加任何主机；本机也要显式添加');
    assert.equal(existsSync(path.join(home, 'demo-host')), false, '不应创建演示主机数据');
  } finally {
    await workstation?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
