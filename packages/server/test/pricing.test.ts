import assert from 'node:assert/strict';
import test from 'node:test';
import { costOfUsage, priceForModel, priceInfoFor, resolvePriceForModel } from '../src/usage.js';
import { effectiveProfile } from '../src/config.js';
import type { StoredProfile } from '../src/types.js';

/** 只比较输入/输出价，缓存价另有测试覆盖。 */
function io(model: string) {
  const price = priceForModel(undefined, model);
  return price ? { input: price.input, output: price.output } : undefined;
}

test('内置表：常见模型按前缀命中，版本后缀与供应商前缀不影响', () => {
  assert.deepEqual(io('gpt-4o'), { input: 2.5, output: 10 });
  assert.deepEqual(io('gpt-4o-2024-08-06'), { input: 2.5, output: 10 });
  assert.deepEqual(io('gpt-4-turbo'), { input: 10, output: 30 });
  assert.deepEqual(io('gpt-4'), { input: 30, output: 60 });
  assert.deepEqual(io('gpt-3.5-turbo-0125'), { input: 0.5, output: 1.5 });
  assert.deepEqual(io('openai/gpt-5-mini'), { input: 0.25, output: 2 });
  assert.deepEqual(io('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), { input: 3, output: 15 });
  assert.deepEqual(io('claude-3-sonnet-20240229'), { input: 3, output: 15 });
  assert.deepEqual(io('o3-pro'), { input: 20, output: 80 });
});

test('未收录的型号返回 undefined，不猜价格', () => {
  assert.equal(priceForModel(undefined, 'mystery-model-1'), undefined);
  assert.equal(priceForModel(undefined, ''), undefined);
  // 官方页没有 Haiku 5 / GPT-7 的价格：不按家族或旧代际借价。
  assert.equal(priceForModel(undefined, 'claude-haiku-5'), undefined);
  assert.equal(priceForModel(undefined, 'gpt-7-luna'), undefined);
});

test('Claude 逐型号官方价：Opus 5.5 / Sonnet 5.5 / Haiku 5.5 含缓存读写价', () => {
  assert.deepEqual(priceForModel(undefined, 'claude-opus-5-5'), {
    input: 4,
    output: 20,
    cacheWrite5m: 5,
    cacheWrite1h: 8,
    cacheRead: 0.2,
  });
  assert.deepEqual(priceForModel(undefined, 'claude-sonnet-5-5'), {
    input: 2,
    output: 10,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
    cacheRead: 0.1,
  });
  assert.deepEqual(priceForModel(undefined, 'claude-haiku-5-5'), {
    input: 0.1,
    output: 0.5,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    cacheRead: 0.01,
    longPrompt: {
      threshold: 100_000,
      rates: { input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 },
    },
  });
  assert.deepEqual(io('claude-opus-5'), { input: 5, output: 25 });
  assert.deepEqual(io('claude-sonnet-5'), { input: 2, output: 10 });
  assert.deepEqual(io('claude-opus-4-8'), { input: 5, output: 25 });
  assert.deepEqual(io('claude-opus-4-1'), { input: 15, output: 75 });
  assert.deepEqual(io('claude-fable-5-2'), { input: 8, output: 40 });
  assert.deepEqual(io('claude-mythos-5-1'), { input: 10, output: 50 });
  // 点号写法与连字符等价
  assert.deepEqual(io('claude-opus-5.5'), { input: 4, output: 20 });
  assert.deepEqual(io('claude-3.5-sonnet-20241022'), { input: 3, output: 15 });
});

test('单价来源：账号覆盖标 account，内置表标 builtin', () => {
  const profile = {
    price: { 'gpt-4o': { input: 9, output: 18 } },
  } as unknown as StoredProfile;
  assert.deepEqual(resolvePriceForModel(profile, 'gpt-4o'), {
    price: { input: 9, output: 18 },
    source: 'account',
  });
  assert.equal(resolvePriceForModel(profile, 'o3')?.source, 'builtin');
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
  assert.deepEqual(io('claude-sonnet-4-5'), { input: 3, output: 15 });
  assert.deepEqual(priceForModel(profile, 'claude-sonnet-4-5'), {
    input: 3,
    output: 15,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    cacheRead: 0.3,
  });
});

test('倍率：实际价格 = 官方价 × 账号倍率 × 分组倍率（含缓存价）', () => {
  const profile = {
    multiplier: 0.5,
    groupMultiplier: 0.8,
  } as unknown as StoredProfile;
  const resolved = resolvePriceForModel(profile, 'claude-sonnet-4-5');
  assert.equal(resolved?.price.input, 1.2);
  assert.equal(resolved?.price.output, 6);
  assert.equal(resolved?.price.cacheRead, 0.12);
  assert.equal(resolved?.price.cacheWrite5m, 1.5);
  assert.equal(resolved?.source, 'builtin');
  assert.equal(resolved?.official?.input, 3);
  assert.equal(resolved?.official?.output, 15);
  assert.equal(resolved?.accountMultiplier, 0.5);
  assert.equal(resolved?.groupMultiplier, 0.8);
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
  assert.deepEqual(priceForModel(profile, 'o3'), { input: 0.3, output: 1.2 });
});

test('无官方价的模型在倍率下仍返回 undefined', () => {
  const profile = { multiplier: 0.5, groupMultiplier: 0.5 } as unknown as StoredProfile;
  assert.equal(resolvePriceForModel(profile, 'mock-1'), undefined);
  assert.equal(priceForModel(profile, 'mock-1'), undefined);
});

test('补充的常见模型按前缀命中官方价', () => {
  assert.deepEqual(io('claude-opus-4-5-20251101'), { input: 5, output: 25 });
  assert.deepEqual(io('gpt-5.1-codex'), { input: 1.25, output: 10 });
  assert.deepEqual(io('gpt-6-luna'), { input: 0.1, output: 0.5 });
  assert.deepEqual(io('deepseek-flash'), { input: 0.3, output: 1.2 });
  assert.deepEqual(io('deepseek-v4-pro'), { input: 1.32, output: 3.96 });
  assert.deepEqual(io('gemini-3.1-pro'), { input: 2, output: 12 });
  assert.deepEqual(io('gemini-2.5-pro'), { input: 1.25, output: 10 });
  assert.deepEqual(io('glm-4.6'), { input: 0.6, output: 2.2 });
  assert.deepEqual(io('glm-5.3'), { input: 1.4, output: 4.4 });
});

test('单次调用按 token 种类分别乘价（Opus 5.5）', () => {
  const price = priceForModel(undefined, 'claude-opus-5-5')!;
  const cost = (usage: Record<string, number>) =>
    costOfUsage(price, { inputTokens: 0, outputTokens: 0, ...usage }, 'anthropic');
  assert.equal(cost({ inputTokens: 1_000_000 }), 4);
  assert.equal(cost({ outputTokens: 1_000_000 }), 20);
  assert.equal(cost({ cacheReadTokens: 1_000_000 }), 0.2);
  assert.equal(cost({ cacheWriteTokens: 1_000_000 }), 5);
  assert.equal(cost({ cacheWrite5mTokens: 1_000_000 }), 5);
  assert.equal(cost({ cacheWrite1hTokens: 1_000_000 }), 8);
  assert.equal(cost({ cacheWrite5mTokens: 400_000, cacheWrite1hTokens: 600_000 }), 6.8);
});

test('Haiku 5.5 按单次请求提示 token 分段：>100K 整条按高价', () => {
  const price = priceForModel(undefined, 'claude-haiku-5-5')!;
  const cost = (usage: Record<string, number>) =>
    costOfUsage(price, { inputTokens: 0, outputTokens: 0, ...usage }, 'anthropic');
  assert.equal(cost({ inputTokens: 100_000 }), 0.01);
  assert.equal(cost({ inputTokens: 100_001 }), 0.0500005);
  // 提示 token = 输入 + 缓存读 + 缓存写；超过 100K 后缓存价也走高价档。
  assert.equal(cost({ inputTokens: 90_000, cacheReadTokens: 11_000 }), 0.04555);
  assert.equal(cost({ outputTokens: 1_000_000 }), 0.5);
  assert.equal(cost({ inputTokens: 100_001, outputTokens: 1_000_000 }), 2.5500005);
});

test('账号自定义单价没有缓存价时按协议倍率折算', () => {
  const profile = { price: { 'custom-claude': { input: 10, output: 20 } } } as unknown as StoredProfile;
  const price = priceForModel(profile, 'custom-claude')!;
  const cost = costOfUsage(price, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, 'anthropic');
  assert.equal(cost, 1);
  assert.equal(costOfUsage(price, { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 }, 'anthropic'), 22.5);
  const info = priceInfoFor(price, 'anthropic');
  assert.equal(info.cacheRead, 1);
  assert.equal(info.cacheWrite, 12.5);
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
