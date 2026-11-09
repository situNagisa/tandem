import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONTEXT_SETTINGS } from '@tandem/protocol';
import { autoCompactDue, autoCompactTriggerTokens } from '../src/context.js';

const settings = { ...DEFAULT_CONTEXT_SETTINGS, autoCompactThreshold: 0.5 };

test('自动压缩：估算偏低时用上一次实际占用触发（中文长会话）', () => {
  // 复现：18k 窗口、50% 阈值；字符估算只有 5k，但上一轮真实输入 11.7k。
  assert.equal(autoCompactTriggerTokens(18000, settings), 9000);
  assert.equal(autoCompactDue(5000, undefined, 18000, settings), false);
  assert.equal(autoCompactDue(5000, 11754, 18000, settings), true);
});

test('自动压缩：压缩后不再用旧基线重复触发', () => {
  assert.equal(autoCompactDue(5000, undefined, 18000, settings), false);
});

test('自动压缩：本轮估算已达到阈值时触发', () => {
  assert.equal(autoCompactDue(9000, undefined, 18000, settings), true);
});

test('最占空间按用户轮次聚合：该轮总量 + 轮内最大项（反馈8#10）', async () => {
  const { estimateBreakdown, estimateMessagesTokens } = await import('../src/context.js');
  const messages = [
    {
      id: 'u1',
      role: 'user' as const,
      createdAt: 1,
      content: [{ type: 'text' as const, text: '第一轮：读一下这个文件' }],
    },
    {
      id: 'a1',
      role: 'assistant' as const,
      createdAt: 2,
      content: [
        { type: 'text' as const, text: '我先读文件。' },
        { type: 'tool_use' as const, id: 'tu1', name: 'Read', input: { file_path: 'src/long.ts' } },
      ],
    },
    {
      id: 'u2',
      role: 'user' as const,
      createdAt: 3,
      content: [
        { type: 'tool_result' as const, toolUseId: 'tu1', content: 'x'.repeat(700) },
      ],
    },
    {
      id: 'a2',
      role: 'assistant' as const,
      createdAt: 4,
      content: [{ type: 'text' as const, text: '读完了，文件很长。' }],
    },
    {
      id: 'u3',
      role: 'user' as const,
      createdAt: 5,
      content: [{ type: 'text' as const, text: '第二轮：继续' }],
    },
    {
      id: 'a3',
      role: 'assistant' as const,
      createdAt: 6,
      content: [{ type: 'text' as const, text: '好的。' }],
    },
  ];
  const result = estimateBreakdown({
    model: 'gpt-4o',
    system: '',
    tools: [],
    messages,
    cwd: '/tmp',
  });
  assert.equal(result.topTurns?.length, 2);
  const [first, second] = result.topTurns!;
  assert.equal(first!.turn, 1);
  assert.equal(first!.messageId, 'u1');
  assert.equal(first!.preview, '第一轮：读一下这个文件');
  assert.equal(first!.tokens, estimateMessagesTokens(messages.slice(0, 4)));
  assert.equal(second!.turn, 2);
  assert.equal(second!.tokens, estimateMessagesTokens(messages.slice(4)));
  assert.ok(
    first!.tokens > second!.tokens,
    `第一轮应更占空间：${first!.tokens} vs ${second!.tokens}`,
  );
  // 二级明细包含该轮的工具输出与消息，并按 token 降序。
  assert.ok(first!.items.some((item) => item.kind === 'tool_result' && item.tool === 'Read'));
  const tokens = first!.items.map((item) => item.tokens);
  assert.deepEqual(tokens, [...tokens].sort((a, b) => b - a));
  // 纯 tool_result 的 user 消息不能另起一轮。
  assert.equal(result.topTurns!.every((turn) => turn.messageId.startsWith('u')), true);
  assert.equal(result.topTurns!.filter((turn) => turn.turn === 1).length, 1);
});
