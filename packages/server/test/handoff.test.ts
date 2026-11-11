import assert from 'node:assert/strict';
import test from 'node:test';
import { handoffSettings, normalizeHandoffSettings } from '../src/handoff.js';

test('额度交接策略可整体关闭（反馈0220#02）', () => {
  assert.deepEqual(normalizeHandoffSettings({ policy: 'off' }), { policy: 'off' });
  assert.equal(handoffSettings({ policy: 'off' }).policy, 'off');
});

test('未知或缺失的策略回落到询问', () => {
  assert.equal(handoffSettings(undefined).policy, 'ask');
  assert.equal(handoffSettings({ policy: 'nope' }).policy, 'ask');
  assert.equal(handoffSettings({ policy: 'switch' }).policy, 'switch');
  assert.equal(handoffSettings({ policy: 'wait' }).policy, 'wait');
});
