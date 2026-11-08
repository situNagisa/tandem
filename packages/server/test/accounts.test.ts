// 账号制工作区：密码登录、令牌本地验签、角色范围、吊销与快照防重放。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountsStore } from '../src/accounts/store.js';

function temp() {
  return mkdtempSync(path.join(os.tmpdir(), 'tandem-accounts-'));
}

test('账号中心：登录、范围、吊销、刷新轮换、快照防重放', () => {
  const home = temp();
  const memberHome = temp();
  try {
    const center = new AccountsStore({ home, hostId: 'h1', hostName: 'h1' });
    center.setup('测试工作区', 'owner1', 'owner-pass-1', ['http://127.0.0.1:1'], 'h1');
    const ownerLogin = center.login({ username: 'owner1', password: 'owner-pass-1' });
    assert.equal(center.authenticate(ownerLogin.accessToken)?.accountRole, 'owner');
    assert.throws(() => center.login({ username: 'owner1', password: 'wrong-pass' }), /用户名或密码错误/);

    const collab = center.createAccount({
      username: 'chen1',
      password: 'chen-pass-1',
      role: 'collaborator',
      scope: 'hosts',
      hostIds: ['h1'],
    });
    const collabLogin = center.login({ username: 'chen1', password: 'chen-pass-1' });
    assert.equal(center.authenticate(collabLogin.accessToken)?.role, 'collaborator');
    assert.equal(center.authenticate(collabLogin.accessToken)?.allProjects, true);

    const outside = center.createAccount({
      username: 'out1',
      password: 'out-pass-1',
      role: 'collaborator',
      scope: 'hosts',
      hostIds: ['h2'],
    });
    const outsideLogin = center.login({ username: 'out1', password: 'out-pass-1' });
    assert.equal(center.authenticate(outsideLogin.accessToken), undefined, '范围外主机应拒绝');
    assert.equal(outside.role, 'collaborator');

    const beforeRevoke = center.signedSnapshot();
    center.revokeAccount(collab.id, 'test');
    assert.equal(center.authenticate(collabLogin.accessToken), undefined, '吊销后旧访问令牌立即失效');

    const rotated = center.refresh(ownerLogin.refreshToken);
    assert.ok(rotated.accessToken.startsWith('acw_'));
    assert.throws(() => center.refresh(ownerLogin.refreshToken), /刷新令牌已使用/, '刷新令牌只能使用一次');

    const centerFile = JSON.parse(readFileSync(path.join(home, 'accounts.json'), 'utf8')) as {
      workspace: unknown;
      publicKey: string;
      snapshotVersion: number;
    };
    writeFileSync(
      path.join(memberHome, 'accounts.json'),
      JSON.stringify({
        mode: 'member',
        version: 1,
        workspace: centerFile.workspace,
        centerUrl: 'http://127.0.0.1:1',
        centerPublicKey: centerFile.publicKey,
        hosts: [],
        revoked: {},
        invalidBefore: {},
        snapshotVersion: 0,
        joinedAt: Date.now(),
      }),
    );
    const member = new AccountsStore({ home: memberHome, hostId: 'h2', hostName: 'h2' });
    assert.equal(member.applySignedSnapshot(beforeRevoke), true, '中心签名快照应可应用');
    const latest = center.signedSnapshot();
    assert.equal(member.applySignedSnapshot(latest), true, '新版本快照应可应用');
    assert.equal(member.applySignedSnapshot(beforeRevoke), false, '旧快照重放应被拒绝');
    assert.equal(member.isRevoked(collab.id), true, '吊销列表应同步到加入方');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(memberHome, { recursive: true, force: true });
  }
});
