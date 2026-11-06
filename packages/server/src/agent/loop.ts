// Agent 循环：用户消息 -> 模型 -> 执行工具 -> 回填 tool_result -> 继续，直到没有工具调用。
import { randomUUID } from 'node:crypto';
import type { ContentBlock, Message } from '@tandem/protocol';
import type { Host } from '../host.js';
import type { SessionRecord } from '../types.js';
import { streamChat } from '../providers/index.js';
import { TOOLS, executeTool } from '../tools/index.js';
import { errorMessage, truncateMiddle } from '../util/text.js';
import { buildSystemPrompt } from './prompt.js';

const MAX_ITERATIONS = 100;
const MAX_TOKENS = 8192;
/** 这些工具之间没有副作用，可以并行执行。 */
const PARALLEL_TOOLS = new Set(['Read', 'Glob', 'Grep']);

export async function runTurn(host: Host, rec: SessionRecord): Promise<void> {
  const rt = host.ensureRuntime(rec.id);
  if (rt.running || rt.deleted) return;
  rt.running = true;
  rt.interrupted = false;
  const abort = new AbortController();
  rt.abort = abort;

  let reason: 'done' | 'interrupted' | 'error' = 'done';
  let errorText: string | undefined;
  let loopCompleted = false;

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (rt.interrupted || abort.signal.aborted) {
        reason = 'interrupted';
        break;
      }

      host.setStatus(rec, 'running');
      const profile = host.profileFor(rec.profileId, rec.groupId);
      if (!profile) throw new Error('当前会话的账号不存在，请在界面上重新选择账号');
      const model = rec.model || profile.defaultModel;
      if (!model) throw new Error('当前账号没有配置模型');
      if (!profile.apiKey) throw new Error('当前账号没有配置 API Key');

      const assistant: Message = {
        id: randomUUID(),
        role: 'assistant',
        content: [],
        createdAt: Date.now(),
        model,
      };
      rec.messages.push(assistant);
      host.hub.broadcastSession(rec.id, {
        type: 'message_start',
        sessionId: rec.id,
        message: assistant,
      });

      let result: Awaited<ReturnType<typeof streamChat>> | undefined;
      try {
        result = await streamChat({
          profile,
          model,
          system: buildSystemPrompt(rec.cwd),
          // 排除刚插入的空 assistant 占位
          messages: rec.messages.slice(0, -1),
          tools: TOOLS,
          blocks: assistant.content,
          signal: abort.signal,
          maxTokens: MAX_TOKENS,
          onBlockStart: (index, block) => {
            host.hub.broadcastSession(rec.id, {
              type: 'block_delta',
              sessionId: rec.id,
              messageId: assistant.id,
              index,
              delta: { kind: 'block_start', block },
            });
          },
          onText: (index, text) => {
            host.hub.broadcastSession(rec.id, {
              type: 'block_delta',
              sessionId: rec.id,
              messageId: assistant.id,
              index,
              delta: { kind: 'text', text },
            });
          },
          onToolInput: (index, partialJson) => {
            host.hub.broadcastSession(rec.id, {
              type: 'block_delta',
              sessionId: rec.id,
              messageId: assistant.id,
              index,
              delta: { kind: 'tool_input', partialJson },
            });
          },
        });
      } catch (err) {
        if (rt.interrupted || abort.signal.aborted) reason = 'interrupted';
        else {
          reason = 'error';
          errorText = errorMessage(err);
        }
      }

      // 无论成功失败都下发最终消息（失败时可能是部分内容）
      host.hub.broadcastSession(rec.id, {
        type: 'message_end',
        sessionId: rec.id,
        message: assistant,
      });
      host.store.markDirty(rec.id, true);

      if (result) {
        rec.usage.inputTokens += result.usage.inputTokens || 0;
        rec.usage.outputTokens += result.usage.outputTokens || 0;
      }
      host.broadcastSummary(rec);

      if (!result) break;

      if (rt.interrupted || abort.signal.aborted) reason = 'interrupted';

      const toolUses = assistant.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        if (reason !== 'interrupted') reason = 'done';
        loopCompleted = true;
        break;
      }

      const resultBlocks =
        reason === 'interrupted'
          ? toolUses.map<ContentBlock>((t) => ({
              type: 'tool_result',
              toolUseId: t.id,
              content: '用户中断',
              isError: true,
            }))
          : await executeToolUses(host, rec, toolUses, abort.signal);

      const toolMessage: Message = {
        id: randomUUID(),
        role: 'user',
        content: resultBlocks,
        createdAt: Date.now(),
      };
      rec.messages.push(toolMessage);
      host.hub.broadcastSession(rec.id, {
        type: 'message_start',
        sessionId: rec.id,
        message: toolMessage,
      });
      host.hub.broadcastSession(rec.id, {
        type: 'message_end',
        sessionId: rec.id,
        message: toolMessage,
      });
      host.store.markDirty(rec.id, true);
      host.broadcastSummary(rec);

      if (reason === 'interrupted' || abort.signal.aborted) {
        reason = 'interrupted';
        break;
      }
    }

    if (!loopCompleted && reason === 'done') {
      reason = 'error';
      errorText = `超过最大工具调用轮数（${MAX_ITERATIONS}），已停止`;
    }
  } catch (err) {
    if (rt.interrupted || abort.signal.aborted) {
      reason = 'interrupted';
    } else {
      reason = 'error';
      errorText = errorMessage(err);
    }
  } finally {
    rt.running = false;
    rt.abort = undefined;
    host.setStatus(rec, reason === 'error' ? 'error' : 'idle');
    host.store.markDirty(rec.id, true);
    host.hub.broadcastSession(rec.id, {
      type: 'turn_end',
      sessionId: rec.id,
      reason,
      ...(errorText ? { error: errorText } : {}),
    });
    host.broadcastSummary(rec);
    void host.drainQueue(rec.id);
    // 每轮结束刷新 git 环境（分支可能被工具切换过）
    void host.refreshEnv(rec.id);
  }
}

async function executeToolUses(
  host: Host,
  rec: SessionRecord,
  toolUses: Array<Extract<ContentBlock, { type: 'tool_use' }>>,
  signal: AbortSignal,
): Promise<ContentBlock[]> {
  const perTool: ContentBlock[][] = new Array(toolUses.length);
  const parallel: number[] = [];
  const serial: number[] = [];

  toolUses.forEach((tool, index) => {
    if (PARALLEL_TOOLS.has(tool.name)) parallel.push(index);
    else serial.push(index);
  });

  const runOne = async (index: number): Promise<ContentBlock[]> => {
    const tool = toolUses[index];
    if (signal.aborted) {
      return [{ type: 'tool_result', toolUseId: tool.id, content: '用户中断', isError: true }];
    }
    const auth = await host.authorize(rec, tool.name, tool.input, tool.id, signal);
    if (!auth.allowed) {
      return [
        {
          type: 'tool_result',
          toolUseId: tool.id,
          content: auth.reason ?? '操作被拒绝',
          isError: true,
        },
      ];
    }
    const toolCtx = {
      cwd: rec.cwd,
      session: rec,
      signal,
      updateTodos: (todos: SessionRecord['todos']) => host.updateTodos(rec, todos),
      setUsage: (usage: SessionRecord['usage']) => {
        rec.usage.inputTokens += usage.inputTokens;
        rec.usage.outputTokens += usage.outputTokens;
        host.store.markDirty(rec.id, false);
      },
    };
    const res = await executeTool(tool.name, tool.input, toolCtx);
    const content = truncateMiddle(res.content || '(无输出)');
    const blocks: ContentBlock[] = [
      {
        type: 'tool_result',
        toolUseId: tool.id,
        content,
        ...(res.isError ? { isError: true } : {}),
      },
    ];
    if (res.images) blocks.push(...res.images);
    return blocks;
  };

  await Promise.all(
    parallel.map(async (index) => {
      perTool[index] = await runOne(index);
    }),
  );
  for (const index of serial) {
    perTool[index] = await runOne(index);
  }

  return perTool.flat();
}
