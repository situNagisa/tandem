import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '@tandem/protocol';
import { isSystemInjectionText } from '@tandem/protocol';
import {
  cleanTitle,
  cleanUserBlocks,
  extractInjected,
  isInjectedTitle,
  titleFromMessages,
  usageFromClaude,
  usageFromCodex,
} from '../src/external.js';

function userMessage(text: string, id = 'm1'): Message {
  return { id, role: 'user', content: [{ type: 'text', text }], createdAt: 1 };
}

test('注入标题判定只命中标题本身是注入内容的情况', () => {
  assert.equal(isInjectedTitle('# AGENTS.md instructions for /repo'), true);
  assert.equal(isInjectedTitle('  AGENTS.md instructions for C:\\repo  '), true);
  assert.equal(isInjectedTitle('<system-reminder>hello</system-reminder>'), true);
  assert.equal(isInjectedTitle('The following is the Codex agent history'), true);
  assert.equal(isInjectedTitle('This session is being continued from a previous conversation'), true);
  // 正常标题里提到 AGENTS.md 不能误伤（反馈3#3）
  assert.equal(isInjectedTitle('关于 AGENTS.md 的说明'), false);
  assert.equal(isInjectedTitle('如何编写 AGENTS.md instructions'), false);
  assert.equal(isInjectedTitle('修复登录页 401'), false);
});

test('标题从第一条真实用户文本提取，跳过注入消息', () => {
  const messages = [
    userMessage('<system-reminder>环境信息</system-reminder>', 'u1'),
    userMessage('请修复 `登录页` 的 401 错误', 'u2'),
  ];
  assert.equal(titleFromMessages(messages, '/repo', Date.now()), '请修复 登录页 的 401 错误');
});

test('全部消息都是注入时退回项目名 + 日期', () => {
  const created = new Date(2026, 10, 7, 12).getTime();
  const title = titleFromMessages(
    [userMessage('The following is the Codex agent history\n...', 'u1')],
    '/tmp/my-repo',
    created,
  );
  assert.match(title, /my-repo/);
  assert.equal(isInjectedTitle(title), false);
});

test('注入标签收进可折叠上下文，只留用户文本', () => {
  const result = extractInjected(
    '<system-reminder>内部提醒</system-reminder>\n请看一下 @[src/a.ts](src/a.ts) 的实现',
  );
  assert.equal(result.text, '请看一下 src/a.ts 的实现');
  assert.equal(result.contexts.length, 1);
  assert.equal(result.contexts[0]?.kind, 'system-reminder');
  assert.match(result.contexts[0]?.text ?? '', /内部提醒/);
});

test('AGENTS.md 头部与 INSTRUCTIONS 保留为上下文，不进入正文', () => {
  const result = extractInjected(
    '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n使用 pnpm。\n</INSTRUCTIONS>',
  );
  assert.equal(result.text, '');
  assert.equal(result.contexts[0]?.kind, 'AGENTS.md');
  assert.match(result.contexts[0]?.text ?? '', /AGENTS\.md instructions/);
  assert.match(result.contexts[0]?.text ?? '', /使用 pnpm/);
});

test('命令回显折叠为 /命令 参数，未闭合注入标签整块收进上下文', () => {
  const command = extractInjected(
    '<command-name>/model</command-name><command-args>sonnet</command-args>',
  );
  assert.equal(command.text, '/model sonnet');

  const unclosed = extractInjected('<INSTRUCTIONS>\n被截断的说明');
  assert.equal(unclosed.text, '');
  assert.equal(unclosed.contexts[0]?.kind, 'INSTRUCTIONS');
});

test('cleanUserBlocks 丢弃纯注入文本块但保留图片/工具结果', () => {
  const blocks = cleanUserBlocks([
    { type: 'text', text: '<system-reminder>noise</system-reminder>' },
    { type: 'image', mediaType: 'image/png', dataBase64: 'abc' },
    { type: 'tool_result', toolUseId: 't1', content: 'ok' },
  ]);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['context', 'image', 'tool_result'],
  );
});

test('cleanTitle 去 Markdown/ANSI，压空白并截断 60 字', () => {
  assert.equal(cleanTitle('## **修复** [登录](https://x) 页面'), '修复 登录 页面');
  assert.equal(cleanTitle('\u001b[31m红色\u001b[0m 文本'), '红色 文本');
  assert.equal([...cleanTitle('字'.repeat(100))].length, 60);
  assert.equal(cleanTitle('\n\n  \n'), '');
});

test('外部会话解析保留 usage：Claude 缓存字段与 Codex 的含缓存输入', () => {
  assert.deepEqual(
    usageFromClaude({
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 200,
    }),
    { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 3000, cacheWriteTokens: 200 },
  );
  // 全零/缺失时不生成用量，面板与大纲据此隐藏对应项。
  assert.equal(usageFromClaude({ input_tokens: 0, output_tokens: 0 }), undefined);
  assert.equal(usageFromClaude(null), undefined);

  // Codex 的 input_tokens 含缓存，协议 inputTokens 只记未命中部分。
  assert.deepEqual(
    usageFromCodex({ input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 120 }),
    { inputTokens: 1000, outputTokens: 120, cacheReadTokens: 4000 },
  );
  assert.equal(usageFromCodex({ input_tokens: 0, output_tokens: 0 }), undefined);
});

test('Codex 开发者/系统提示归为注入，不冒充用户消息（反馈16#05 / R07）', () => {
  assert.equal(
    isSystemInjectionText('You are Codex, an agent based on GPT-6. You and the user share one workspace.'),
    true,
  );
  assert.equal(isSystemInjectionText('<multi_agent_role>You are `/root`.'), true);
  assert.equal(isSystemInjectionText('<multi_agent_mode>Any earlier instruction'), true);
  assert.equal(isSystemInjectionText('# AGENTS.md instructions for /repo'), true);
  assert.equal(isSystemInjectionText('请根据以下审阅意见修改：package-lock.json'), false);

  const blocks = cleanUserBlocks([
    { type: 'text', text: 'You are Codex, an agent based on GPT-6. You and the user share one workspace.' },
    { type: 'text', text: '<multi_agent_role>You are `/root`, the primary agent.' },
    { type: 'text', text: '真实用户发言' },
  ]);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['context', 'context', 'text'],
  );
  assert.equal(blocks[2]?.type === 'text' ? blocks[2].text : '', '真实用户发言');
});

test('坏标题是 Codex 基础提示时退回项目名 + 日期（反馈16#05）', () => {
  assert.equal(
    isInjectedTitle('You are Codex, an agent based on GPT-6. You and the user sha'),
    true,
  );
  const title = titleFromMessages(
    [userMessage('You are Codex, an agent based on GPT-6. You and the user share one workspace.', 'u1')],
    '/tmp/reg-repo',
    new Date(2026, 10, 10, 12).getTime(),
  );
  assert.match(title, /reg-repo/);
});
