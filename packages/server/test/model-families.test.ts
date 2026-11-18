// 型号按家族 + 版本判定：思考档位、Claude 思考协议、单价。单价只认逐型号收录的官方价。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderKind } from '@tandem/protocol';
import { builtinCapabilities, claudeThinkingMode } from '../src/providers/capabilities.js';
import { resolvePriceForModel } from '../src/usage.js';
import type { StoredProfile } from '../src/types.js';

const MANUAL = ['off', 'low', 'medium', 'high', 'max'];
const ADAPTIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const ADAPTIVE_OFF = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const GPT_MINIMAL = ['minimal', 'low', 'medium', 'high'];

const cases: Array<{
  model: string;
  kind: ProviderKind;
  efforts: string[];
  thinking: 'adaptive' | 'manual' | null;
  price: { input: number; output: number } | null;
}> = [
  { model: 'claude-opus-5-5', kind: 'anthropic', efforts: ADAPTIVE, thinking: 'adaptive', price: { input: 4, output: 20 } },
  { model: 'claude-sonnet-5-5', kind: 'anthropic', efforts: ADAPTIVE, thinking: 'adaptive', price: { input: 2, output: 10 } },
  { model: 'claude-haiku-5', kind: 'anthropic', efforts: ADAPTIVE_OFF, thinking: 'adaptive', price: null },
  { model: 'claude-opus-4-7', kind: 'anthropic', efforts: ADAPTIVE_OFF, thinking: 'adaptive', price: { input: 5, output: 25 } },
  { model: 'claude-fable-5-1', kind: 'anthropic', efforts: ADAPTIVE, thinking: 'adaptive', price: { input: 10, output: 50 } },
  { model: 'claude-opus-4-5-20251101', kind: 'anthropic', efforts: MANUAL, thinking: 'manual', price: { input: 5, output: 25 } },
  { model: 'claude-sonnet-4-5', kind: 'anthropic', efforts: MANUAL, thinking: 'manual', price: { input: 3, output: 15 } },
  { model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', kind: 'anthropic', efforts: MANUAL, thinking: 'manual', price: null },
  { model: 'claude-3-5-sonnet-20241022', kind: 'anthropic', efforts: [], thinking: null, price: { input: 3, output: 15 } },
  { model: 'claude-2.1', kind: 'anthropic', efforts: [], thinking: null, price: null },
  { model: 'claude-opus-5-5', kind: 'openai-compatible', efforts: ['low', 'medium', 'high'], thinking: 'adaptive', price: { input: 4, output: 20 } },
  { model: 'gpt-6-luna', kind: 'openai', efforts: GPT_MINIMAL, thinking: null, price: { input: 0.1, output: 0.5 } },
  { model: 'gpt-7-luna', kind: 'openai', efforts: GPT_MINIMAL, thinking: null, price: null },
  { model: 'gpt-4o', kind: 'openai', efforts: [], thinking: null, price: { input: 2.5, output: 10 } },
  { model: 'mystery-model-1', kind: 'openai-compatible', efforts: [], thinking: null, price: null },
];

test('模型名 → 思考档位 / Claude 思考协议 / 单价（单价只认逐型号官方价）', () => {
  for (const row of cases) {
    const resolved = resolvePriceForModel(undefined, row.model);
    const actual = {
      efforts: builtinCapabilities(row.kind, row.model).efforts ?? [],
      thinking: claudeThinkingMode(row.model) ?? null,
      price: resolved ? { input: resolved.price.input, output: resolved.price.output } : null,
    };
    const { model, kind, ...expected } = row;
    assert.deepEqual(actual, expected, `${kind} · ${model}`);
  }
});

test('单价优先级：分组自定义 > 内置官方价；未收录不借价', () => {
  const profile = {
    price: { 'claude-opus-5-5': { input: 2, output: 10 } },
  } as unknown as StoredProfile;
  assert.deepEqual(resolvePriceForModel(profile, 'claude-opus-5-5'), {
    price: { input: 2, output: 10 },
    source: 'custom',
  });
  const sonnet = resolvePriceForModel(profile, 'claude-sonnet-5-5');
  assert.equal(sonnet?.source, 'builtin');
  assert.equal(sonnet?.price.input, 2);
  assert.equal(sonnet?.price.output, 10);
});
