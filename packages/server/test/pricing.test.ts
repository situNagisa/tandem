import assert from 'node:assert/strict';
import test from 'node:test';
import { priceForModel, resolvePriceForModel } from '../src/usage.js';
import { effectiveProfile } from '../src/config.js';
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
  assert.equal(priceForModel(undefined, 'mystery-model-1'), undefined);
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
  assert.equal(resolvePriceForModel(profile, 'mystery-model-1'), undefined);
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

test('倍率：实际价格 = 官方价 × 账号倍率 × 分组倍率', () => {
  const profile = {
    multiplier: 0.5,
    groupMultiplier: 0.8,
  } as unknown as StoredProfile;
  const resolved = resolvePriceForModel(profile, 'claude-sonnet-4-5');
  assert.deepEqual(resolved, {
    price: { input: 1.2, output: 6 },
    source: 'builtin',
    official: { input: 3, output: 15 },
    accountMultiplier: 0.5,
    groupMultiplier: 0.8,
  });
  assert.deepEqual(priceForModel(profile, 'gpt-5-mini'), { input: 0.1, output: 0.8 });
});

test('按模型覆盖单价优先，覆盖后不再乘倍率', () => {
  const profile = {
    multiplier: 0.3,
    groupMultiplier: 0.5,
    price: { 'gpt-4o': { input: 9, output: 18 } },
  } as unknown as StoredProfile;
  assert.deepEqual(resolvePriceForModel(profile, 'gpt-4o'), {
    price: { input: 9, output: 18 },
    source: 'account',
  });
  // 覆盖按前缀匹配，gpt-4o-mini 也会命中 gpt-4o 的覆盖价；换一个未覆盖模型验证倍数。
  assert.deepEqual(priceForModel(profile, 'o3'), { input: 0.3, output: 1.2 });
});

test('无参考价的模型仍返回 undefined，倍率不猜价', () => {
  const profile = { multiplier: 0.5, groupMultiplier: 0.5 } as unknown as StoredProfile;
  assert.equal(resolvePriceForModel(profile, 'mock-1'), undefined);
  assert.equal(priceForModel(profile, 'mock-1'), undefined);
});

test('补充的常见模型按前缀命中官方参考价', () => {
  assert.deepEqual(priceForModel(undefined, 'claude-opus-4-5-20251101'), { input: 5, output: 25 });
  assert.deepEqual(priceForModel(undefined, 'gpt-5.1-codex'), { input: 1.25, output: 10 });
  assert.deepEqual(priceForModel(undefined, 'gpt-6-mini'), { input: 0.25, output: 2 });
  assert.deepEqual(priceForModel(undefined, 'deepseek-v3.2'), { input: 0.27, output: 1.1 });
  assert.deepEqual(priceForModel(undefined, 'gemini-3-pro'), { input: 1.25, output: 10 });
  assert.deepEqual(priceForModel(undefined, 'kimi-k2-0905'), { input: 0.6, output: 2.5 });
  assert.deepEqual(priceForModel(undefined, 'qwen3-coder-plus'), { input: 0.3, output: 1.2 });
  assert.deepEqual(priceForModel(undefined, 'glm-4.6'), { input: 0.6, output: 2.2 });
});

test('effectiveProfile 合并分组倍率，计费与菜单共用同一函数', () => {
  const profile = {
    id: 'p',
    name: '账号',
    kind: 'openai-compatible',
    apiKey: 'k',
    models: ['gpt-5-mini'],
    defaultModel: 'gpt-5-mini',
    multiplier: 0.5,
    groups: [
      {
        id: 'g1',
        name: '低价渠道',
        apiKey: 'k2',
        models: ['gpt-5-mini'],
        defaultModel: 'gpt-5-mini',
        multiplier: 0.8,
      },
    ],
  } as unknown as StoredProfile;
  const effective = effectiveProfile(profile, 'g1');
  assert.equal(effective.groupMultiplier, 0.8);
  assert.deepEqual(priceForModel(effective, 'gpt-5-mini'), { input: 0.1, output: 0.8 });
});
