// Anthropic 思考参数：只接受 adaptive 的型号发 adaptive + output_config.effort；
// 上游 400 提示改用 adaptive 时按提示重试，不能当成"模型不支持思考强度"静默降级。
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { streamChat } from '../src/providers/index.js';
import type { StoredProfile } from '../src/types.js';

interface Captured {
  body: Record<string, any>;
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const OK_STREAM = sse([
  { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]);

async function withServer(
  respond: (captured: Captured, attempt: number) => { status: number; body: string },
  run: (baseUrl: string, captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const entry: Captured = { body: JSON.parse(raw) };
      captured.push(entry);
      const out = respond(entry, captured.length);
      res.writeHead(out.status, { 'content-type': out.status === 200 ? 'text/event-stream' : 'application/json' });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, captured);
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

async function requestBlocks(baseUrl: string, model: string, onEffortDropped: () => void) {
  const blocks: unknown[] = [];
  await request(baseUrl, model, onEffortDropped, blocks);
  return blocks;
}

function request(baseUrl: string, model: string, onEffortDropped: () => void, blocks: unknown[] = [], effort: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'medium') {
  return streamChat({
    profile: profileAt(baseUrl),
    model,
    system: 'sys',
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 1 },
    ] as any,
    tools: [],
    blocks: blocks as any,
    signal: new AbortController().signal,
    idleTimeoutSec: 30,
    maxTokens: 8192,
    effort,
    onEffortDropped,
    onRateLimit: () => {},
    onBlockStart: () => {},
    onText: () => {},
    onToolInput: () => {},
  });
}

const REJECTED_ENABLED =
  '{"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.enabled\\" is not supported for this model. Use \\"thinking.type.adaptive\\" and \\"output_config.effort\\" to control thinking behavior."}}';

test('adaptive 型号发送 thinking.adaptive + summarized + output_config.effort，不带 budget_tokens', async () => {
  let dropped = 0;
  await withServer(
    () => ({ status: 200, body: OK_STREAM }),
    async (baseUrl, captured) => {
      const blocks = await requestBlocks(baseUrl, 'claude-opus-5-5', () => dropped++);
      assert.equal(captured.length, 1);
      assert.deepEqual(captured[0]!.body.thinking, { type: 'adaptive', display: 'summarized' });
      assert.deepEqual(captured[0]!.body.output_config, { effort: 'medium' });
      assert.equal(captured[0]!.body.thinking.budget_tokens, undefined);
      assert.deepEqual(blocks, [{ type: 'text', text: 'ok' }]);
    },
  );
  assert.equal(dropped, 0);
});

test('adaptive 型号的 xhigh / max 原样作为 effort 发送', async () => {
  for (const effort of ['xhigh', 'max'] as const) {
    await withServer(
      () => ({ status: 200, body: OK_STREAM }),
      async (baseUrl, captured) => {
        await request(baseUrl, 'claude-sonnet-5-5', () => {}, [], effort);
        assert.deepEqual(captured[0]!.body.thinking, { type: 'adaptive', display: 'summarized' });
        assert.deepEqual(captured[0]!.body.output_config, { effort });
      },
    );
  }
});

test('显式关闭：支持 disabled 的 adaptive 型号发 thinking.disabled，不支持的型号不发 thinking', async () => {
  await withServer(
    () => ({ status: 200, body: OK_STREAM }),
    async (baseUrl, captured) => {
      await request(baseUrl, 'claude-opus-5', () => {}, [], 'off');
      assert.deepEqual(captured[0]!.body.thinking, { type: 'disabled' });
      assert.equal(captured[0]!.body.output_config, undefined);
    },
  );
  await withServer(
    () => ({ status: 200, body: OK_STREAM }),
    async (baseUrl, captured) => {
      // Sonnet 5.5 不能关闭思考；菜单也不提供「关」，兼容旧会话里残留的 off 时不发参数。
      await request(baseUrl, 'claude-sonnet-5-5', () => {}, [], 'off');
      assert.equal(captured[0]!.body.thinking, undefined);
      assert.equal(captured[0]!.body.output_config, undefined);
    },
  );
});

test('manual 型号仍发送 budget_tokens', async () => {
  await withServer(
    () => ({ status: 200, body: OK_STREAM }),
    async (baseUrl, captured) => {
      await request(baseUrl, 'claude-sonnet-4-5', () => {});
      assert.deepEqual(captured[0]!.body.thinking, { type: 'enabled', budget_tokens: 8192 });
      assert.equal(captured[0]!.body.output_config, undefined);
    },
  );
});

test('上游提示 thinking.type.enabled 不支持：改用 adaptive 重试成功，不计为降级', async () => {
  let dropped = 0;
  await withServer(
    (_captured, attempt) => (attempt === 1 ? { status: 400, body: REJECTED_ENABLED } : { status: 200, body: OK_STREAM }),
    async (baseUrl, captured) => {
      const blocks = await requestBlocks(baseUrl, 'claude-sonnet-4-5', () => dropped++);
      assert.equal(captured.length, 2);
      assert.deepEqual(captured[1]!.body.thinking, { type: 'adaptive', display: 'summarized' });
      assert.deepEqual(captured[1]!.body.output_config, { effort: 'medium' });
      assert.deepEqual(blocks, [{ type: 'text', text: 'ok' }]);
    },
  );
  assert.equal(dropped, 0);
});

test('与思考无关的 400（如 max_tokens 超限）不被当成思考不支持而降级，原样报错', async () => {
  const maxTokensError = '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 99999 > 64000, which is the maximum allowed"}}';
  let dropped = 0;
  await withServer(
    () => ({ status: 400, body: maxTokensError }),
    async (baseUrl, captured) => {
      await assert.rejects(request(baseUrl, 'claude-opus-5-5', () => dropped++), /max_tokens: 99999/);
      assert.equal(captured.length, 1);
    },
  );
  assert.equal(dropped, 0);
});
