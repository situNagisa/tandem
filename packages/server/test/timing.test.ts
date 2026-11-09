import test from 'node:test';
import assert from 'node:assert/strict';
import { requestTiming, toolTiming } from '../src/agent/timing.js';

test('请求耗时与首 token：从请求开始计，TTFT 不超过总耗时', () => {
  assert.deepEqual(requestTiming(1_000, 1_250, 13_300), {
    durationMs: 12_300,
    ttftMs: 250,
  });
  assert.deepEqual(requestTiming(1_000, undefined, 2_000), { durationMs: 1_000 });
});

test('未被回调触发的首 token 时间不会超过总耗时', () => {
  assert.deepEqual(requestTiming(5_000, 3_000, 9_000), {
    durationMs: 4_000,
    ttftMs: 0,
  });
});

test('时钟回拨时耗时夹到 0；工具耗时单独计时', () => {
  assert.deepEqual(requestTiming(10_000, 9_000, 9_500), {
    durationMs: 0,
    ttftMs: 0,
  });
  assert.equal(toolTiming(1_000, 41_000), 40_000);
  assert.equal(toolTiming(5_000, 4_000), 0);
});
