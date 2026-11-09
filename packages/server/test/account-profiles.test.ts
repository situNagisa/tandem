// 账号级模型账号：工作站加密存储、主机签名代理鉴权、迁移幂等与流式透传。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountsStore } from '../src/accounts/store.js';
import { ProfileStore } from '../src/config.js';
import { generateHostKey, identityFromHostKey } from '../src/workstation/e2e.js';
import { b64u } from '@tandem/protocol/wire';
import { AccountProfileStore } from '../src/workstation/profiles.js';
import { WorkstationUsageStore, streamAccountModel } from '../src/workstation/modelProxy.js';
import { signHostRequest, verifyHostRequest } from '../src/workstation/hostAuth.js';
import { migrateHostProfiles } from '../src/workstation/migrate.js';
import type { Host } from '../src/host.js';
import type { StoredProfile } from '../src/types.js';
import type { WorkspaceModelProxyEvent } from '@tandem/protocol';

function temp(prefix = 'tandem-acct-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function profileWithKey(baseUrl: string, key = 'sk-test-account-key-123456'): StoredProfile {
  return {
    id: 'p1',
    name: '账号 A',
    kind: 'openai-compatible',
    baseUrl,
    apiKey: key,
    models: ['mock-model'],
    defaultModel: 'mock-model',
    createdAt: 1,
  };
}

function assertNoKeyUnder(dir: string, key: string): void {
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        let text = '';
        try {
          text = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        assert.equal(text.includes(key), false, `${full} 不应包含 Key`);
      }
    }
  };
  walk(dir);
}

function mockProvider(chunks: string[] = ['账号级', '流式回复']): ReturnType<typeof http.createServer> {
  return http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model', object: 'model' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: { stream?: boolean } = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      /* ignore */
    }
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '标题' }, finish_reason: 'stop' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const text of chunks) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

test('工作站账号模型账号：Key 加密落盘、只回掩码、重启可读', () => {
  const home = temp();
  try {
    const store = new AccountProfileStore(home);
    const publicProfile = store.create('acct-1', {
      name: '公司中转',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-plain-disk-key-abcdef',
      models: ['m1'],
      defaultModel: 'm1',
    });
    assert.equal(publicProfile.apiKeyMasked.includes('****'), true);
    assert.equal(JSON.stringify(publicProfile).includes('sk-plain-disk-key'), false, '接口不能回明文 Key');
    assert.equal(readFileSync(path.join(home, 'profiles.json'), 'utf8').includes('sk-plain-disk-key'), false, '落盘文件不能有明文 Key');
    assert.ok(existsSync(path.join(home, 'profiles.key')), '密钥应单独存放');
    if (process.platform !== 'win32') {
      assert.equal(statSync(path.join(home, 'profiles.json')).mode & 0o777, 0o600);
      assert.equal(statSync(path.join(home, 'profiles.key')).mode & 0o777, 0o600);
    }
    const reopened = new AccountProfileStore(home);
    assert.equal(reopened.list('acct-1')[0]?.apiKey, 'sk-plain-disk-key-abcdef', '重启后应能解密');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('代理鉴权：主机 A 不能用用户 B 的账号；签名过期/篡改被拒', () => {
  const home = temp();
  try {
    const center = new AccountsStore({ home, hostId: 'ws', hostName: 'ws' });
    const setup = center.setup('测试工作站', 'alice', 'alice-pass-1', []);
    const alice = setup.account;
    const bob = center.createAccount({ username: 'bob', password: 'bob-pass-1', role: 'member', scope: 'hosts', hostIds: [] });
    const hostKey = generateHostKey();
    const identity = identityFromHostKey(hostKey);
    const host = center.registerHost(alice.id, {
      id: '11111111-1111-4111-8111-111111111111',
      name: '主机 A',
      publicKey: b64u(identity.publicRaw),
      fingerprint: identity.fingerprint,
    });
    assert.equal(host.ownerId, alice.id);
    assert.equal(center.accountCanAccessHost(host.id, alice.id), true);
    assert.equal(center.accountCanAccessHost(host.id, bob.id), false, '未授权账号不能使用主机');
    center.setHostGrant(host.id, alice.id, { accountId: bob.id, role: 'observer' });
    assert.equal(center.accountCanAccessHost(host.id, bob.id), true, '授权后可用');
    center.removeHostGrant(host.id, alice.id, bob.id);

    const body = Buffer.from(JSON.stringify({ accountId: alice.id }));
    const pathName = '/api/workstation/host/profiles/snapshot';
    const headers = signHostRequest(hostKey, { hostId: host.id, accountId: alice.id, method: 'POST', path: pathName, body });
    const fakeReq = (h: Record<string, string>, b: Buffer) =>
      ({ headers: h, method: 'POST', raw: { url: pathName }, body: JSON.parse(b.toString()) }) as never;
    assert.deepEqual(verifyHostRequest(center, fakeReq(headers, body), body), { hostId: host.id, accountId: alice.id });
    assert.throws(
      () => verifyHostRequest(center, fakeReq(headers, Buffer.from('{}')), Buffer.from('{}')),
      /签名无效/,
    );
    const expired = signHostRequest(hostKey, {
      hostId: host.id,
      accountId: alice.id,
      method: 'POST',
      path: pathName,
      body,
      timestamp: Date.now() - 10 * 60_000,
    });
    assert.throws(() => verifyHostRequest(center, fakeReq(expired, body), body), /已过期/);
    const bobHeaders = signHostRequest(hostKey, { hostId: host.id, accountId: bob.id, method: 'POST', path: pathName, body: Buffer.from(JSON.stringify({ accountId: bob.id })) });
    assert.throws(
      () =>
        verifyHostRequest(
          center,
          fakeReq(bobHeaders, Buffer.from(JSON.stringify({ accountId: bob.id }))),
          Buffer.from(JSON.stringify({ accountId: bob.id })),
        ),
      /无权使用/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('迁移：主机本地 profiles 搬到工作站后，主机侧不再有 profiles 文件与 Key', async () => {
  const home = temp('tandem-acct-mig-');
  const hostHome = temp('tandem-acct-host-');
  try {
    const accountId = 'acct-1';
    const store = new AccountProfileStore(home);
    const legacyStore = new ProfileStore(hostHome);
    legacyStore.create({
      name: '仅主机账号',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-legacy-only-key',
      models: ['m1'],
      defaultModel: 'm1',
    });
    const fakeClient = {
      importProfiles: async (acct: string, profiles: StoredProfile[]) => {
        const result = store.importStored(acct, profiles);
        return { ...result, profiles: store.publicList(acct) };
      },
    };
    const fakeHost = {
      home: hostHome,
      config: { hostId: 'h1' },
      mirrorProfiles: true,
      accounts: { ownerAccountId: () => accountId },
      workstationProfiles: () => fakeClient,
      syncWorkstationProfiles: async () => undefined,
    } as unknown as Host;
    const result = await migrateHostProfiles(fakeHost);
    assert.equal(result?.imported, 1);
    assert.ok(store.list(accountId).some((p) => p.name === '仅主机账号' && p.apiKey === 'sk-legacy-only-key'), '工作站应有可用的 Key');
    assert.equal(existsSync(path.join(hostHome, 'profiles.json')), false, '迁移后主机本地 profiles 文件应删除');
    assertNoKeyUnder(hostHome, 'sk-legacy-only-key');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(hostHome, { recursive: true, force: true });
  }
});

test('模型代理：流式透传、按账号记账、中断即返回', async () => {
  const home = temp();
  const mock = mockProvider();
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const port = (mock.address() as { port: number }).port;
  try {
    const profiles = new AccountProfileStore(home);
    const usage = new WorkstationUsageStore(home);
    const publicProfile = profiles.create('acct-1', {
      name: 'Mock',
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test-proxy',
      models: ['mock-model'],
      defaultModel: 'mock-model',
    });
    const events: WorkspaceModelProxyEvent[] = [];
    await streamAccountModel(
      { profiles, usage, accountId: 'acct-1', hostId: 'h1' },
      {
        accountId: 'acct-1',
        profileId: publicProfile.id,
        model: 'mock-model',
        system: '',
        messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '你好' }], createdAt: 1 }],
        tools: [],
        maxTokens: 128,
      },
      (event) => events.push(event),
      new AbortController().signal,
    );
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
    assert.equal(text, '账号级流式回复');
    assert.ok(events.some((e) => e.type === 'block_start'));
    const done = events.find((e) => e.type === 'done') as { usage: { outputTokens: number }; costUsd: number } | undefined;
    assert.ok(done, '应回传 done 与用量');
    assert.equal(typeof done!.costUsd, 'number');
    assert.equal(usage.rowsFor('acct-1').length, 1, '用量按账号记账');
    assert.equal(usage.rowsFor('acct-1')[0]?.hostId, 'h1');

    // Key 在失败后停用/冷却状态由工作站自己记录（这里只验证中断不挂起）。
    const controller = new AbortController();
    const slow = mockProvider(Array.from({ length: 50 }, () => '慢'));
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const slowPort = (slow.address() as { port: number }).port;
    const slowProfile = profiles.create('acct-1', {
      name: 'Slow',
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${slowPort}/v1`,
      apiKey: 'sk-slow',
      models: ['mock-model'],
      defaultModel: 'mock-model',
    });
    const slowEvents: WorkspaceModelProxyEvent[] = [];
    const pending = streamAccountModel(
      { profiles, usage, accountId: 'acct-1', hostId: 'h1' },
      {
        accountId: 'acct-1',
        profileId: slowProfile.id,
        model: 'mock-model',
        system: '',
        messages: [],
        tools: [],
        maxTokens: 128,
      },
      (event) => {
        slowEvents.push(event);
        if (event.type === 'text') controller.abort();
      },
      controller.signal,
    );
    await pending.catch(() => undefined);
    assert.equal(slowEvents.some((e) => e.type === 'done'), false, '中断后不应再回传 done');
    slow.close();
  } finally {
    mock.close();
    rmSync(home, { recursive: true, force: true });
  }
});
