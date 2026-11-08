import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Message } from '@tandem/protocol';
import { latestCheck } from '../src/board/inspect.js';
import {
  clearCompactionBackup,
  readCompactionBackup,
  writeCompactionBackup,
} from '../src/host/compaction.js';

function message(role: Message['role'], blocks: Message['content'], id = Math.random().toString(36)): Message {
  return { id, role, content: blocks, createdAt: Date.now() };
}

test('lastCheck：摘出最近一次测试命令的结果', () => {
  const messages: Message[] = [
    message('user', [{ type: 'text', text: '跑测试' }]),
    message('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]),
    message('user', [{ type: 'tool_result', toolUseId: 't1', content: '3 passing', isError: false }]),
    message('assistant', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git status' } }]),
    message('user', [{ type: 'tool_result', toolUseId: 't2', content: 'clean' }]),
    message('assistant', [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'pnpm run check' } }]),
    message('user', [{ type: 'tool_result', toolUseId: 't3', content: '1 failing', isError: true }]),
  ];
  const check = latestCheck(messages);
  assert.ok(check);
  assert.equal(check.command, 'pnpm run check');
  assert.match(check.output, /1 failing/);
  assert.equal(check.isError, true);
});

test('lastCheck：没有测试命令时返回 undefined；结果未回来时给出命令本身', () => {
  assert.equal(latestCheck([message('assistant', [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }])]), undefined);
  const pending = latestCheck([message('assistant', [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'go test ./...' } }])]);
  assert.ok(pending);
  assert.equal(pending.command, 'go test ./...');
  assert.equal(pending.isError, false);
});

test('压缩原文留档：写入、读取、清除', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tandem-compact-'));
  try {
    writeCompactionBackup(home, 's-1', {
      noticeId: 'n-1',
      at: 1,
      summary: '摘要',
      messages: [message('user', [{ type: 'text', text: '原文' }])],
    });
    const backup = readCompactionBackup(home, 's-1');
    assert.equal(backup?.noticeId, 'n-1');
    assert.equal(backup?.messages.length, 1);
    clearCompactionBackup(home, 's-1');
    assert.equal(readCompactionBackup(home, 's-1'), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
