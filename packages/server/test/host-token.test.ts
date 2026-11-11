// 主机绑定码（一次性注册令牌）：15 分钟有效、一次性、只存哈希；
// 兑换后主机本地持有长期凭据（Ed25519 hostKey，member 文件 0600）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountsStore, HOST_BIND_TTL_MS } from '../src/accounts/store.js';
import { createWorkstation } from '../src/workstation/server.js';

// 用发布语义（关掉调试账号自动初始化），测试自己创建管理员。
process.env.TANDEM_DEBUG_ACCOUNT = '0';

function temp() {
  return mkdtempSync(path.join(os.tmpdir(), 'tandem-host-token-'));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function post(base: string, pathname: string, body: unknown, token?: string): Promise<Response> {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

test('主机绑定码：一次性、15 分钟、只存哈希、成员私钥 0600', async () => {
  assert.equal(HOST_BIND_TTL_MS, 15 * 60 * 1000, '绑定码有效期应为 15 分钟');
  const wsHome = temp();
  const hostHome = temp();
  const ws = createWorkstation({ home: wsHome, version: 'test-version' });
  const member = new AccountsStore({ home: hostHome, hostId: 'host-token-test', hostName: '测试主机' });
  const { port } = await ws.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const setupRes = await post(base, '/api/workstation/setup', { name: '绑定码测试', username: 'admin1', password: 'admin-pass-1' });
    assert.equal(setupRes.status, 200);
    const admin = (await setupRes.json()) as { accessToken: string };

    const bindRes = await post(base, '/api/workstation/hosts/bind-code', {}, admin.accessToken);
    assert.equal(bindRes.status, 200);
    const bind = (await bindRes.json()) as { code: string; expiresAt: number };
    assert.ok(bind.code.startsWith('ach_'), '绑定码前缀应为 ach_');
    assert.ok(Math.abs(bind.expiresAt - (Date.now() + HOST_BIND_TTL_MS)) < 5_000, '有效期应为 15 分钟');

    // 只存哈希：accounts.json 里没有明文令牌。
    const centerFile = readFileSync(path.join(wsHome, 'accounts.json'), 'utf8');
    assert.ok(!centerFile.includes(bind.code), 'accounts.json 不能包含明文绑定码');
    assert.ok(centerFile.includes(sha256(bind.code)), '应只保存绑定码的 SHA-256');

    // 真实 HTTP 兑换：本机登记为成员主机，长期凭据只在主机本地。
    const status = await member.registerAsHost(
      base,
      { id: 'host-token-test', name: '测试主机', urls: ['http://127.0.0.1:7878'], version: 'test-version', platform: process.platform },
      bind.code,
    );
    assert.equal(status.mode, 'member');
    const memberFile = path.join(hostHome, 'accounts.json');
    const stored = JSON.parse(readFileSync(memberFile, 'utf8')) as {
      hostKey?: string;
      hostKeyPublic?: string;
      fingerprint?: string;
      centerUrl?: string;
    };
    assert.ok(stored.hostKey, '成员文件应包含主机私钥');
    assert.ok(stored.hostKeyPublic, '成员文件应包含主机公钥');
    assert.match(stored.fingerprint ?? '', /^[0-9a-f]{64}$/);
    assert.equal(stored.centerUrl, base);
    if (process.platform !== 'win32') {
      assert.equal(statSync(memberFile).mode & 0o777, 0o600, '主机私钥所在文件应为 0600');
    }

    // 同一令牌第二次兑换：401（一次性）。
    const reused = await post(base, '/api/workstation/hosts/claim', {
      code: bind.code,
      host: {
        id: 'host-token-test',
        name: '测试主机',
        urls: [],
        publicKey: stored.hostKeyPublic,
        fingerprint: stored.fingerprint,
      },
    });
    assert.equal(reused.status, 401, '同一令牌第二次兑换应被拒绝');
    const reusedBody = (await reused.json()) as { error?: string };
    assert.match(reusedBody.error ?? '', /已使用|已过期/);

    // 过期令牌：直接改 state 里的 expiresAt（不用 mock Date.now）。
    const bind2Res = await post(base, '/api/workstation/hosts/bind-code', {}, admin.accessToken);
    const bind2 = (await bind2Res.json()) as { code: string; expiresAt: number };
    const state = (ws.store as unknown as {
      state: { joinCodes: { codeHash: string; expiresAt: number; usedAt?: number }[] };
    }).state;
    const entry = state.joinCodes.find((item) => item.codeHash === sha256(bind2.code));
    assert.ok(entry, '工作站应保存绑定码哈希');
    entry.expiresAt = Date.now() - 1;
    const expired = await post(base, '/api/workstation/hosts/claim', {
      code: bind2.code,
      host: {
        id: 'host-token-test',
        name: '测试主机',
        urls: [],
        publicKey: stored.hostKeyPublic,
        fingerprint: stored.fingerprint,
      },
    });
    assert.equal(expired.status, 401, '过期令牌应被拒绝');
    assert.match(((await expired.json()) as { error?: string }).error ?? '', /已过期|已使用/);
  } finally {
    member.close();
    await ws.close();
    rmSync(wsHome, { recursive: true, force: true });
    rmSync(hostHome, { recursive: true, force: true });
  }
});
