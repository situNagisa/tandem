import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRoutingSettings } from '@tandem/protocol';
import type { Host } from '../src/host.js';
import type { SessionRecord } from '../src/types.js';
import {
  chooseAutoRoute,
  inferRouteDomain,
  learnedKeyFor,
  noteTurnEnd,
  planTurnRoute,
  recentToolInputs,
  type RouteSignals,
} from '../src/model-routing.js';
import { normalizeRoutingSettings } from '../src/routing-settings.js';

const price = {
  strong: { input: 10, output: 30 },
  cheap: { input: 0.1, output: 0.2 },
  kimi: { input: 4, output: 12 },
  mid: { input: 1, output: 3 },
};

function fakeHost(routing: ModelRoutingSettings): Host {
  const profile = {
    id: 'p1',
    name: '测试账号',
    kind: 'openai-compatible' as const,
    apiKey: 'k',
    baseUrl: 'http://127.0.0.1:1',
    models: ['strong', 'cheap', 'kimi', 'mid'],
    defaultModel: 'strong',
    price,
    createdAt: 0,
  };
  return {
    config: { hostId: 'h', token: 't', modelRouting: routing },
    settings: () => ({}),
    profileFor: (id: string) => (id === 'p1' ? profile : undefined),
    groupFor: () => undefined,
    keyCandidates: () => ({ candidates: [{ profile }] }),
    budgets: {
      status: () => [],
      blockingRule: () => undefined,
    },
    estimateQuota: () => ({}),
    delegationFor: () => 'more',
  } as unknown as Host;
}

function rec(text: string, contextTokens = 0): SessionRecord {
  return {
    id: 's1',
    title: 't',
    cwd: '/tmp',
    profileId: 'p1',
    model: 'strong',
    autoRoute: true,
    permissionMode: 'default',
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    todos: [],
    allowedTools: [],
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text }],
        createdAt: 0,
      },
    ],
    context: contextTokens
      ? { model: 'strong', contextWindow: 200000, usedTokens: contextTokens, parts: [], updatedAt: 0 }
      : undefined,
  } as unknown as SessionRecord;
}

const routing: ModelRoutingSettings = {
  preference: 'balanced',
  candidates: [
    { profileId: 'p1', model: 'strong', tier: 'power' },
    { profileId: 'p1', model: 'cheap', tier: 'fast' },
    { profileId: 'p1', model: 'kimi', tier: 'balanced' },
    { profileId: 'p1', model: 'mid', tier: 'balanced' },
  ],
  division: {
    planner: { profileId: 'p1', model: 'strong', tier: 'power' },
    executor: { profileId: 'p1', model: 'cheap', tier: 'fast' },
    domains: [
      {
        profileId: 'p1',
        model: 'kimi',
        domain: 'ui',
        minComplexity: 55,
        note: '前端强项',
      },
    ],
    planThreshold: 55,
  },
};

test('偏好设置：没有候选池时仍保存非默认偏好，默认值才视为未启用（R17）', () => {
  assert.equal(
    normalizeRoutingSettings({ candidates: [], preference: 'balanced' }),
    undefined,
    '默认偏好 + 空候选池应视为未配置',
  );
  const cost = normalizeRoutingSettings({ candidates: [], preference: 'cost' });
  assert.equal(cost?.preference, 'cost', '省钱偏好被丢弃');
  assert.equal(cost?.candidates.length, 0);
  const quality = normalizeRoutingSettings({ candidates: [], preference: 'quality', judge: true });
  assert.equal(quality?.preference, 'quality');
  assert.equal(quality?.judge, true, '判断难度开关被丢弃');
});

test('分工设置归一化：保留角色/领域/确认策略，去重非法领域', () => {
  const normalized = normalizeRoutingSettings({
    ...routing,
    division: {
      ...routing.division,
      confirm: 'expensive',
      confirmOverUsd: 0.08,
      learned: [
        { key: 'ops:装依赖,跑命令', domain: 'ops', mode: 'direct', count: 2, updatedAt: 1 },
        { key: 'x', domain: 'nope' as never, mode: 'direct', count: 3, updatedAt: 1 },
      ],
      domains: [
        ...(routing.division?.domains ?? []),
        { profileId: 'p1', model: 'mid', domain: 'ui', minComplexity: 30 },
        { profileId: 'p1', model: 'mid', domain: 'unknown' as never, minComplexity: 30 },
      ],
    },
  });
  assert.ok(normalized?.division);
  assert.equal(normalized?.division?.domains?.length, 1, '重复/非法领域应被去掉');
  assert.equal(normalized?.division?.confirm, 'expensive');
  assert.equal(normalized?.division?.learned?.length, 1);
});

test('领域推断：消息关键词与最近工具路径', () => {
  assert.equal(inferRouteDomain('修一下前端样式和组件布局'), 'ui');
  assert.equal(inferRouteDomain('安装依赖并跑通构建'), 'ops');
  assert.equal(
    inferRouteDomain('看看这个', ['Read src/components/Button.tsx', 'Bash npm test']),
    'ui',
  );
  const r = rec('x');
  r.messages.push({
    id: 'a1',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'Read',
        input: { file_path: 'src/pages/Home.tsx' },
      },
    ],
    createdAt: 1,
  } as never);
  assert.match(recentToolInputs(r).join(' '), /Home\.tsx/);
});

test('简单任务零派发：问答/改名/解释都直接做', () => {
  const host = fakeHost(routing);
  const plan = (text: string) => planTurnRoute(host, rec(text), { text });
  assert.equal(plan('解释一下这个函数的作用')?.mode, 'direct');
  assert.equal(plan('把变量 foo 改名为 bar')?.mode, 'direct');
  assert.equal(plan('为什么这里会死锁？')?.mode, 'direct');
});

test('机械任务便宜直做；多步批量任务分工；专长领域命中', () => {
  const host = fakeHost(routing);
  const cheap = planTurnRoute(host, rec('安装依赖并跑通构建'), {
    text: '安装依赖并跑通构建',
  });
  assert.equal(cheap?.mode, 'cheap');
  assert.equal(cheap?.executorModel, 'cheap');

  const complexText =
    '请帮我修复这个页面的前端样式问题，批量修改所有组件的布局与颜色，然后跑一遍 lint 和测试，最后把结果整理出来。';
  const division = planTurnRoute(host, rec(complexText, 70_000), { text: complexText });
  assert.equal(division?.mode, 'division');
  assert.equal(division?.specialist, true);
  assert.equal(division?.specialistModel, 'kimi');
});

test('用户覆盖优先，学到的偏好会让同类任务默认直接做', () => {
  const host = fakeHost(routing);
  const text = '安装依赖并跑通构建';
  const override = planTurnRoute(host, rec(text), { text, override: 'direct' });
  assert.equal(override?.mode, 'direct');
  assert.equal(override?.source, 'override');

  const learnedRouting: ModelRoutingSettings = {
    ...routing,
    division: {
      ...routing.division,
      learned: [
        {
          key: learnedKeyFor(text, 'ops'),
          domain: 'ops',
          mode: 'direct',
          count: 2,
          updatedAt: Date.now(),
        },
      ],
    },
  };
  const learned = planTurnRoute(fakeHost(learnedRouting), rec(text), { text });
  assert.equal(learned?.mode, 'direct');
  assert.match(learned?.reason ?? '', /同类任务/);
});

test('自动路由：连续 3 轮简单成功后从升级档位回落一档', () => {
  const host = fakeHost(routing);
  const r = rec('简单总结一下');
  r.routeState = {
    tierBias: 1,
    simpleSuccesses: 0,
    toolFailStreak: 0,
    lastFailed: false,
    lastTier: 'balanced',
    lastModel: 'mid',
  };
  const signals = (): RouteSignals => ({
    messageText: '简单总结一下',
    hasImage: false,
    contextTokens: 0,
    previousFailed: false,
    uncertain: false,
    toolDepth: 0,
    delegation: 'more',
    subagent: false,
  });

  const escalated = chooseAutoRoute(host, r, signals());
  assert.equal(escalated?.tier, 'balanced', '回落前应保持升级后的档位');

  noteTurnEnd(r, 'done', 'balanced', false);
  noteTurnEnd(r, 'done', 'balanced', false);
  assert.equal(
    chooseAutoRoute(host, r, signals())?.tier,
    'balanced',
    '连续成功不足 3 轮时不应回落',
  );

  noteTurnEnd(r, 'done', 'balanced', false);
  const downgraded = chooseAutoRoute(host, r, signals());
  assert.equal(downgraded?.tier, 'fast', '连续 3 轮简单成功后应回落一档');
  assert.equal(downgraded?.scores.downgraded, true);
  assert.match(downgraded?.reason ?? '', /回落/);
  assert.equal(r.routeState?.tierBias, 0);
});
