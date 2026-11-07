import assert from 'node:assert/strict';
import test from 'node:test';
import { decideSchedule, parsePlan, topoOrder, validateDrafts, wouldCycle } from '../src/board/graph.js';

const card = (id: string, deps: string[], status: string, order = 0, retryAt?: number) =>
  ({ id, deps, status, order, ...(retryAt ? { retryAt } : {}) }) as Parameters<typeof decideSchedule>[0]['cards'][number];

const base = { now: 1000, maxParallel: 2, running: 0, globalFree: 6, dirBusy: false, exclusive: () => false };

test('依赖环检测：自依赖、间接环与合法 DAG', () => {
  const cards = [{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['b'] }];
  assert.equal(wouldCycle(cards, 'a', ['c']), true);
  assert.equal(wouldCycle(cards, 'a', ['a']), true);
  assert.equal(wouldCycle(cards, 'c', ['a']), false);
  assert.equal(wouldCycle(cards, 'new', ['c']), false);
});

test('调度：依赖未完成的卡等待，依赖失败标 upstream_failed', () => {
  const cards = [card('a', [], 'running'), card('b', ['a'], 'queued', 1), card('f', [], 'failed'), card('c', ['f'], 'queued', 2)];
  const out = decideSchedule({ ...base, cards, running: 1 });
  assert.deepEqual(out.launch, []);
  assert.equal(out.blocked.get('b'), 'waiting');
  assert.equal(out.blocked.get('c'), 'upstream_failed');
});

test('调度：并发上限与列内顺序；依赖完成的卡立即可启动', () => {
  const cards = [
    card('a', [], 'done'),
    card('x', ['a'], 'queued', 3),
    card('y', [], 'queued', 1),
    card('z', [], 'queued', 2),
  ];
  const out = decideSchedule({ ...base, cards });
  assert.deepEqual(out.launch, ['y', 'z']);
  assert.equal(out.blocked.get('x'), 'slot');
  assert.deepEqual(decideSchedule({ ...base, cards, running: 2 }).launch, []);
  assert.deepEqual(decideSchedule({ ...base, cards, globalFree: 1 }).launch, ['y']);
});

test('调度：重试退避未到点不启动；同目录不用 worktree 的卡互斥', () => {
  const cards = [card('r', [], 'queued', 1, 5000), card('d1', [], 'queued', 2), card('d2', [], 'queued', 3)];
  const out = decideSchedule({ ...base, cards, maxParallel: 4, exclusive: (id) => id.startsWith('d') });
  assert.deepEqual(out.launch, ['d1']);
  assert.equal(out.blocked.get('d2'), 'dir');
  assert.equal(out.blocked.has('r'), false);
  assert.deepEqual(decideSchedule({ ...base, cards: [card('r', [], 'queued', 1, 500)], now: 1000 }).launch, ['r']);
});

test('拓扑序：依赖在前，同层按 order', () => {
  const cards = [
    { id: 't', deps: ['a', 'b'], order: 1 },
    { id: 'b', deps: [], order: 3 },
    { id: 'a', deps: [], order: 2 },
  ];
  assert.deepEqual(topoOrder(cards).map((item) => item.id), ['a', 'b', 't']);
});

test('规划解析：容忍 ```json 围栏与说明文字，校验 ref/依赖/环', () => {
  const raw = '好的：\n```json\n[{"ref":"a","title":"后端","prompt":"写接口"},{"ref":"t","title":"测试","prompt":"写测试","deps":["a"],"gate":true}]\n```';
  const drafts = parsePlan(raw);
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[1]!.deps, ['a']);
  assert.equal(drafts[1]!.gate, true);
  assert.throws(() => parsePlan('不是 JSON'), /JSON/);
  assert.throws(() => parsePlan('[{"ref":"a","title":"x","prompt":"y","deps":["zz"]}]'), /不存在/);
  assert.throws(
    () => parsePlan('[{"ref":"a","title":"x","prompt":"y","deps":["b"]},{"ref":"b","title":"x2","prompt":"y","deps":["a"]}]'),
    /环/,
  );
  assert.throws(() => validateDrafts([{ ref: 'a', title: 't', prompt: 'p', deps: [] }, { ref: 'a', title: 't', prompt: 'p', deps: [] }]), /重复/);
});
