// 共享转发引擎：网关与工作站模型代理都依赖的请求构造、SSE、usage、Key 轮换。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FastifyReply } from 'fastify';
import type { GatewayLogEntry, Usage, WorkspaceModelProxyEvent } from '@tandem/protocol';
import type { Host } from '../src/host.js';
import type { StoredProfile, StoredProfileGroup } from '../src/types.js';
import { UsageStore } from '../src/usage.js';
import { AccountProfileStore } from '../src/workstation/profiles.js';
import { WorkstationUsageStore, streamAccountModel } from '../src/workstation/modelProxy.js';
import { handleGatewayChat } from '../src/gateway/proxy.js';
import type { StoredGatewayToken } from '../src/gateway/store.js';
import { runKeyRotation, type UpstreamCandidate } from '../src/upstream/keys.js';
import { createSseUsageTracker } from '../src/upstream/sse.js';
import { applyAnthropicUsage, applyOpenAiUsage } from '../src/upstream/usage.js';
import { UpstreamAttemptError, buildPassthroughRequest, postWithBodyFallbacks } from '../src/upstream/request.js';

function temp(prefix = 'tandem-upstream-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function profile(baseUrl: string | undefined, patch: Partial<StoredProfile> = {}): StoredProfile {
  return {
    id: 'p1',
    name: '上游账号',
    kind: 'openai-compatible',
    baseUrl,
    apiKey: 'sk-account',
    models: ['m1'],
    defaultModel: 'm1',
    createdAt: 1,
    ...patch,
  };
}

function group(patch: Partial<StoredProfileGroup> = {}): StoredProfileGroup {
  return {
    id: 'g1',
    name: '默认分组',
    apiKey: '',
    models: ['m1'],
    defaultModel: 'm1',
    keys: [
      { id: 'k1', label: '一号', apiKey: 'sk-one' },
      { id: 'k2', label: '二号', apiKey: 'sk-two' },
    ],
    keyStrategy: 'failover',
    ...patch,
  };
}

test('usage：OpenAI 取最大值 / 覆盖两种模式与 cached 别名', () => {
  const merged: Usage = { inputTokens: 0, outputTokens: 0 };
  applyOpenAiUsage(
    { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
    merged,
    { merge: 'max', inputAliases: true, outputAliases: true, cachedAlias: true },
  );
  assert.equal(merged.inputTokens, 6);
  assert.equal(merged.outputTokens, 5);
  assert.equal(merged.cacheReadTokens, 4);
  assert.equal(merged.reasoningTokens, undefined);

  // 网关历史行为：非标准的 cached_tokens 也计入缓存命中。
  applyOpenAiUsage({ prompt_tokens: 8, cached_tokens: 3, completion_tokens: 1 }, merged, { merge: 'max', inputAliases: true, outputAliases: true, cachedAlias: true });
  assert.equal(merged.inputTokens, 6);
  assert.equal(merged.outputTokens, 5);
  assert.equal(merged.cacheReadTokens, 4);

  const replaced: Usage = { inputTokens: 0, outputTokens: 0 };
  applyOpenAiUsage({ prompt_tokens: 10, completion_tokens: 5 }, replaced, { merge: 'replace', cachedAlias: false });
  applyOpenAiUsage({ prompt_tokens: 4, completion_tokens: 2, cached_tokens: 3 }, replaced, { merge: 'replace', cachedAlias: false });
  assert.equal(replaced.inputTokens, 4, 'provider 以最后一条 usage 为准，不认 cached_tokens 别名');
  assert.equal(replaced.outputTokens, 2);
  assert.equal(replaced.cacheReadTokens, 0);

  // provider 只认官方字段名；网关额外识别 input_tokens / output_tokens。
  applyOpenAiUsage({ input_tokens: 7, output_tokens: 3 }, replaced, { merge: 'replace', cachedAlias: false });
  assert.equal(replaced.inputTokens, 0);
  assert.equal(replaced.outputTokens, 2);
  const gatewayAlias: Usage = { inputTokens: 0, outputTokens: 0 };
  applyOpenAiUsage(
    { input_tokens: 7, output_tokens: 3 },
    gatewayAlias,
    { merge: 'max', inputAliases: true, outputAliases: true, cachedAlias: true },
  );
  assert.equal(gatewayAlias.inputTokens, 7);
  assert.equal(gatewayAlias.outputTokens, 3);
});

test('usage：Anthropic 累计取最大，缺字段不覆盖', () => {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  applyAnthropicUsage(
    { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 },
    usage,
  );
  applyAnthropicUsage({ output_tokens: 9 }, usage);
  assert.deepEqual(usage, { inputTokens: 12, outputTokens: 9, cacheReadTokens: 7, cacheWriteTokens: 2 });
});

test('SSE：OpenAI usage 跨块解析，[DONE] 与心跳忽略', () => {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const tracker = createSseUsageTracker('openai', usage);
  const chunks = [
    ': ping\n\n',
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"usage":{"prompt_tokens":1',
    '0,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens":6}}\n\n',
    'data: [DONE]\n\n',
  ];
  for (const chunk of chunks) tracker.push(chunk);
  tracker.end();
  assert.equal(usage.inputTokens, 6);
  assert.equal(usage.outputTokens, 6);
  assert.equal(usage.cacheReadTokens, 4);
});

test('SSE：Anthropic message_start / message_delta 累计', () => {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const tracker = createSseUsageTracker('anthropic', usage);
  tracker.push(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1,"cache_read_input_tokens":3}}}\n\n',
  );
  tracker.push('data: {"type":"message_delta","usage":{"output_tokens":8}}\n\n');
  tracker.end();
  assert.deepEqual(usage, { inputTokens: 20, outputTokens: 8, cacheReadTokens: 3 });
});

test('Key 轮换：retryable 换下一个，不可重试立即停，已输出抛原错误', async () => {
  const candidates: UpstreamCandidate[] = [
    { keyId: 'k1', profile: profile('http://x', { apiKey: 'sk-one' }) },
    { keyId: 'k2', profile: profile('http://x', { apiKey: 'sk-two' }) },
  ];
  const tried: string[] = [];
  const failures: string[] = [];
  const ok = await runKeyRotation({
    candidates,
    signal: new AbortController().signal,
    canRetry: (failure) => failure.retryable,
    onFailure: (failure) => failures.push(failure.keyId ?? ''),
    attempt: async (candidate) => {
      tried.push(candidate.keyId ?? '');
      if (candidate.keyId === 'k1') throw new UpstreamAttemptError('boom', { status: 401, retryable: true });
      return 'done';
    },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(tried, ['k1', 'k2']);
  assert.deepEqual(failures, ['k1']);

  tried.length = 0;
  const fatal = await runKeyRotation({
    candidates,
    signal: new AbortController().signal,
    canRetry: (failure) => failure.retryable,
    attempt: async (candidate) => {
      tried.push(candidate.keyId ?? '');
      throw new UpstreamAttemptError('bad request', { status: 400, retryable: false });
    },
  });
  assert.equal(fatal.ok, false);
  assert.equal(fatal.fatal?.status, 400);
  assert.deepEqual(tried, ['k1'], '不可重试不换 Key');

  const original = new UpstreamAttemptError('stream broke', { status: 502, retryable: true });
  const rethrown = await runKeyRotation({
    candidates,
    signal: new AbortController().signal,
    shouldRethrow: () => true,
    attempt: async () => {
      throw original;
    },
  });
  assert.equal(rethrown.rethrown, true);
  assert.equal(rethrown.last?.error, original);
});

test('请求构造：OpenAI 补 stream_options，Anthropic 透传版本与 beta，缺 baseUrl 为 setup 失败', () => {
  const openai = buildPassthroughRequest({
    profile: profile('https://api.example.com/v1'),
    protocol: 'openai',
    body: { model: 'old', stream: true },
    model: 'm1',
    signal: new AbortController().signal,
  });
  assert.equal(openai.url, 'https://api.example.com/v1/chat/completions');
  assert.deepEqual(openai.body.stream_options, { include_usage: true });
  assert.equal(openai.init.headers && (openai.init.headers as Record<string, string>).authorization, 'Bearer sk-account');

  const anthropic = buildPassthroughRequest({
    profile: profile(undefined, { kind: 'anthropic', baseUrl: undefined }),
    protocol: 'anthropic',
    body: { model: 'old' },
    model: 'm1',
    signal: new AbortController().signal,
    clientHeaders: { anthropicVersion: '2024-01-01', anthropicBeta: 'tools-2024' },
  });
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages');
  const headers = anthropic.init.headers as Record<string, string>;
  assert.equal(headers['anthropic-version'], '2024-01-01');
  assert.equal(headers['anthropic-beta'], 'tools-2024');
  assert.equal(headers['x-api-key'], 'sk-account');

  assert.throws(
    () =>
      buildPassthroughRequest({
        profile: profile(undefined, { baseUrl: undefined }),
        protocol: 'openai',
        body: {},
        model: 'm1',
        signal: new AbortController().signal,
      }),
    (err: unknown) => err instanceof UpstreamAttemptError && err.setup && err.status === 503,
  );
});

test('参数降级：400 stream_options 去掉重试一次，成功回调', async () => {
  const bodies: Array<Record<string, any>> = [];
  let dropped = 0;
  const sent = await postWithBodyFallbacks({
    body: { model: 'm1', stream: true, stream_options: { include_usage: true } },
    send: async (body) => {
      bodies.push(body);
      if (body.stream_options) {
        return new Response('{"error":{"message":"stream_options not supported"}}', { status: 400 });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    fallbacks: [
      {
        applies: (res) => res.status === 400 && /stream_options|include_usage/i.test(res.text),
        drop: (body) => {
          const next = { ...body };
          delete next.stream_options;
          return next;
        },
        onDropped: () => {
          dropped += 1;
        },
      },
    ],
  });
  assert.equal(sent.res.status, 200);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1]?.stream_options, undefined);
  assert.equal(dropped, 1);
});

interface FakeRaw extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  chunks: Buffer[];
  writableEnded: boolean;
  setHeader(name: string, value: string): void;
  write(chunk: Buffer | string): boolean;
  end(): void;
}

function fakeRaw(): FakeRaw {
  const raw = new EventEmitter() as FakeRaw;
  raw.statusCode = 200;
  raw.headers = {};
  raw.chunks = [];
  raw.writableEnded = false;
  raw.setHeader = (name: string, value: string) => {
    raw.headers[name] = value;
  };
  raw.write = (chunk: Buffer | string) => {
    raw.chunks.push(Buffer.from(chunk));
    return true;
  };
  raw.end = () => {
    raw.writableEnded = true;
  };
  return raw;
}

interface ReplyState {
  status: number;
  body?: unknown;
  headers: Record<string, string>;
  hijacked: boolean;
}

function fakeReply(): { reply: FastifyReply; raw: FakeRaw; state: ReplyState } {
  const raw = fakeRaw();
  const state: ReplyState = { status: 200, headers: {}, hijacked: false };
  const reply = {
    raw,
    hijack: () => {
      state.hijacked = true;
    },
    code: (status: number) => {
      state.status = status;
      return reply;
    },
    header: (name: string, value: string) => {
      state.headers[name] = value;
      return reply;
    },
    send: (body: unknown) => {
      state.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, raw, state };
}

interface GatewayHarness {
  host: Host;
  logs: GatewayLogEntry[];
  usage: UsageStore;
  marked: Array<{ keyId: string; status?: number }>;
  successes: string[];
}

function gatewayHarness(baseUrl: string, opts: { profile: StoredProfile; group: StoredProfileGroup; usage: UsageStore }): GatewayHarness {
  const logs: GatewayLogEntry[] = [];
  const marked: Array<{ keyId: string; status?: number }> = [];
  const successes: string[] = [];
  const grant: StoredGatewayToken = {
    id: 't1',
    memberId: 'member-1',
    memberName: '成员甲',
    createdAt: 1,
    rpm: 60,
    allowedModels: [],
    tokenHash: '',
  };
  const host = {
    config: { hostId: 'h1' },
    profileFor: () => ({ ...opts.profile, baseUrl }),
    groupFor: () => opts.group,
    keyCandidates: () => ({
      group: opts.group,
      effective: opts.profile,
      candidates: (opts.group.keys ?? []).map((key) => ({
        keyId: key.id,
        label: key.label,
        profile: { ...opts.profile, baseUrl, apiKey: key.apiKey },
      })),
    }),
    markKeySuccess: (_profileId: string, _groupId: string | undefined, keyId?: string) => {
      if (keyId) successes.push(keyId);
    },
    markKeyFailure: (_profileId: string, _groupId: string | undefined, keyId: string | undefined, err: unknown) => {
      marked.push({ keyId: keyId ?? '', status: (err as { status?: number }).status });
      return true;
    },
    keysUnavailableMessage: () => '分组「默认分组」的所有 Key 都不可用：一号（boom）；二号（boom）',
    budgets: { blockingRule: () => undefined },
    team: { getMember: () => ({ id: 'member-1', name: '成员甲' }) },
    accounts: { authenticate: () => undefined },
    usage: opts.usage,
    gateway: {
      settingsView: () => ({
        enabled: true,
        debugBodies: false,
        routes: [{ id: 'r1', profileId: 'p1', groupId: 'g1', models: ['m1'] }],
      }),
      authenticate: () => grant,
      checkRate: () => 0,
      recordRequest: (entry: GatewayLogEntry) => logs.push(entry),
      recordDebug: () => undefined,
    },
  } as unknown as Host;
  return { host, logs, usage: opts.usage, marked, successes };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

test('网关非流式：原样透传 JSON，按成员记账并解析 usage', async () => {
  const home = temp();
  const requests: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, any> }> = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ headers: req.headers, body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
  });
  const port = await listen(server);
  try {
    const usage = new UsageStore(home);
    const harness = gatewayHarness(`http://127.0.0.1:${port}/v1`, {
      profile: profile(''),
      group: group({ keys: [{ id: 'k1', apiKey: 'sk-one' }] }),
      usage,
    });
    const { reply, state } = fakeReply();
    await handleGatewayChat(
      harness.host,
      { headers: { authorization: 'Bearer tgw_test' }, body: { model: 'm1', messages: [] } } as never,
      reply,
      'openai',
    );
    assert.equal(state.status, 200);
    assert.match(String(state.body), /"usage"/);
    assert.equal(requests[0]?.headers.authorization, 'Bearer sk-one', '上游只看到真实 Key');
    assert.equal(requests[0]?.body.model, 'm1');

    const row = harness.usage.list()[0];
    assert.equal(row?.memberId, 'member-1');
    assert.equal(row?.keyId, 'k1');
    assert.equal(row?.groupId, 'g1');
    assert.equal(row?.inputTokens, 12);
    assert.equal(row?.outputTokens, 4);
    assert.equal(harness.logs.at(-1)?.status, 200);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('网关 SSE：原始字节透传，流结束按 usage 记账', async () => {
  const home = temp();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    res.write('data: {"usage":{"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens":6}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  try {
    const usage = new UsageStore(home);
    const harness = gatewayHarness(`http://127.0.0.1:${port}/v1`, {
      profile: profile(''),
      group: group({ keys: [{ id: 'k1', apiKey: 'sk-one' }] }),
      usage,
    });
    const { reply, raw, state } = fakeReply();
    await handleGatewayChat(
      harness.host,
      { headers: { authorization: 'Bearer tgw_test' }, body: { model: 'm1', stream: true, messages: [] } } as never,
      reply,
      'openai',
    );
    assert.equal(state.hijacked, true);
    assert.equal(raw.statusCode, 200);
    assert.match(raw.headers['content-type'] ?? '', /text\/event-stream/);
    assert.match(raw.chunks.map((chunk) => chunk.toString('utf8')).join(''), /"content":"你"/);
    const row = harness.usage.list()[0];
    assert.equal(row?.inputTokens, 6);
    assert.equal(row?.outputTokens, 6);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('网关上游错误：401 换下一个 Key，400 不换 Key', async () => {
  const home = temp();
  const seen: string[] = [];
  let mode: '401' | '400' = '401';
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const auth = req.headers.authorization ?? '';
    seen.push(auth);
    if (mode === '401' && auth.includes('sk-one')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"invalid api key"}}');
      return;
    }
    if (mode === '400') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"invalid request"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
  });
  const port = await listen(server);
  try {
    const mk = () => {
      const usage = new UsageStore(home);
      const harness = gatewayHarness(`http://127.0.0.1:${port}/v1`, { profile: profile(''), group: group(), usage });
      return harness;
    };
    const rotated = mk();
    const first = fakeReply();
    await handleGatewayChat(
      rotated.host,
      { headers: { authorization: 'Bearer tgw_test' }, body: { model: 'm1', messages: [] } } as never,
      first.reply,
      'openai',
    );
    assert.equal(first.state.status, 200, '第二个 Key 成功');
    assert.deepEqual(seen.map((auth) => auth.replace('Bearer ', '')), ['sk-one', 'sk-two']);
    assert.deepEqual(rotated.marked, [{ keyId: 'k1', status: 401 }]);
    assert.deepEqual(rotated.successes, ['k2']);
    assert.equal(rotated.usage.list()[0]?.keyId, 'k2');

    seen.length = 0;
    mode = '400';
    const rejected = mk();
    const second = fakeReply();
    await handleGatewayChat(
      rejected.host,
      { headers: { authorization: 'Bearer tgw_test' }, body: { model: 'm1', messages: [] } } as never,
      second.reply,
      'openai',
    );
    assert.equal(second.state.status, 400);
    assert.match(JSON.stringify(second.state.body), /上游拒绝请求/);
    assert.equal(seen.length, 1, '400 不换 Key');
    assert.equal(rejected.marked.length, 0);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('网关 Anthropic 非流式：解析 usage 并记账', async () => {
  const home = temp();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 2 } }));
  });
  const port = await listen(server);
  try {
    const usage = new UsageStore(home);
    const anthropicProfile = profile('', { kind: 'anthropic' });
    const harness = gatewayHarness(`http://127.0.0.1:${port}`, {
      profile: anthropicProfile,
      group: group({ kind: 'anthropic', keys: [{ id: 'k1', apiKey: 'sk-one' }] }),
      usage,
    });
    const { reply, state } = fakeReply();
    await handleGatewayChat(
      harness.host,
      { headers: { authorization: 'Bearer tgw_test', 'anthropic-version': '2024-01-01' }, body: { model: 'm1', messages: [] } } as never,
      reply,
      'anthropic',
    );
    assert.equal(state.status, 200);
    const row = harness.usage.list()[0];
    assert.equal(row?.inputTokens, 9);
    assert.equal(row?.outputTokens, 3);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

function mockKeyedProvider(seen: string[]): http.Server {
  return http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const auth = req.headers.authorization ?? '';
    seen.push(auth);
    if (auth.includes('sk-bad')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"invalid api key"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"可用"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
    res.end('data: [DONE]\n\n');
  });
}

test('工作站代理：同组多 Key 轮换，usage 记到 model-usage.json', async () => {
  const home = temp();
  const seen: string[] = [];
  const server = mockKeyedProvider(seen);
  const port = await listen(server);
  try {
    const profiles = new AccountProfileStore(home);
    const created = profiles.create('acct-1', {
      name: '公司中转',
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-account',
      models: ['m1'],
      defaultModel: 'm1',
      groups: [
        {
          name: '默认分组',
          apiKeys: [
            { label: '坏 Key', apiKey: 'sk-bad' },
            { label: '好 Key', apiKey: 'sk-good' },
          ],
          keyStrategy: 'failover',
          models: ['m1'],
          defaultModel: 'm1',
        },
      ],
    });
    const stored = profiles.get('acct-1', created.id)!;
    const keyIds = stored.groups![0]!.keys!.map((key) => key.id);
    const usage = new WorkstationUsageStore(home);
    const events: WorkspaceModelProxyEvent[] = [];
    await streamAccountModel(
      { profiles, usage, accountId: 'acct-1', hostId: 'h1' },
      {
        accountId: 'acct-1',
        profileId: created.id,
        groupId: stored.groups![0]!.id,
        model: 'm1',
        system: '',
        messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '你好' }], createdAt: 1 }],
        tools: [],
        maxTokens: 64,
      },
      (event) => events.push(event),
      new AbortController().signal,
    );
    assert.deepEqual(seen.map((auth) => auth.replace('Bearer ', '')), ['sk-bad', 'sk-good']);
    const text = events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('');
    assert.equal(text, '可用');
    const done = events.find((event) => event.type === 'done') as { usage: Usage; costUsd: number; keyId?: string } | undefined;
    assert.ok(done);
    assert.equal(done!.usage.inputTokens, 5);
    assert.equal(done!.usage.outputTokens, 2);
    assert.equal(done!.keyId, keyIds[1]);
    const rows = usage.rowsFor('acct-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.keyId, keyIds[1]);
    assert.equal(rows[0]?.hostId, 'h1');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('工作站代理：所有 Key 都失败时抛出分组不可用', async () => {
  const home = temp();
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"invalid api key"}}');
  });
  const port = await listen(server);
  try {
    const profiles = new AccountProfileStore(home);
    const created = profiles.create('acct-1', {
      name: '公司中转',
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-account',
      models: ['m1'],
      defaultModel: 'm1',
      groups: [
        {
          name: '默认分组',
          apiKeys: [{ label: '一号', apiKey: 'sk-one' }, { label: '二号', apiKey: 'sk-two' }],
          keyStrategy: 'failover',
          models: ['m1'],
          defaultModel: 'm1',
        },
      ],
    });
    const stored = profiles.get('acct-1', created.id)!;
    const usage = new WorkstationUsageStore(home);
    await assert.rejects(
      streamAccountModel(
        { profiles, usage, accountId: 'acct-1', hostId: 'h1' },
        {
          accountId: 'acct-1',
          profileId: created.id,
          groupId: stored.groups![0]!.id,
          model: 'm1',
          system: '',
          messages: [],
          tools: [],
          maxTokens: 64,
        },
        () => undefined,
        new AbortController().signal,
      ),
      /所有 Key 都不可用/,
    );
    assert.equal(usage.rowsFor('acct-1').length, 0);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
