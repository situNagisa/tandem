import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BudgetRule } from '@tandem/protocol';
import { BudgetStore } from '../src/budgets.js';
import { UsageStore } from '../src/usage.js';

function localDay(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-budget-'));
  const usage = new UsageStore(home);
  const budgets = new BudgetStore(home, usage);
  const cleanup = () => {
    usage.flush();
    rmSync(home, { recursive: true, force: true });
  };
  const spend = (costUsd: number, patch: { profileId?: string; groupId?: string; model?: string } = {}) => {
    usage.record({
      hostId: 'h1',
      profileId: patch.profileId ?? 'p1',
      model: patch.model ?? 'gpt-5',
      inputTokens: 10,
      outputTokens: 20,
      costUsd,
      day: localDay(),
      ...(patch.groupId ? { groupId: patch.groupId } : {}),
    });
  };
  return { home, usage, budgets, cleanup, spend };
}

function rule(patch: Partial<BudgetRule>): BudgetRule {
  return {
    id: 'r1',
    scope: 'global',
    period: 'day',
    limitUsd: 10,
    action: 'block',
    ...patch,
  };
}

test('日预算：85% 只到 80 档，105% 到 100 档并阻止请求', (t) => {
  const env = setup();
  t.after(env.cleanup);
  env.spend(8.5);
  env.budgets.replace([rule({ id: 'r80' })]);
  let status = env.budgets.status()[0]!;
  assert.equal(status.spentUsd, 8.5);
  assert.equal(status.percent, 85);
  assert.equal(status.level, '80');
  assert.equal(status.blocked, false);

  env.spend(2);
  env.budgets.replace([rule({ id: 'r100' })]);
  status = env.budgets.status()[0]!;
  assert.equal(status.spentUsd, 10.5);
  assert.equal(status.percent, 105);
  assert.equal(status.level, '100');
  assert.equal(status.blocked, true);
  assert.ok(status.resetAt > Date.now());
});

test('warn 规则达到 100% 只提醒不阻止；停用规则不告警', (t) => {
  const env = setup();
  t.after(env.cleanup);
  env.spend(12);
  env.budgets.replace([
    rule({ id: 'warn', action: 'warn' }),
    rule({ id: 'off', enabled: false }),
  ]);
  const [warn, off] = env.budgets.status();
  assert.equal(warn?.blocked, false);
  assert.equal(warn?.level, '100');
  assert.equal(off?.level, undefined);
  assert.equal(off?.blocked, false);
});

test('账号 / 分组 / 模型范围只累计匹配的用量', (t) => {
  const env = setup();
  t.after(env.cleanup);
  env.spend(1, { profileId: 'p1', groupId: 'g1', model: 'gpt-5' });
  env.spend(2, { profileId: 'p1', groupId: 'g2', model: 'gpt-5' });
  env.spend(4, { profileId: 'p2', groupId: 'g1', model: 'claude' });
  env.spend(8, { profileId: 'p1', groupId: 'g1', model: 'claude' });

  env.budgets.replace([
    rule({ id: 'global', scope: 'global', limitUsd: 100 }),
    rule({ id: 'account', scope: 'account', profileId: 'p1', limitUsd: 100 }),
    rule({ id: 'group', scope: 'group', profileId: 'p1', groupId: 'g1', limitUsd: 100 }),
    rule({ id: 'model', scope: 'model', model: 'claude', limitUsd: 100 }),
  ]);
  const byId = new Map(env.budgets.status().map((status) => [status.ruleId, status.spentUsd]));
  assert.equal(byId.get('global'), 15);
  assert.equal(byId.get('account'), 11);
  assert.equal(byId.get('group'), 9);
  assert.equal(byId.get('model'), 12);
});

test('block 规则按会话上下文匹配，limit 边界 100% 触发阻止', (t) => {
  const env = setup();
  t.after(env.cleanup);
  env.spend(10, { profileId: 'p1', groupId: 'g1', model: 'gpt-5' });
  env.budgets.replace([rule({ id: 'g', scope: 'group', profileId: 'p1', groupId: 'g1' })]);
  const hit = env.budgets.blockingRule({ profileId: 'p1', groupId: 'g1', model: 'gpt-5' });
  assert.equal(hit?.ruleId, 'g');
  assert.equal(
    env.budgets.blockingRule({ profileId: 'p1', groupId: 'g2', model: 'gpt-5' }),
    undefined,
  );
});

test('停用或删除 block 规则后不再阻止请求（反馈0220#02）', (t) => {
  const env = setup();
  t.after(env.cleanup);
  env.spend(12);
  const context = { profileId: 'p1', groupId: 'g1', model: 'gpt-5' };
  env.budgets.replace([rule({ id: 'r1' })]);
  assert.equal(env.budgets.blockingRule(context)?.ruleId, 'r1');

  env.budgets.replace([rule({ id: 'r1', enabled: false })]);
  assert.equal(env.budgets.blockingRule(context), undefined);
  assert.equal(env.budgets.status()[0]?.blocked, false);

  env.budgets.replace([rule({ id: 'r1' })]);
  env.budgets.replace([]);
  assert.equal(env.budgets.blockingRule(context), undefined);
  assert.deepEqual(env.budgets.list(), []);
});

test('告警同一周期同档只报一次', (t) => {
  const env = setup();
  t.after(env.cleanup);
  env.spend(9);
  env.budgets.replace([rule({ id: 'r1', action: 'warn' })]);
  const first = env.budgets.observe();
  assert.equal(first.length, 1);
  assert.equal(first[0]?.level, '80');
  assert.equal(env.budgets.observe().length, 0);
});

test('规则校验：非法范围/周期/动作/上限与缺失 ID', (t) => {
  const env = setup();
  t.after(env.cleanup);
  assert.throws(
    () => env.budgets.replace([{ ...rule({}), scope: 'team' } as unknown as BudgetRule]),
    /预算范围无效/,
  );
  assert.throws(
    () => env.budgets.replace([{ ...rule({}), period: 'year' } as unknown as BudgetRule]),
    /预算周期无效/,
  );
  assert.throws(
    () => env.budgets.replace([{ ...rule({}), action: 'nuke' } as unknown as BudgetRule]),
    /预算动作无效/,
  );
  assert.throws(() => env.budgets.replace([rule({ limitUsd: 0 })]), /预算上限必须大于 0/);
  assert.throws(
    () => env.budgets.replace([rule({ scope: 'group', profileId: 'p1' })]),
    /分组范围需要 profileId 与 groupId/,
  );
});
