import assert from 'node:assert/strict';
import test from 'node:test';
import { nextCronTime, parseCron } from '../src/schedules.js';

test('5 段 cron 解析范围、步长与逗号列表', () => {
  const spec = parseCron('*/15 9-18 1,15 * 1-5');
  assert.equal(spec.hasSeconds, false);
  assert.deepEqual([...spec.minutes], [0, 15, 30, 45]);
  assert.deepEqual([...spec.hours], [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual([...spec.dom], [1, 15]);
  assert.deepEqual([...spec.dow], [1, 2, 3, 4, 5]);
  assert.equal(spec.domAny, false);
  assert.equal(spec.dowAny, false);
});

test('6 段 cron 支持秒，周日 7 归一为 0', () => {
  const spec = parseCron('*/10 * * * * 7');
  assert.equal(spec.hasSeconds, true);
  assert.deepEqual([...spec.seconds!], [0, 10, 20, 30, 40, 50]);
  assert.deepEqual([...spec.dow], [0]);
});

test('下一次运行严格晚于 after，按分钟对齐', () => {
  const after = new Date(2026, 10, 7, 10, 7, 30).getTime();
  const next = nextCronTime('*/15 * * * *', after);
  assert.equal(next, new Date(2026, 10, 7, 10, 15, 0).getTime());
  // 刚好落在刻度上时取下一次
  const exact = new Date(2026, 10, 7, 10, 15, 0).getTime();
  assert.equal(nextCronTime('*/15 * * * *', exact), new Date(2026, 10, 7, 10, 30, 0).getTime());
});

test('6 段 cron 按秒推进（测试模式）', () => {
  const after = new Date(2026, 10, 7, 10, 0, 3, 500).getTime();
  assert.equal(
    nextCronTime('*/10 * * * * *', after),
    new Date(2026, 10, 7, 10, 0, 10, 0).getTime(),
  );
});

test('非法表达式抛错，不存在的日期返回 undefined', () => {
  assert.throws(() => parseCron('* * *'), /cron 需要 5 段/);
  assert.throws(() => parseCron('60 * * * *'), /超出范围/);
  assert.throws(() => parseCron('*/0 * * * *'), /步长/);
  assert.equal(nextCronTime('0 0 31 2 *', new Date(2026, 0, 1).getTime()), undefined);
});
