// 思考参数被上游拒绝时的降级：只有真的去掉参数重试成功才通知；通知里是脱敏后的上游原话，
// 不把"参数格式不对"说成"模型不支持思考强度"。
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { streamChat } from '../src/providers/index.js';
import { summarizeUpstreamRejection } from '../src/upstream/request.js';
import type { StoredProfile } from '../src/types.js';

const ANTHROPIC_OK = [
  { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join('');

const OPENAI_OK = [
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
  'data: [DONE]\n\n',
].join('');

async function withServer(
  respond: (body: Record<string, any>, attempt: number) => { status: number; body: string; type?: string },
  run: (baseUrl: string, bodies: Array<Record<string, any>>) => Promise<void>,
): Promise<void> {
  const bodies: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const out = respond(body, bodies.length);
      res.writeHead(out.status, { 'content-type': out.type ?? (out.status === 200 ? 'text/event-stream' : 'application/json') });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, bodies);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const SECRET = 'sk-relay-secret-9999';

function profile(kind: 'anthropic' | 'openai-compatible', baseUrl: string): StoredProfile {
  return {
    id: 'p1',
    name: 'ai gateway › aws',
    kind,
    baseUrl,
    apiKey: SECRET,
    models: [],
    defaultModel: '',
    createdAt: 1,
  } as StoredProfile;
}

function call(p: StoredProfile, model: string, onEffortDropped: (detail: string) => void) {
  return streamChat({
    profile: p,
    model,
    system: 'sys',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 1 }] as any,
    tools: [],
    blocks: [],
    signal: new AbortController().signal,
    idleTimeoutSec: 30,
    maxTokens: 8192,
    effort: 'medium',
    onEffortDropped,
    onRateLimit: () => {},
    onBlockStart: () => {},
    onText: () => {},
    onToolInput: () => {},
  });
}

test('错误摘要去掉 Key 与地址，并限制长度', () => {
  const text = JSON.stringify({
    error: {
      message: `upstream at https://relay.example.com/v1/chat key ${SECRET} rejected reasoning_effort ${'x'.repeat(300)}`,
    },
  });
  const summary = summarizeUpstreamRejection({ status: 400, text }, [SECRET, 'https://relay.example.com/v1']);
  assert.ok(!summary.includes(SECRET));
  assert.ok(!summary.includes('relay.example.com'));
  assert.ok(summary.includes('reasoning_effort'));
  assert.ok(summary.length <= 200);
});

test('Anthropic 协议：thinking 被上游拒绝后去掉重试成功，通知为上游原话（已脱敏）', async () => {
  const rejection = JSON.stringify({
    error: { message: `thinking is not supported by this relay (key ${SECRET} at http://127.0.0.1:9)` },
  });
  let details: string[] = [];
  await withServer(
    (_body, attempt) => (attempt === 1 ? { status: 400, body: rejection } : { status: 200, body: ANTHROPIC_OK }),
    async (baseUrl, bodies) => {
      await call(profile('anthropic', baseUrl), 'claude-sonnet-4-5', (detail) => details.push(detail));
      assert.equal(bodies.length, 2);
      assert.equal(bodies[1]!.thinking, undefined);
    },
  );
  assert.equal(details.length, 1);
  assert.ok(details[0]!.includes('thinking is not supported by this relay'));
  assert.ok(!details[0]!.includes(SECRET));
  assert.ok(!details[0]!.includes('127.0.0.1'));
});

test('OpenAI 兼容：中转包装后的 reasoning_effort 拒绝，去掉后重试成功并通知原话', async () => {
  const wrapped = JSON.stringify({
    error: {
      message: `上游错误: {"error":{"message":"Unsupported parameter: 'reasoning_effort' for this model"}}`,
    },
  });
  const details: string[] = [];
  await withServer(
    (_body, attempt) => (attempt === 1 ? { status: 400, body: wrapped } : { status: 200, body: OPENAI_OK }),
    async (baseUrl, bodies) => {
      const result = await call(profile('openai-compatible', `${baseUrl}/v1`), 'gpt-6-luna', (detail) =>
        details.push(detail),
      );
      assert.equal(bodies[0]!.reasoning_effort, 'medium');
      assert.equal(bodies[1]!.reasoning_effort, undefined);
      assert.equal(result.stopReason, 'stop');
    },
  );
  assert.equal(details.length, 1);
  assert.ok(details[0]!.includes("Unsupported parameter: 'reasoning_effort'"));
});

test('OpenAI 兼容：与思考无关的 400 不降级，原样报错', async () => {
  const unrelated = JSON.stringify({ error: { message: 'max_tokens is too large for this model' } });
  const details: string[] = [];
  await withServer(
    () => ({ status: 400, body: unrelated }),
    async (baseUrl, bodies) => {
      await assert.rejects(call(profile('openai-compatible', `${baseUrl}/v1`), 'gpt-6-luna', (d) => details.push(d)), /max_tokens is too large/);
      assert.equal(bodies.length, 1);
    },
  );
  assert.deepEqual(details, []);
});
