// 1M 上下文：只有需要 beta 的型号（Opus 4.6 / Sonnet 4.6）在会话选 1M 时加 anthropic-beta 头。
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { CONTEXT_1M_BETA } from '../src/providers/capabilities.js';
import { streamChat } from '../src/providers/index.js';
import type { StoredProfile } from '../src/types.js';

const OK_STREAM = [
  { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join('');

async function withServer(
  run: (baseUrl: string, headers: http.IncomingHttpHeaders[]) => Promise<void>,
): Promise<void> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(OK_STREAM);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function profileAt(baseUrl: string): StoredProfile {
  return {
    id: 'p1',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl,
    apiKey: 'sk-test',
    models: [],
    defaultModel: '',
    createdAt: 1,
  } as StoredProfile;
}

async function request(baseUrl: string, model: string, longContext?: boolean): Promise<void> {
  await streamChat({
    profile: profileAt(baseUrl),
    model,
    system: 'sys',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 1 }],
    tools: [],
    blocks: [],
    signal: new AbortController().signal,
    idleTimeoutSec: 30,
    maxTokens: 1024,
    ...(longContext !== undefined ? { longContext } : {}),
    onBlockStart: () => {},
    onText: () => {},
    onToolInput: () => {},
  });
}

test('Sonnet 4.6 选 1M 时带 context-1m beta，200K/默认不带', async () => {
  await withServer(async (baseUrl, seen) => {
    await request(baseUrl, 'claude-sonnet-4-6', true);
    assert.equal(seen[0]?.['anthropic-beta'], CONTEXT_1M_BETA);
    await request(baseUrl, 'claude-sonnet-4-6', false);
    assert.equal(seen[1]?.['anthropic-beta'], undefined);
    await request(baseUrl, 'claude-sonnet-4-6');
    assert.equal(seen[2]?.['anthropic-beta'], undefined, '4.6 默认 200K，不应带 beta');
  });
});

test('原生 1M 型号切换窗口不改请求：始终不带 beta', async () => {
  await withServer(async (baseUrl, seen) => {
    await request(baseUrl, 'claude-sonnet-5-5', true);
    await request(baseUrl, 'claude-sonnet-5-5', false);
    assert.equal(seen[0]?.['anthropic-beta'], undefined);
    assert.equal(seen[1]?.['anthropic-beta'], undefined);
  });
});

test('Sonnet 4.5 即使残留 1M 选择也不带 beta', async () => {
  await withServer(async (baseUrl, seen) => {
    await request(baseUrl, 'claude-sonnet-4-5', true);
    assert.equal(seen[0]?.['anthropic-beta'], undefined);
  });
});
