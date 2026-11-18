import test from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '../src/host.js';
import type { SessionRecord } from '../src/types.js';
import { sessionUsageBreakdown } from '../src/host/usage.js';

const profile = {
  id: 'p1',
  name: '测试账号',
  kind: 'anthropic' as const,
  apiKey: 'k',
  baseUrl: 'http://127.0.0.1:1',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  defaultModel: 'claude-opus-5-5',
  createdAt: 0,
};

const host = {
  profileFor: (id: string) => (id === 'p1' ? profile : undefined),
} as unknown as Host;

const message = (id: string, model: string, usage: Record<string, number>) => ({
  id,
  role: 'assistant' as const,
  content: [],
  createdAt: 1,
  model,
  usage: { inputTokens: 0, outputTokens: 0, ...usage },
});

function rec(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1',
    title: 't',
    cwd: '/tmp',
    profileId: 'p1',
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    status: 'idle',
    delegation: 'less',
    messages: [],
    todos: [],
    allowedTools: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SessionRecord;
}

test('按模型汇总消息用量：金额与 token 分模型相加，差额单列「其他」', () => {
  const record = rec({
    messages: [
      message('a1', 'claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0, costUsd: 5 }),
      message('a2', 'claude-opus-5-5', { inputTokens: 0, outputTokens: 400_000, costUsd: 10 }),
      message('a3', 'claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0, costUsd: 3 }),
      { id: 'u1', role: 'user', content: [], createdAt: 1 },
    ],
    usage: { inputTokens: 2_500_000, outputTokens: 400_000, costUsd: 20 },
  });
  const breakdown = sessionUsageBreakdown(host, record);
  assert.deepEqual(
    breakdown.rows.map((row) => [row.model, row.calls, row.inputTokens, row.outputTokens, row.costUsd]),
    [
      ['claude-opus-5-5', 2, 1_000_000, 400_000, 15],
      ['claude-sonnet-5-5', 1, 1_000_000, 0, 3],
    ],
  );
  // 500k 输入 / 2 美元不在消息上（压缩、评审或更早的分页消息）。
  assert.equal(breakdown.residual.inputTokens, 500_000);
  assert.equal(breakdown.residual.outputTokens, 0);
  assert.equal(breakdown.residual.costUsd, 2);
  assert.equal(breakdown.total.costUsd, 20);
});

test('单价按官方表解析，金额保持记账值；返回会话账号供未知单价跳转', () => {
  const record = rec({
    messages: [
      message('a1', 'claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0, costUsd: 5 }),
      message('a2', 'mock-1', { inputTokens: 1_000_000, outputTokens: 0, costUsd: 0 }),
    ],
    usage: { inputTokens: 2_000_000, outputTokens: 0, costUsd: 5 },
  });
  const breakdown = sessionUsageBreakdown(host, record);
  const price = breakdown.prices['claude-opus-5-5'];
  assert.equal(price?.input, 4);
  assert.equal(price?.output, 20);
  assert.equal(price?.cacheRead, 0.2);
  assert.equal(price?.cacheWrite, 5);
  // 记账金额 5 美元没有被按当前单价重算成别的值。
  assert.equal(breakdown.rows.find((row) => row.model === 'claude-opus-5-5')?.costUsd, 5);
  // 未收录官方价的型号不下发单价，界面据此显示「未知单价」。
  assert.equal(breakdown.prices['mock-1'], undefined);
  assert.equal(breakdown.profileId, 'p1');
});

test('有单价但缺少某种 token 单价时，不下发单价（按未知单价显示）', () => {
  const cachedProfile = {
    ...profile,
    kind: 'openai' as const,
    models: ['gpt-4.1'],
    defaultModel: 'gpt-4.1',
  };
  const cachedHost = {
    profileFor: (id: string) => (id === 'p1' ? cachedProfile : undefined),
  } as unknown as Host;
  const record = rec({
    model: 'gpt-4.1',
    messages: [
      message('c1', 'gpt-4.1', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 10_000,
        costUsd: 2,
      }),
    ],
    usage: { inputTokens: 1_000_000, outputTokens: 0, costUsd: 2 },
  });
  const breakdown = sessionUsageBreakdown(cachedHost, record);
  // gpt-4.1 官方表没有缓存读价：该行不能自行折算，按未知单价处理。
  assert.equal(breakdown.prices['gpt-4.1'], undefined);
  assert.equal(breakdown.rows[0]?.costUsd, 2);
});

test('有单价但该种 token 用量为 0 时照常下发单价', () => {
  const cachedProfile = {
    ...profile,
    kind: 'openai' as const,
    models: ['gpt-4.1'],
    defaultModel: 'gpt-4.1',
  };
  const cachedHost = {
    profileFor: (id: string) => (id === 'p1' ? cachedProfile : undefined),
  } as unknown as Host;
  const record = rec({
    model: 'gpt-4.1',
    messages: [message('c2', 'gpt-4.1', { inputTokens: 1_000_000, outputTokens: 0, costUsd: 2 })],
    usage: { inputTokens: 1_000_000, outputTokens: 0, costUsd: 2 },
  });
  const breakdown = sessionUsageBreakdown(cachedHost, record);
  assert.equal(breakdown.prices['gpt-4.1']?.input, 2);
  assert.equal(breakdown.prices['gpt-4.1']?.cacheRead, undefined);
});
