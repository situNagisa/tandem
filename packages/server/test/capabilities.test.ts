import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANTHROPIC_THINKING_BUDGETS,
  applyModelCapabilities,
  builtinCapabilities,
  openaiReasoningEffort,
  resolveEfforts,
} from '../src/providers/capabilities.js';

test('OpenAI 推理模型按模型返回真实 reasoning_effort 档位', () => {
  const gpt5 = builtinCapabilities('openai', 'gpt-5.2');
  assert.deepEqual(gpt5.efforts, ['minimal', 'low', 'medium', 'high']);
  assert.ok(!gpt5.efforts?.includes('off'));
  assert.equal(gpt5.effortLabels?.minimal, '极低 · minimal');
  assert.equal(openaiReasoningEffort('openai', 'gpt-5.2', 'minimal'), 'minimal');
  assert.equal(openaiReasoningEffort('openai', 'gpt-5.2', 'high'), 'high');
  assert.equal(openaiReasoningEffort('openai', 'gpt-5.2', 'off'), undefined);
  assert.equal(openaiReasoningEffort('openai', 'gpt-5.2', 'max'), undefined);

  const o3 = builtinCapabilities('openai', 'o3');
  assert.deepEqual(o3.efforts, ['low', 'medium', 'high']);
  assert.equal(openaiReasoningEffort('openai', 'o3', 'minimal'), undefined);
  assert.equal(openaiReasoningEffort('openai', 'o3', 'medium'), 'medium');

  const gpt4o = builtinCapabilities('openai', 'gpt-4o');
  assert.deepEqual(gpt4o.efforts, []);
});

test('Anthropic 支持 extended thinking 的型号使用 budget 预设', () => {
  const caps = builtinCapabilities('anthropic', 'claude-sonnet-4-5');
  assert.deepEqual(caps.efforts, ['off', 'low', 'medium', 'high', 'max']);
  assert.equal(caps.effortLabels?.medium, '中 · 8K');
  assert.equal(ANTHROPIC_THINKING_BUDGETS.low, 2048);
  assert.equal(ANTHROPIC_THINKING_BUDGETS.max, 32000);
  assert.deepEqual(builtinCapabilities('anthropic', 'claude-2.1').efforts, []);
});

test('Grok / Gemini / DeepSeek 各按 API 实际档位', () => {
  assert.deepEqual(builtinCapabilities('openai-compatible', 'grok-3-mini').efforts, ['low', 'high']);
  assert.equal(openaiReasoningEffort('openai-compatible', 'grok-3-mini', 'medium'), undefined);
  assert.deepEqual(builtinCapabilities('openai-compatible', 'grok-4').efforts, ['low', 'medium', 'high']);
  assert.deepEqual(builtinCapabilities('gemini', 'gemini-2.5-pro').efforts, ['low', 'medium', 'high']);
  assert.deepEqual(builtinCapabilities('openai-compatible', 'deepseek-reasoner').efforts, []);
  assert.deepEqual(builtinCapabilities('openai-compatible', 'deepseek-chat').efforts, []);
  assert.deepEqual(builtinCapabilities('openai-compatible', 'qwen-max').efforts, []);
});

test('未知模型不猜思考档位；账号覆盖与 provider 返回优先', () => {
  assert.deepEqual(builtinCapabilities('openai-compatible', 'my-gateway-model').efforts, []);
  assert.deepEqual(
    resolveEfforts('openai-compatible', 'my-gateway-model', {
      'my-gateway': { efforts: ['low', 'medium', 'high'], effortLabels: { high: '高 · high' } },
    }),
    ['low', 'medium', 'high'],
  );
  const info = applyModelCapabilities(
    { id: 'gpt-5.2' },
    'openai',
    { 'gpt-5.2': { efforts: ['low', 'high'] } },
    { efforts: ['minimal', 'medium'], effortLabels: { medium: '中 · provider' } },
  );
  assert.deepEqual(info.efforts, ['low', 'high'], '账号覆盖应优先于 provider 与内置表');
  assert.deepEqual(info.effortLabels, { medium: '中 · provider' });

  const provider = applyModelCapabilities(
    { id: 'custom-reasoner' },
    'openai-compatible',
    undefined,
    { efforts: ['low', 'high'], effortLabels: { low: '低 · low' } },
  );
  assert.deepEqual(provider.efforts, ['low', 'high'], 'provider 返回的能力应覆盖内置表');
  assert.deepEqual(provider.effortLabels, { low: '低 · low' });
});
