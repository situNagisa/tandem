// 令牌公共校验：哈希、常量时间比对、吊销与角色白名单；覆盖 tgw_ / dvt_ 两类令牌。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceManager } from '../src/devices/manager.js';
import { GatewayStore } from '../src/gateway/store.js';
import type { Host } from '../src/host.js';
import {
  canApprove,
  canSend,
  findActiveToken,
  hashToken,
  isTokenActive,
  tokenMatchesHash,
} from '../src/auth/token.js';

function temp(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('哈希与常量时间比对', () => {
  const token = 'tgw_0123456789abcdef';
  const hash = hashToken(token);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hashToken(token), hash);
  assert.equal(tokenMatchesHash(token, hash), true);
  assert.equal(tokenMatchesHash('tgw_other', hash), false);
  assert.equal(tokenMatchesHash('', hash), false);
  assert.equal(tokenMatchesHash(token, ''), false);
  assert.equal(tokenMatchesHash(token, 'abcd'), false);
});

test('吊销与到期检查集中判断', () => {
  const now = 1000;
  assert.equal(isTokenActive({}), true);
  assert.equal(isTokenActive({ revokedAt: 1 }), false);
  assert.equal(isTokenActive(undefined), false);
  assert.equal(isTokenActive({}, now, now), false);
  assert.equal(isTokenActive({}, now, now + 1), true);

  const records = [
    { id: 'revoked', tokenHash: hashToken('revoked'), revokedAt: 1 },
    { id: 'expired', tokenHash: hashToken('expired'), expiresAt: now - 1 },
    { id: 'ok', tokenHash: hashToken('ok') },
  ];
  assert.equal(
    findActiveToken(records, 'revoked', (item) => item.tokenHash, { now })?.id,
    undefined,
  );
  assert.equal(
    findActiveToken(records, 'expired', (item) => item.tokenHash, {
      now,
      expiresAtOf: (item) => item.expiresAt,
    })?.id,
    undefined,
  );
  assert.equal(findActiveToken(records, 'ok', (item) => item.tokenHash, { now })?.id, 'ok');
  assert.equal(findActiveToken(records, '', (item) => item.tokenHash, { now }), undefined);
  assert.equal(findActiveToken(records, 'unknown', (item) => item.tokenHash, { now }), undefined);
});

test('角色白名单：审批权与发送权', () => {
  assert.equal(canApprove('owner'), true);
  assert.equal(canApprove('approver'), true);
  assert.equal(canApprove('collaborator'), true);
  assert.equal(canApprove('observer'), false);
  assert.equal(canSend('owner'), true);
  assert.equal(canSend('collaborator'), true);
  assert.equal(canSend('approver'), false);
  assert.equal(canSend('observer'), false);
});

test('网关令牌 tgw_：通过、吊销与跨类型拒绝', () => {
  const home = temp('tandem-token-gateway-');
  const store = new GatewayStore(home);
  try {
    const { token, grant } = store.issueToken({
      memberId: 'm1',
      memberName: '成员',
      allowedModels: ['model-a'],
    });
    assert.match(token, /^tgw_[a-f0-9]{64}$/);
    assert.equal(store.authenticate(token)?.id, grant.id);
    assert.equal(store.authenticate('tgw_invalid'), undefined);

    assert.equal(store.revokeToken(grant.id), true);
    assert.equal(store.authenticate(token), undefined);
  } finally {
    store.flush();
    rmSync(home, { recursive: true, force: true });
  }
});

test('设备令牌 dvt_：通过、吊销与关闭对端访问', () => {
  const home = temp('tandem-token-device-');
  let allowPeer = true;
  const host = {
    settings: () => ({ devices: { allowPeer } }),
    hub: { broadcastAll: () => undefined },
  } as unknown as Host;
  const manager = new DeviceManager(host, home);
  try {
    const issued = manager.issuePeerToken('对端');
    assert.match(issued.token, /^dvt_[a-f0-9]{48}$/);
    assert.equal(manager.authenticatePeer(issued.token)?.id, issued.id);
    assert.equal(manager.authenticatePeer('dvt_invalid'), undefined);
    assert.equal(manager.authenticatePeer(`acw_${'a'.repeat(64)}`), undefined);

    allowPeer = false;
    assert.equal(manager.authenticatePeer(issued.token), undefined);
    allowPeer = true;

    assert.equal(manager.revokePeerToken(issued.id), true);
    assert.equal(manager.authenticatePeer(issued.token), undefined);
  } finally {
    manager.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
