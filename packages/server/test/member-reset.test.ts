// 数据目录根 accounts.json 是旧 Host 的成员文件（不是工作站）时，工作站首次启动按全新工作站初始化，
// 原文件备份为 accounts.json.old-host，不报「本机还不是账号中心」。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AccountLoginResult } from '@tandem/protocol';
import { createWorkstation } from '../src/workstation/server.js';
import { IS_DEBUG_FLAVOR } from '../src/flavor.js';

function seedMemberFile(home: string): void {
  writeFileSync(
    path.join(home, 'accounts.json'),
    JSON.stringify({
      mode: 'member',
      version: 1,
      modelVersion: 2,
      workspace: { id: 'ws-remote', name: '远程工作站', createdAt: 1, centerHostId: 'ws-remote' },
      centerUrl: 'http://127.0.0.1:1',
      centerPublicKey: '',
      syncToken: '',
      hosts: [],
      revoked: {},
      invalidBefore: {},
      snapshotVersion: 1,
      joinedAt: 1,
    }),
  );
}

async function withDebugAccountEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TANDEM_DEBUG_ACCOUNT;
  if (value === undefined) delete process.env.TANDEM_DEBUG_ACCOUNT;
  else process.env.TANDEM_DEBUG_ACCOUNT = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.TANDEM_DEBUG_ACCOUNT;
    else process.env.TANDEM_DEBUG_ACCOUNT = previous;
  });
}

test('根目录是旧主机的成员文件：调试版按全新工作站初始化并自动进入', async () => {
  if (!IS_DEBUG_FLAVOR) return;
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-member-reset-'));
  let workstation: ReturnType<typeof createWorkstation> | undefined;
  try {
    seedMemberFile(home);
    await withDebugAccountEnv(undefined, async () => {
      workstation = createWorkstation({ home, version: 'test' });
      await workstation.listen(0, '127.0.0.1');
    });
    assert.ok(workstation);
    assert.equal(workstation.store.mode(), 'center', '应按全新工作站初始化');
    const base = `http://127.0.0.1:${(workstation.app.server.address() as { port: number }).port}`;
    const auto = await fetch(`${base}/api/debug/auto-login`, { method: 'POST' });
    assert.equal(auto.status, 200, '调试版应能自动登录并进入工作台');
    assert.ok((await auto.json() as AccountLoginResult).accessToken);
    const status = (await (await fetch(`${base}/api/workstation/status`)).json()) as { initialized?: boolean };
    assert.equal(status.initialized, true);
    assert.ok(existsSync(path.join(home, 'accounts.json.old-host')), '旧成员文件应备份为 .old-host');
    const saved = JSON.parse(readFileSync(path.join(home, 'accounts.json'), 'utf8')) as { mode: string };
    assert.equal(saved.mode, 'center', 'accounts.json 应换成工作站文件');
  } finally {
    await workstation?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('根目录是旧主机的成员文件：发布语义下 setup 不报错，可创建管理员', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-member-setup-'));
  let workstation: ReturnType<typeof createWorkstation> | undefined;
  try {
    seedMemberFile(home);
    await withDebugAccountEnv('0', async () => {
      workstation = createWorkstation({ home, version: 'test' });
      await workstation.listen(0, '127.0.0.1');
    });
    assert.ok(workstation);
    // 启动时不动数据目录，等用户在 setup 页创建管理员；setup 时把旧成员文件备份后按全新工作站初始化。
    assert.equal(workstation.store.mode(), 'member');
    const setup = await workstation.app.inject({
      method: 'POST',
      url: '/api/workstation/setup',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: '新工作站', username: 'admin-user', password: 'admin-pass-1' }),
    });
    assert.equal(setup.statusCode, 200, setup.body);
    assert.equal(workstation.store.mode(), 'center');
    assert.ok(existsSync(path.join(home, 'accounts.json.old-host')), '旧成员文件应备份为 .old-host');
  } finally {
    await workstation?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
