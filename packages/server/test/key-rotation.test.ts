import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KEY_COOLDOWN_BASE_MS,
  KEY_COOLDOWN_MAX_MS,
  classifyKeyFailure,
  cooldownMsFor,
  groupUnavailableError,
  isKeyAvailable,
  keyDisplayName,
  orderedAvailableKeys,
  rotateKeyCandidates,
} from '../src/key-rotation.js';
import type { StoredProfileGroup, StoredProfileKey } from '../src/types.js';

function key(id: string, patch: Partial<StoredProfileKey> = {}): StoredProfileKey {
  return { id, apiKey: `sk-${id}`, ...patch };
}

function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

test('401/403（非额度）停用，429/5xx/额度不足冷却', () => {
  assert.equal(classifyKeyFailure(apiError(401, 'unauthorized')).kind, 'disable');
  assert.equal(classifyKeyFailure(apiError(403, 'forbidden')).kind, 'disable');
  assert.equal(
    classifyKeyFailure(apiError(403, 'quota exceeded for this billing cycle')).kind,
    'cooldown',
  );
  assert.equal(classifyKeyFailure(apiError(429, 'too many requests')).kind, 'cooldown');
  assert.equal(classifyKeyFailure(apiError(502, 'bad gateway')).kind, 'cooldown');
  assert.equal(classifyKeyFailure(apiError(400, 'invalid request')).kind, 'none');
  assert.equal(classifyKeyFailure(new Error('invalid api key')).kind, 'disable');
});

test('Key 冷却指数退避 60s → 30min 封顶', () => {
  assert.equal(cooldownMsFor(1), KEY_COOLDOWN_BASE_MS);
  assert.equal(cooldownMsFor(2), KEY_COOLDOWN_BASE_MS * 2);
  assert.equal(cooldownMsFor(3), KEY_COOLDOWN_BASE_MS * 4);
  assert.equal(cooldownMsFor(100), KEY_COOLDOWN_MAX_MS);
  assert.equal(cooldownMsFor(0), KEY_COOLDOWN_BASE_MS);
});

test('可用 Key 过滤停用与冷却中的项（截止时间边界可再用）', () => {
  const now = 1_000_000;
  assert.equal(isKeyAvailable(key('a'), now), true);
  assert.equal(isKeyAvailable(key('a', { disabled: true }), now), false);
  assert.equal(isKeyAvailable(key('a', { cooldownUntil: now - 1 }), now), true);
  assert.equal(isKeyAvailable(key('a', { cooldownUntil: now }), now), true);
  assert.equal(isKeyAvailable(key('a', { cooldownUntil: now + 1 }), now), false);
});

test('failover 保持顺序，round-robin 从游标轮转并处理越界', () => {
  const keys = [key('a'), key('b', { disabled: true }), key('c'), key('d')];
  assert.deepEqual(
    orderedAvailableKeys(keys, 'failover', 0, 0).map((item) => item.id),
    ['a', 'c', 'd'],
  );
  assert.deepEqual(
    orderedAvailableKeys(keys, 'round_robin', 0, 0).map((item) => item.id),
    ['a', 'c', 'd'],
  );
  assert.deepEqual(
    orderedAvailableKeys(keys, 'round_robin', 1, 0).map((item) => item.id),
    ['c', 'd', 'a'],
  );
  assert.deepEqual(
    orderedAvailableKeys(keys, 'round_robin', 4, 0).map((item) => item.id),
    ['c', 'd', 'a'],
  );
  assert.deepEqual(
    orderedAvailableKeys(keys, 'round_robin', -1, 0).map((item) => item.id),
    ['d', 'a', 'c'],
  );
});

test('Key 显示名与全部不可用文案包含原因', () => {
  assert.equal(keyDisplayName(key('a', { label: ' 主号 ' }), 0), '主号');
  assert.equal(keyDisplayName(key('a'), 1), 'Key 2');

  const now = Date.now();
  const group: StoredProfileGroup = {
    id: 'g1',
    name: '官方',
    apiKey: '',
    models: ['m'],
    defaultModel: 'm',
    keys: [
      key('a', { disabled: true, lastError: 'invalid api key' }),
      key('b', { cooldownUntil: now + 60_000 }),
    ],
  };
  const message = groupUnavailableError(group, new Map([['b', 'HTTP 429']]), now);
  assert.match(message, /分组「官方」的所有 Key 都不可用/);
  assert.match(message, /Key 1（已停用：invalid api key）/);
  assert.match(message, /Key 2（HTTP 429）/);
});

test('轮换游标：round-robin 每次推进一格，failover 不推进', () => {
  const keys = [key('a'), key('b'), key('c')];
  const rotation = new Map<string, number>();
  assert.deepEqual(rotateKeyCandidates(keys, 'round_robin', rotation, 'p:g').map((item) => item.id), ['a', 'b', 'c']);
  assert.equal(rotation.get('p:g'), 1);
  assert.deepEqual(rotateKeyCandidates(keys, 'round_robin', rotation, 'p:g').map((item) => item.id), ['b', 'c', 'a']);
  assert.equal(rotation.get('p:g'), 2);
  const other = new Map<string, number>();
  assert.deepEqual(rotateKeyCandidates(keys, 'failover', other, 'p:g').map((item) => item.id), ['a', 'b', 'c']);
  assert.equal(other.get('p:g'), undefined);
});
