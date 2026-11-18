// MODEL 价格验收测试（product/models.md「价格」一节，MODEL-1…MODEL-7）。
// 只通过公开入口断言：resolvePriceForModel / priceForModel / costOfUsage / priceInfoFor /
// UsageStore / effectiveProfile / sessionUsageBreakdown。
//
// 待实现者提供：StoredProfileGroup.price?: Record<string, PriceRates>（分组自定义单价），
// 且 effectiveProfile(profile, groupId) 把它合并进返回的 profile.price（分组优先于账号）。
// 本文件用 effectiveProfile + resolvePriceForModel 这条最自然的路径断言“分组自定义单价”；
// 计价时官方价只乘分组倍率，不乘账号倍率（倍率只属于分组）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Host } from '../src/host.js';
import { effectiveProfile } from '../src/config.js';
import { sessionUsageBreakdown } from '../src/host/usage.js';
import type { SessionRecord, StoredProfile } from '../src/types.js';
import { UsageStore, costOfUsage, priceForModel, resolvePriceForModel } from '../src/usage.js';

const profile = (overrides: Record<string, unknown> = {}): StoredProfile =>
  ({
    id: 'p-price',
    name: '价格验收账号',
    kind: 'anthropic',
    apiKey: 'test-key',
    models: ['claude-sonnet-4-5', 'claude-opus-5-5'],
    defaultModel: 'claude-sonnet-4-5',
    createdAt: 0,
    ...overrides,
  }) as unknown as StoredProfile;

const io = (resolved: ReturnType<typeof resolvePriceForModel>) =>
  resolved ? { input: resolved.price.input, output: resolved.price.output } : undefined;

test('[MODEL-1] 单价只有两个来源：官方价格表，或分组里为该模型设置的自定义单价', () => {
  // 来源一：官方价格表。
  const official = resolvePriceForModel(undefined, 'claude-sonnet-4-5');
  assert.equal(official?.source, 'builtin');
  assert.deepEqual(io(official), { input: 3, output: 15 });

  // 来源二：分组自定义单价（分组有自己的价格表，优先于官方价）。
  const withGroupPrice = profile({
    groups: [
      {
        id: 'g-price',
        name: '自定义单价分组',
        apiKey: 'test-key-group',
        models: ['claude-sonnet-4-5'],
        defaultModel: 'claude-sonnet-4-5',
        price: { 'claude-sonnet-4-5': { input: 7, output: 14 } },
      },
    ],
  });
  assert.deepEqual(io(resolvePriceForModel(effectiveProfile(withGroupPrice, 'g-price'), 'claude-sonnet-4-5')), {
    input: 7,
    output: 14,
  });

  // 没有第三个来源：官方表没收录、分组也没有自定义单价的型号，不估算、不借用相近型号。
  assert.equal(priceForModel(undefined, 'claude-haiku-5'), undefined);
  assert.equal(priceForModel(undefined, 'future-model-x'), undefined);
});

test('[MODEL-2] 未收录官方价的模型返回“单价未知”标记，而不是 0 价', () => {
  // undefined 是“单价未知”的标记；不能返回 { input: 0, output: 0 } 让界面显示 $0。
  assert.equal(resolvePriceForModel(undefined, 'future-model-x'), undefined);
  assert.equal(priceForModel(undefined, 'future-model-x'), undefined);

  // 用量明细：该型号没有价格条目，但保留 token 与 profileId（界面据此显示“未知单价”并给去设置的入口）。
  const record = {
    id: 's-price-unknown',
    title: '未知单价',
    cwd: '/tmp',
    profileId: 'p-price',
    model: 'future-model-x',
    permissionMode: 'default',
    status: 'idle',
    delegation: 'less',
    todos: [],
    allowedTools: [],
    messages: [
      {
        id: 'a-unknown',
        role: 'assistant',
        content: [],
        createdAt: 1,
        model: 'future-model-x',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000, costUsd: 0 },
      },
    ],
    usage: { inputTokens: 1_000_000, outputTokens: 1_000, costUsd: 0 },
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SessionRecord;
  const host = { profileFor: (id: string) => (id === 'p-price' ? profile() : undefined) } as unknown as Host;
  const breakdown = sessionUsageBreakdown(host, record);
  assert.equal(breakdown.prices['future-model-x'], undefined);
  assert.equal(breakdown.profileId, 'p-price');
  assert.deepEqual(
    breakdown.rows.map((row) => [row.model, row.inputTokens, row.costUsd]),
    [['future-model-x', 1_000_000, 0]],
  );
});

test('[MODEL-3] 倍率只属于分组：官方价 × 分组倍率，账号倍率不参与', () => {
  const accountMultiplierOnly = profile({
    multiplier: 0.5,
    groups: [
      {
        id: 'g-plain',
        name: '默认倍率分组',
        apiKey: 'test-key-group',
        models: ['claude-sonnet-4-5'],
        defaultModel: 'claude-sonnet-4-5',
      },
    ],
  });
  const plain = resolvePriceForModel(effectiveProfile(accountMultiplierOnly, 'g-plain'), 'claude-sonnet-4-5');
  assert.deepEqual(io(plain), { input: 3, output: 15 }, '账号级倍率不应参与计费');
  assert.equal(plain?.groupMultiplier, undefined, '分组未设倍率时应按 1');

  const halfGroup = profile({
    // 故意同时设置账号倍率：规格确认后计费只认分组倍率。
    multiplier: 0.5,
    groups: [
      {
        id: 'g-half',
        name: '五折分组',
        apiKey: 'test-key-group',
        models: ['claude-sonnet-4-5'],
        defaultModel: 'claude-sonnet-4-5',
        multiplier: 0.5,
      },
    ],
  });
  const half = resolvePriceForModel(effectiveProfile(halfGroup, 'g-half'), 'claude-sonnet-4-5');
  assert.deepEqual(io(half), { input: 1.5, output: 7.5 }, '计费应为官方价 × 分组倍率');
  assert.equal(half?.price.cacheRead, 0.15, '缓存价同样乘分组倍率');
  assert.equal(half?.official?.input, 3, '保留官方价供界面展示');
  assert.equal(half?.groupMultiplier, 0.5);

  // 分组自定义单价直接使用，不再乘倍率。
  const customGroup = profile({
    multiplier: 0.5,
    groups: [
      {
        id: 'g-custom',
        name: '自定义单价分组',
        apiKey: 'test-key-group',
        models: ['claude-sonnet-4-5'],
        defaultModel: 'claude-sonnet-4-5',
        multiplier: 0.5,
        price: { 'claude-sonnet-4-5': { input: 7, output: 14 } },
      },
    ],
  });
  assert.deepEqual(io(resolvePriceForModel(effectiveProfile(customGroup, 'g-custom'), 'claude-sonnet-4-5')), {
    input: 7,
    output: 14,
  });
});

test('[MODEL-4] 输入、输出、缓存写、缓存读分别计价；分段价按提示长度分段', () => {
  const opus = priceForModel(undefined, 'claude-opus-5-5')!;
  const cost = (usage: Record<string, number>) =>
    costOfUsage(opus, { inputTokens: 0, outputTokens: 0, ...usage }, 'anthropic');
  assert.equal(cost({ inputTokens: 1_000_000 }), 4);
  assert.equal(cost({ outputTokens: 1_000_000 }), 20);
  assert.equal(cost({ cacheReadTokens: 1_000_000 }), 0.2);
  assert.equal(cost({ cacheWrite5mTokens: 1_000_000 }), 5);
  assert.equal(cost({ cacheWrite1hTokens: 1_000_000 }), 8);
  assert.equal(cost({ cacheWrite5mTokens: 400_000, cacheWrite1hTokens: 600_000 }), 6.8);

  // Haiku 5.5：单次请求提示 token（输入 + 缓存读 + 缓存写）超过 100K 后整条按高价档。
  const haiku = priceForModel(undefined, 'claude-haiku-5-5')!;
  const haikuCost = (usage: Record<string, number>) =>
    costOfUsage(haiku, { inputTokens: 0, outputTokens: 0, ...usage }, 'anthropic');
  assert.equal(haikuCost({ inputTokens: 100_000 }), 0.01);
  assert.equal(haikuCost({ inputTokens: 100_001 }), 0.0500005);
  assert.equal(haikuCost({ inputTokens: 90_000, cacheReadTokens: 11_000 }), 0.04555);
  assert.equal(haikuCost({ outputTokens: 1_000_000 }), 0.5);
  assert.equal(haikuCost({ inputTokens: 100_001, outputTokens: 1_000_000 }), 2.5500005);
});

test('[MODEL-7] 已记账的花费按记账时单价保存，调价不改历史', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-price-history-'));
  try {
    const usage = new UsageStore(home);
    usage.record({
      hostId: 'h1',
      profileId: 'p-price',
      model: 'claude-opus-5-5',
      inputTokens: 1_000_000,
      outputTokens: 0,
      costUsd: 4,
      day: '2026-11-18',
    });
    usage.flush();

    // 之后调价（同型号改成 $9/M）：历史行读回来仍是记账时的 $4。
    const reprice = profile({ price: { 'claude-opus-5-5': { input: 9, output: 45 } } });
    assert.equal(priceForModel(reprice, 'claude-opus-5-5')?.input, 9);
    const reopened = new UsageStore(home);
    const row = reopened.list().find((item) => item.model === 'claude-opus-5-5');
    assert.equal(row?.costUsd, 4, '调价后历史花费被重算');

    // 会话用量明细同样保留记账值，只把当前单价另列为参考。
    const record = {
      id: 's-price-history',
      title: '调价历史',
      cwd: '/tmp',
      profileId: 'p-price',
      model: 'claude-opus-5-5',
      permissionMode: 'default',
      status: 'idle',
      delegation: 'less',
      todos: [],
      allowedTools: [],
      messages: [
        {
          id: 'a-history',
          role: 'assistant',
          content: [],
          createdAt: 1,
          model: 'claude-opus-5-5',
          usage: { inputTokens: 1_000_000, outputTokens: 0, costUsd: 4 },
        },
      ],
      usage: { inputTokens: 1_000_000, outputTokens: 0, costUsd: 4 },
      createdAt: 1,
      updatedAt: 1,
    } as unknown as SessionRecord;
    const host = { profileFor: (id: string) => (id === 'p-price' ? reprice : undefined) } as unknown as Host;
    const breakdown = sessionUsageBreakdown(host, record);
    assert.equal(breakdown.rows[0]?.costUsd, 4, '明细按当前单价重算了历史金额');
    assert.equal(breakdown.prices['claude-opus-5-5']?.input, 9, '明细没有给出当前官方/自定义单价');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
