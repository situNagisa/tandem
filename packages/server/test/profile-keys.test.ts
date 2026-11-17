import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProfileGroupInput, ProfileInput } from '@tandem/protocol';
import { ProfileStore, effectiveProfile, looksMaskedKey } from '../src/config.js';
import { priceForModel } from '../src/usage.js';

function store(): ProfileStore {
  return new ProfileStore(mkdtempSync(path.join(tmpdir(), 'tandem-keys-')));
}

function baseInput(patch: Partial<ProfileInput> = {}): ProfileInput {
  return {
    name: '账号',
    kind: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    models: ['m1'],
    defaultModel: 'm1',
    ...patch,
  };
}

function group(patch: Partial<ProfileGroupInput> = {}): ProfileGroupInput {
  return { name: 'aws', kind: 'openai-compatible', models: ['m1'], defaultModel: 'm1', ...patch };
}

test('掩码识别：回传的掩码与空值都视为未修改', () => {
  assert.equal(looksMaskedKey('sk-t****abcd'), true);
  assert.equal(looksMaskedKey('••••abcd'), true);
  assert.equal(looksMaskedKey('sk-real-key'), false);
  assert.equal(looksMaskedKey(''), false);
});

test('账号/分组倍率保存后重新加载仍在，计价按官方价 × 账号倍率 × 分组倍率', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tandem-multiplier-'));
  const created = new ProfileStore(dir).create(
    baseInput({ multiplier: 0.5, groups: [group({ id: 'g1', multiplier: 0.8 })] }),
  );
  // 重启后从存储读回：规范化不能丢倍率。
  const reloaded = new ProfileStore(dir).get(created.id)!;
  assert.equal(reloaded.multiplier, 0.5, '账号倍率重新加载后丢失');
  assert.equal(reloaded.groups?.[0]?.multiplier, 0.8, '分组倍率重新加载后丢失');
  const effective = effectiveProfile(reloaded, 'g1');
  assert.equal(effective.groupMultiplier, 0.8);
  assert.deepEqual(priceForModel(effective, 'claude-sonnet-4-5'), {
    input: 1.2,
    output: 6,
    cacheWrite5m: 1.5,
    cacheWrite1h: 2.4,
    cacheRead: 0.12,
  });
});

test('只设分组倍率时计价为官方价 × 分组倍率', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tandem-multiplier-'));
  const created = new ProfileStore(dir).create(
    baseInput({ groups: [group({ id: 'g1', multiplier: 0.5 })] }),
  );
  const reloaded = new ProfileStore(dir).get(created.id)!;
  assert.equal(reloaded.multiplier, undefined);
  const effective = effectiveProfile(reloaded, 'g1');
  assert.deepEqual(priceForModel(effective, 'claude-sonnet-4-5'), {
    input: 1.5,
    output: 7.5,
    cacheWrite5m: 1.875,
    cacheWrite1h: 3,
    cacheRead: 0.15,
  });
});

test('编辑分组其他字段时保留原 Key', () => {
  const s = store();
  const created = s.create(baseInput({ groups: [group({ apiKey: 'sk-secret-1234' })] }));
  const gid = created.groups![0]!.id;
  s.update(created.id, baseInput({ groups: [group({ id: gid, multiplier: 0.8 })] }));
  assert.equal(s.get(created.id)?.groups?.[0]?.apiKey, 'sk-secret-1234');
  assert.equal(s.get(created.id)?.groups?.[0]?.keys?.[0]?.apiKey, 'sk-secret-1234');
});

test('缺省/空字符串 Key 不覆盖已有值，显式新 Key 才更新', () => {
  const s = store();
  const created = s.create(baseInput({ groups: [group({ apiKey: 'sk-secret-1234' })] }));
  const gid = created.groups![0]!.id;
  s.update(created.id, baseInput({ groups: [group({ id: gid, apiKey: '' })] }));
  assert.equal(s.get(created.id)?.groups?.[0]?.apiKey, 'sk-secret-1234');
  s.update(created.id, baseInput({ groups: [group({ id: gid, apiKey: 'sk-secret-5678' })] }));
  assert.equal(s.get(created.id)?.groups?.[0]?.apiKey, 'sk-secret-5678');
});

test('回传掩码不会把真实 Key 写成掩码', () => {
  const s = store();
  const created = s.create(baseInput({ groups: [group({ apiKey: 'sk-secret-1234' })] }));
  const gid = created.groups![0]!.id;
  const masked = s.toPublic(created).groups![0]!.apiKeyMasked;
  s.update(created.id, baseInput({ apiKey: masked, groups: [group({ id: gid, apiKey: masked })] }));
  assert.equal(s.get(created.id)?.groups?.[0]?.apiKey, 'sk-secret-1234');
  assert.equal(s.get(created.id)?.apiKey, '');
});

test('Key 列表按 id 保留未重传的值', () => {
  const s = store();
  const created = s.create(baseInput({ groups: [group({ apiKey: 'sk-secret-1234' })] }));
  const gid = created.groups![0]!.id;
  const publicGroup = s.toPublic(created).groups![0]!;
  const keyId = publicGroup.keys![0]!.id;
  s.update(
    created.id,
    baseInput({
      groups: [group({ id: gid, apiKeys: [{ id: keyId, label: '主' }] })],
    }),
  );
  assert.equal(s.get(created.id)?.groups?.[0]?.keys?.[0]?.apiKey, 'sk-secret-1234');
  assert.equal(s.get(created.id)?.groups?.[0]?.keys?.[0]?.label, '主');
});

test('老账号的账号级 Key 在编辑后保留', () => {
  const s = store();
  const created = s.create(baseInput({ apiKey: 'sk-legacy-9999' }));
  s.update(created.id, baseInput({ name: '改名', groups: [group({ name: '默认' })] }));
  assert.equal(s.get(created.id)?.apiKey, 'sk-legacy-9999');
  assert.equal(s.get(created.id)?.groups?.[0]?.apiKey, 'sk-legacy-9999');
});
