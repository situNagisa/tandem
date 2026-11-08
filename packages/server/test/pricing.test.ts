import assert from 'node:assert/strict';
import test from 'node:test';
import { priceForModel, resolvePriceForModel } from '../src/usage.js';
import type { StoredProfile } from '../src/types.js';

test('内置单价表：常见模型按前缀命中，版本后缀与供应商前缀不影响', () => {
  assert.deepEqual(priceForModel(undefined, 'gpt-4o'), { input: 2.5, output: 10 });
  assert.deepEqual(priceForModel(undefined, 'gpt-4o-2024-08-06'), { input: 2.5, output: 10 });
  assert.deepEqual(priceForModel(undefined, 'gpt-4-turbo'), { input: 10, output: 30 });
  assert.deepEqual(priceForModel(undefined, 'gpt-4'), { input: 30, output: 60 });
  assert.deepEqual(priceForModel(undefined, 'gpt-3.5-turbo-0125'), { input: 0.5, output: 1.5 });
  assert.deepEqual(priceForModel(undefined, 'openai/gpt-5-mini'), { input: 0.25, output: 2 });
  assert.deepEqual(priceForModel(undefined, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'), {
    input: 3,
    output: 15,
  });
  assert.deepEqual(priceForModel(undefined, 'claude-3-sonnet-20240229'), { input: 3, output: 15 });
  assert.deepEqual(priceForModel(undefined, 'o3-pro'), { input: 20, output: 80 });
});

test('内置单价表：未知模型返回 undefined，不猜价格', () => {
  assert.equal(priceForModel(undefined, 'gpt-6-luna'), undefined);
  assert.equal(priceForModel(undefined, ''), undefined);
});

test('单价来源：账号覆盖标 account，内置表标 builtin', () => {
  const profile = {
    price: { 'gpt-4o': { input: 9, output: 18 } },
  } as unknown as StoredProfile;
  assert.deepEqual(resolvePriceForModel(profile, 'gpt-4o'), {
    price: { input: 9, output: 18 },
    source: 'account',
  });
  assert.deepEqual(resolvePriceForModel(profile, 'o3'), {
    price: { input: 2, output: 8 },
    source: 'builtin',
  });
  assert.equal(resolvePriceForModel(profile, 'gpt-6-luna'), undefined);
});

test('账号单价覆盖：精确匹配 → 前缀匹配 → 内置表', () => {
  const profile = {
    price: {
      'gpt-4o': { input: 9, output: 18 },
      'gpt-4o-mini': { input: 1, output: 2 },
    },
  } as unknown as StoredProfile;
  assert.deepEqual(priceForModel(profile, 'gpt-4o'), { input: 9, output: 18 });
  assert.deepEqual(priceForModel(profile, 'gpt-4o-2024-08-06'), { input: 9, output: 18 });
  assert.deepEqual(priceForModel(profile, 'openai/gpt-4o-mini'), { input: 1, output: 2 });
  assert.deepEqual(priceForModel(profile, 'claude-sonnet-4-5'), { input: 3, output: 15 });
});
