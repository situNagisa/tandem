import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/store.js';
import type { SessionRecord } from '../src/types.js';
import {
  sessionTurns,
  tailMessages,
  truncateLargeToolOutputs,
} from '../src/host/message-paging.js';
import type { Message } from '@tandem/protocol';

function message(id: string, text: string): Message {
  return { id, role: 'user', createdAt: 1, content: [{ type: 'text', text }] };
}

function record(id: string, messages: Message[]): SessionRecord {
  return {
    id,
    title: 'paging',
    cwd: '/tmp',
    profileId: 'p',
    model: 'm',
    permissionMode: 'default',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages,
    todos: [],
    allowedTools: [],
  };
}

test('JSONL 倒序读取：尾部与 before 翻页', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-paging-'));
  try {
    const store = new SessionStore(home);
    const messages = Array.from({ length: 500 }, (_, i) =>
      message(`m${i}`, `第 ${i} 条 ${'x'.repeat(900)}`),
    );
    const rec = record('log', messages);
    store.add(rec);
    store.saveNow(rec.id);

    // 最后一条原地更新：必须取到最后版本，且不重复。
    rec.messages[499] = message('m499', 'updated tail');
    store.saveNow(rec.id);

    const tail = store.readMessagePage(rec.id, { limit: 10 });
    assert.ok(tail);
    assert.deepEqual(
      tail.messages.map((m) => m.id),
      Array.from({ length: 10 }, (_, i) => `m${490 + i}`),
    );
    assert.equal(tail.messages[9]!.content[0]!.type === 'text' ? tail.messages[9]!.content[0]!.text : '', 'updated tail');
    assert.equal(tail.hasEarlier, true);

    const before = store.readMessagePage(rec.id, { beforeId: 'm450', limit: 5 });
    assert.ok(before);
    assert.deepEqual(before.messages.map((m) => m.id), ['m445', 'm446', 'm447', 'm448', 'm449']);
    assert.equal(before.hasEarlier, true);

    const start = store.readMessagePage(rec.id, { beforeId: 'm3', limit: 5 });
    assert.ok(start);
    assert.deepEqual(start.messages.map((m) => m.id), ['m0', 'm1', 'm2']);
    assert.equal(start.hasEarlier, false);

    assert.equal(store.readMessagePage(rec.id, { beforeId: 'missing', limit: 5 }), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('尾部截取同时受条数与体积限制', () => {
  const messages = Array.from({ length: 100 }, (_, i) =>
    message(`m${i}`, i >= 95 ? 'y'.repeat(600_000) : 'small'),
  );
  const tail = tailMessages(messages, 10, 2 * 1024 * 1024);
  assert.ok(tail.length <= 10);
  assert.equal(tail[tail.length - 1]!.id, 'm99');
  assert.ok(tail.length <= 4, '大消息应触发体积上限');
});

test('超大工具输出只保留首尾并记录省略字节', () => {
  const content = `HEAD${'a'.repeat(100_000)}TAIL`;
  const input: Message[] = [
    {
      id: 'tr',
      role: 'user',
      createdAt: 1,
      content: [{ type: 'tool_result', toolUseId: 'call', content }],
    },
  ];
  const out = truncateLargeToolOutputs(input);
  const block = out[0]!.content[0]!;
  assert.equal(block.type, 'tool_result');
  if (block.type !== 'tool_result') return;
  assert.ok(block.truncated);
  assert.ok(block.content.length < 20_000);
  assert.ok(block.content.startsWith('HEAD'));
  assert.ok(block.content.endsWith('TAIL'));
  assert.equal(block.truncated?.totalBytes, Buffer.byteLength(content));
  assert.ok((block.truncated?.omittedBytes ?? 0) > 80_000);
  // 原消息不被修改（Host 侧仍保留全文）
  assert.equal((input[0]!.content[0] as { content: string }).content, content);
});

test('轮次大纲只取用户消息前 80 字', () => {
  const long = '第一行 ' + '很长的内容'.repeat(30);
  const turns = sessionTurns([
    message('u1', long),
    { id: 'a1', role: 'assistant', createdAt: 2, content: [{ type: 'text', text: '回答' }] },
    { id: 'u2', role: 'user', createdAt: 3, content: [{ type: 'tool_result', toolUseId: 'x', content: 'out' }] },
    { id: 'u3', role: 'user', createdAt: 4, content: [{ type: 'image', mediaType: 'image/png', dataBase64: '' }] },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.messageId, 'u1');
  assert.equal(turns[0]!.preview.length, 81);
  assert.equal(turns[1]!.preview, '图片');
});
