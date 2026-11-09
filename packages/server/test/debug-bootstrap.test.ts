// 调试版工作站自动引导：默认对所有调试 Host 开启、TANDEM_DEBUG_ACCOUNT=0 关闭；
// 演示主机以 demo:true 登记，调试账号能同时看到本机与演示主机。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AccountLoginResult, WorkspaceHostInfo } from '@tandem/protocol';
import { createWorkstation } from '../src/workstation/server.js';
import { IS_DEBUG_FLAVOR } from '../src/flavor.js';
import { debugAutoLoginEnabled } from '../src/debug/workstationBootstrap.js';
import { generateHostKey, identityFromHostKey } from '../src/relay/e2e.js';

function withDebugAccountEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.TANDEM_DEBUG_ACCOUNT;
  if (value === undefined) delete process.env.TANDEM_DEBUG_ACCOUNT;
  else process.env.TANDEM_DEBUG_ACCOUNT = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TANDEM_DEBUG_ACCOUNT;
    else process.env.TANDEM_DEBUG_ACCOUNT = previous;
  }
}

function hostIdentity(): { publicKey: string; fingerprint: string } {
  const identity = identityFromHostKey(generateHostKey());
  return { publicKey: Buffer.from(identity.publicRaw).toString('base64url'), fingerprint: identity.fingerprint };
}

test('调试版自动引导：默认开启（非 Electron 进程），TANDEM_DEBUG_ACCOUNT=0 关闭', () => {
  if (!IS_DEBUG_FLAVOR) return;
  assert.equal(process.versions.electron, undefined, '测试在非 Electron 进程里运行');
  assert.equal(withDebugAccountEnv(undefined, debugAutoLoginEnabled), true, '调试版默认开启');
  assert.equal(withDebugAccountEnv('1', debugAutoLoginEnabled), true, '显式 =1 开启');
  assert.equal(withDebugAccountEnv('0', debugAutoLoginEnabled), false, '=0 关闭');
  assert.equal(withDebugAccountEnv('', debugAutoLoginEnabled), true, '其他值仍开启');
});

test('演示主机：以 demo:true 登记，调试账号同时看到本机与演示主机', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-dbgdemo-'));
  const workstation = createWorkstation({ home, version: 'test' });
  try {
    const info = await workstation.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${info.port}`;
    const loginRes = await fetch(`${base}/api/debug/auto-login`, { method: 'POST' });
    assert.equal(loginRes.status, 200);
    const login = (await loginRes.json()) as AccountLoginResult;

    const hosts = [
      { id: 'local-host-000001', name: '本机', urls: [base], ...hostIdentity() },
      { id: 'demo-host-0000001', name: '演示主机', urls: ['http://127.0.0.1:1'], demo: true, ...hostIdentity() },
    ];
    for (const host of hosts) {
      const res = await workstation.app.inject({
        method: 'POST',
        url: '/api/workstation/hosts/register',
        headers: { authorization: `Bearer ${login.accessToken}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ host }),
      });
      assert.equal(res.statusCode, 200, res.body);
    }

    const visible = workstation.store.visibleHostsForAccount(login.account.id);
    assert.equal(visible.length, 2, '调试账号应看到两台主机');
    const local = visible.find((h) => h.id === hosts[0]!.id);
    const demo = visible.find((h) => h.id === hosts[1]!.id);
    assert.ok(local, '应包含本机');
    assert.ok(demo, '应包含演示主机');
    assert.equal(local.demo, undefined, '本机不是演示主机');
    assert.equal(demo.demo, true, '演示主机应带 demo 标记');

    // 客户端可见列表（GET /api/workstation/hosts）同样带 demo 字段。
    const listed = await workstation.app.inject({
      method: 'GET',
      url: '/api/workstation/hosts',
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    const list = listed.json() as WorkspaceHostInfo[];
    assert.equal(list.length, 2);
    assert.deepEqual(
      list.filter((h) => h.demo).map((h) => h.name),
      ['演示主机'],
      '只有演示主机带 demo 标记',
    );
  } finally {
    await workstation.close();
    rmSync(home, { recursive: true, force: true });
  }
});
