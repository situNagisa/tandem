// 账号余额查询：各平台响应解析、baseUrl 自动识别、5 分钟缓存（mock fetch，不请求真实外部接口）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { BalanceService, detectBalancePlatform, parseBalanceResponse } from '../src/workstation/balance.js';
import type { StoredProfile } from '../src/types.js';

function profile(baseUrl: string, extra: Partial<StoredProfile> = {}): StoredProfile {
  return {
    id: 'p1',
    name: '账号',
    kind: 'openai-compatible',
    baseUrl,
    apiKey: 'sk-balance-test',
    models: ['m1'],
    defaultModel: 'm1',
    createdAt: 1,
    ...extra,
  };
}

test('余额解析：OpenRouter / DeepSeek / Moonshot / New API / OpenAI / 自定义', () => {
  assert.deepEqual(parseBalanceResponse('openrouter', { data: { total_credits: 25, total_usage: 4.5 } }), {
    amount: 20.5,
    currency: 'USD',
  });
  assert.deepEqual(
    parseBalanceResponse('deepseek', {
      balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '1' }],
    }),
    { amount: 12.34, currency: 'CNY' },
  );
  assert.deepEqual(parseBalanceResponse('moonshot', { data: { available_balance: '8.20' } }), {
    amount: 8.2,
    currency: 'CNY',
  });
  assert.deepEqual(parseBalanceResponse('new-api', { data: { quota: 250000, used_quota: 1 } }), {
    amount: 0.5,
    currency: 'USD',
  });
  assert.deepEqual(parseBalanceResponse('openai-billing', { hard_limit_usd: 18 }, {}), {
    amount: 18,
    currency: 'USD',
  });
  assert.deepEqual(parseBalanceResponse('openai-credit-grants', { total_available: 6.5 }), {
    amount: 6.5,
    currency: 'USD',
  });
  assert.deepEqual(
    parseBalanceResponse('custom', { result: { credit: '3.14', currency: 'EUR' } }, { path: 'result.credit' }),
    { amount: 3.14, currency: 'EUR' },
  );
  assert.ok(parseBalanceResponse('custom', {}, { path: 'nope' }).error);
});

test('余额平台自动识别：只认已知域名，识别不了关闭；显式选择优先', () => {
  assert.equal(detectBalancePlatform(profile('https://openrouter.ai/api/v1')), 'openrouter');
  assert.equal(detectBalancePlatform(profile('https://api.deepseek.com/v1')), 'deepseek');
  assert.equal(detectBalancePlatform(profile('https://api.moonshot.cn/v1')), 'moonshot');
  assert.equal(detectBalancePlatform(profile('https://new-api.example.com/v1')), 'new-api');
  assert.equal(detectBalancePlatform(profile('https://api.openai.com/v1', { kind: 'openai' })), 'openai-billing');
  assert.equal(detectBalancePlatform(profile('https://relay.example.com/v1')), 'none');
  assert.equal(
    detectBalancePlatform(profile('https://relay.example.com/v1', { balanceQuery: { platform: 'custom' } })),
    'custom',
  );
  assert.equal(
    detectBalancePlatform(profile('https://openrouter.ai/api/v1', { balanceQuery: { platform: 'none' } })),
    'none',
  );
});

test('余额缓存：5 分钟内复用结果，手动刷新强制重查', async () => {
  const service = new BalanceService();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 2 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const stored = profile('https://openrouter.ai/api/v1');
  const first = await service.check('acct-1', stored, { fetchImpl });
  assert.equal(first?.amount, 8);
  const second = await service.check('acct-1', stored, { fetchImpl });
  assert.equal(second?.amount, 8);
  assert.equal(calls, 1, '缓存命中不应重复请求');
  await service.check('acct-1', stored, { fetchImpl, force: true });
  assert.equal(calls, 2, '手动刷新应强制重查');
  const failed = await service.check(
    'acct-2',
    profile('https://openrouter.ai/api/v1'),
    { fetchImpl: (async () => new Response('denied', { status: 401 })) as typeof fetch },
  );
  assert.match(failed?.error ?? '', /HTTP 401/);
});
