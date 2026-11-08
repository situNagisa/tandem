import assert from 'node:assert/strict';
import test from 'node:test';
import { Inbox } from '../src/inbox.js';

test('回合结束事件携带定位消息 id；看板回合标 silent 只进历史', () => {
  const inbox = new Inbox();
  const normal = inbox.recordTurnEnd('s1', '普通会话', 'done', undefined, {
    messageId: 'u-1',
  });
  const silent = inbox.recordTurnEnd('s2', '看板卡', 'done', undefined, {
    messageId: 'u-2',
    silent: true,
  });
  assert.equal(normal.messageId, 'u-1');
  assert.equal(normal.silent, undefined);
  assert.equal(silent.messageId, 'u-2');
  assert.equal(silent.silent, true);
  assert.deepEqual(
    inbox.snapshot().events.map((event) => event.messageId),
    ['u-1', 'u-2'],
  );
});
