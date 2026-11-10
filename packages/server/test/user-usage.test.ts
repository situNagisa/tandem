import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContentBlock } from '@tandem/protocol';
import { estimateUserUsage } from '../src/host/turns.js';
import type { Host } from '../src/host.js';
import type { SessionRecord, StoredProfile } from '../src/types.js';

function fakeHost(profile?: StoredProfile): Host {
  return {
    profileFor: () => profile,
  } as unknown as Host;
}

const rec = { profileId: 'p', model: 'gpt-4o-mini' } as unknown as SessionRecord;

test('用户消息输入估算：文本按字符/3.5，图片按 1200 token', () => {
  const content: ContentBlock[] = [
    { type: 'text', text: 'a'.repeat(350) },
    { type: 'image', mediaType: 'image/png', dataBase64: 'x' },
  ];
  const usage = estimateUserUsage(fakeHost(), rec, content);
  assert.equal(usage?.inputTokens, 100 + 1_200);
  assert.equal(usage?.outputTokens, 0);
  const unknown = { profileId: 'p', model: 'mystery-model-1' } as unknown as SessionRecord;
  assert.equal(
    estimateUserUsage(fakeHost(), unknown, content)?.costUsd,
    undefined,
    '没有单价时不应猜测金额',
  );
});

test('用户消息输入估算：按模型单价折算金额，倍率由账号配置生效', () => {
  const profile = {
    id: 'p',
    name: '账号',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1/v1',
    apiKey: 'k',
    models: ['gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini',
    createdAt: Date.now(),
    price: { 'gpt-4o-mini': { input: 0.3, output: 1.2 } },
  } as unknown as StoredProfile;
  const usage = estimateUserUsage(fakeHost(profile), rec, [
    { type: 'text', text: 'a'.repeat(3500) },
  ]);
  assert.equal(usage?.inputTokens, 1_000);
  assert.equal(usage?.costUsd, 0.0003);
});

test('用户消息输入估算：空内容不生成用量', () => {
  assert.equal(estimateUserUsage(fakeHost(), rec, []), undefined);
  assert.equal(
    estimateUserUsage(fakeHost(), rec, [{ type: 'tool_result', toolUseId: 't', content: 'ok' }]),
    undefined,
  );
});
