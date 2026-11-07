import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONTEXT_SETTINGS } from '@tandem/protocol';
import { autoCompactDue, autoCompactTriggerTokens } from '../src/context.js';

const settings = { ...DEFAULT_CONTEXT_SETTINGS, autoCompactThreshold: 0.5 };

test('自动压缩：估算偏低时用上一次实际占用触发（中文长会话）', () => {
  // 复现：18k 窗口、50% 阈值；字符估算只有 5k，但上一轮真实输入 11.7k。
  assert.equal(autoCompactTriggerTokens(18000, settings), 9000);
  assert.equal(autoCompactDue(5000, undefined, 18000, settings), false);
  assert.equal(autoCompactDue(5000, 11754, 18000, settings), true);
});

test('自动压缩：压缩后不再用旧基线重复触发', () => {
  assert.equal(autoCompactDue(5000, undefined, 18000, settings), false);
});

test('自动压缩：本轮估算已达到阈值时触发', () => {
  assert.equal(autoCompactDue(9000, undefined, 18000, settings), true);
});
