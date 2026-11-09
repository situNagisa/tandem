// 调试版工作站内置测试账号：密码文件权限、仅回环免密登录、首个真实用户仍是管理员。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkstation } from '../src/workstation/server.js';

test('调试工作站：测试账号、回环免密登录、密码文件 0600、首个真实用户是管理员', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-dbgacct-'));
  const workstation = createWorkstation({ home, version: 'test' });
  try {
    const info = await workstation.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${info.port}`;

    const status = await (await fetch(`${base}/api/workstation/status`)).json();
    assert.equal(status.initialized, true, '调试版工作站应自动初始化');
    assert.equal(status.debug, true, '状态应带调试标记');

    const passwordFile = path.join(home, 'debug-account.json');
    assert.ok(existsSync(passwordFile), '应生成测试账号密码文件');
    if (process.platform !== 'win32') {
      assert.equal(statSync(passwordFile).mode & 0o777, 0o600, '密码文件权限应为 0600');
    }

    const loopback = await fetch(`${base}/api/debug/auto-login`, { method: 'POST' });
    assert.equal(loopback.status, 200, '回环来源应可免密登录');
    const login = (await loopback.json()) as { accessToken: string; account: { username: string; role: string; debug?: boolean } };
    assert.ok(login.accessToken.startsWith('acw_'), '应签发普通会话令牌');
    assert.equal(login.account.username, 'debug');
    assert.equal(login.account.debug, true);
    assert.notEqual(login.account.role, 'admin', '测试账号不是管理员');

    // 非回环来源一律 404（用注入伪造来源地址）。
    for (const address of ['10.9.8.7', '192.168.1.20', '2001:db8::1']) {
      const denied = await workstation.app.inject({
        method: 'POST',
        url: '/api/debug/auto-login',
        remoteAddress: address,
      });
      assert.equal(denied.statusCode, 404, `${address} 不应获得免密登录`);
    }
    // IPv6 回环与 IPv4-mapped 形式仍允许。
    for (const address of ['::1', '::ffff:127.0.0.1']) {
      const allowed = await workstation.app.inject({
        method: 'POST',
        url: '/api/debug/auto-login',
        remoteAddress: address,
      });
      assert.equal(allowed.statusCode, 200, `${address} 应视为回环`);
    }

    // 测试账号不算第一个用户：首个真实注册者仍是管理员。
    const registered = await workstation.app.inject({
      method: 'POST',
      url: '/api/workstation/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'real-owner', password: 'real-owner-pass' }),
    });
    assert.equal(registered.statusCode, 200, registered.body);
    const owner = registered.json() as { account: { role: string } };
    assert.equal(owner.account.role, 'admin');

    const overview = await workstation.app.inject({
      method: 'GET',
      url: '/api/workstation/overview',
      headers: { authorization: `Bearer ${(registered.json() as { accessToken: string }).accessToken}` },
    });
    assert.equal(overview.statusCode, 200);
    const accounts = (overview.json() as { accounts: Array<{ username: string; debug?: boolean }> }).accounts;
    assert.ok(accounts.some((a) => a.username === 'debug' && a.debug), '管理员应看到带调试标记的测试账号');
  } finally {
    await workstation.close();
    rmSync(home, { recursive: true, force: true });
  }
});
