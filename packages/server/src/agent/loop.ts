// Agent 循环：用户消息 -> 模型 -> 执行工具 -> 回填 tool_result -> 继续，直到没有工具调用。
import { randomUUID } from 'node:crypto';
import type { ContentBlock, Message } from '@tandem/protocol';
import type { Host } from '../host.js';
import type { SessionRecord } from '../types.js';
import { streamChat } from '../providers/index.js';
import { executeTool } from '../tools/index.js';
import { isReadOnlySubagentInput } from '../tools/task.js';
import { errorMessage, truncateMiddle } from '../util/text.js';
import { costOfUsage, priceForModel } from '../usage.js';
import { cacheHitRateOf, estimateBreakdown } from '../context.js';
import { buildSystemPrompt } from './prompt.js';

const MAX_ITERATIONS = 100;
const MAX_TOKENS = 8192;
/** 这些工具之间没有副作用，可以并行执行。 */
const PARALLEL_TOOLS = new Set(['Read', 'Glob', 'Grep']);

export interface TurnResult {
  reason: 'done' | 'interrupted' | 'error';
  error?: string;
  /** 本轮最后一条 assistant 文本（子代理用于回传结果）。 */
  lastText?: string;
}

export interface TurnOptions {
  /** 子代理会话里不再暴露 Task，防止递归。 */
  allowTask?: boolean;
}

export async function runTurn(
  host: Host,
  rec: SessionRecord,
  options: TurnOptions = {},
): Promise<TurnResult> {
  const rt = host.ensureRuntime(rec.id);
  if (rt.running || rt.deleted) return { reason: 'error', error: '会话正在运行' };
  rt.running = true;
  rt.interrupted = false;
  const abort = new AbortController();
  rt.abort = abort;
  const allowTask = options.allowTask !== false;

  let reason: 'done' | 'interrupted' | 'error' = 'done';
  let errorText: string | undefined;
  let loopCompleted = false;
  let effortDropped = false;
  let effortNoticeShown = false;

  // 按需连接项目级 MCP，并顺带重试之前失败的服务器；失败不影响本轮
  await host.mcp.prepare(rec.cwd).catch(() => {});
  const tools = host.toolDefinitions(rec, allowTask);
  const hookEntries = host.hooks.entriesForRun(rec.cwd);
  let stopHookAttempts = 0;

  // SessionStart：每个会话首次运行时执行一次，stdout/JSON 作为附加上下文
  let sessionStartContext = '';
  if (!rt.sessionStartDone) {
    rt.sessionStartDone = true;
    const start = await host.runHooks(rec, hookEntries, 'SessionStart', {
      source: 'startup',
      signal: abort.signal,
    });
    sessionStartContext = start.contexts.join('\n\n');
  }
  const promptHookContext = [sessionStartContext, rt.pendingHookContext]
    .filter(Boolean)
    .join('\n\n');
  delete rt.pendingHookContext;

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (rt.interrupted || abort.signal.aborted) {
        reason = 'interrupted';
        break;
      }

      host.setStatus(rec, 'running');
      const selection = host.keyCandidates(rec.profileId, rec.groupId);
      const profile = selection.effective ?? host.profileFor(rec.profileId, rec.groupId);
      if (!profile) throw new Error('当前会话的账号不存在，请在界面上重新选择账号');
      const model = rec.model || profile.defaultModel;
      if (!model) throw new Error('当前账号没有配置模型');
      if (!selection.candidates.some((candidate) => candidate.profile.apiKey)) {
        throw new Error(host.keysUnavailableMessage(rec.profileId, rec.groupId) ?? '当前账号没有配置 API Key');
      }
      host.assertBudget(rec, model);

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

      const system = buildSystemPrompt(rec.cwd, {
        allowTask,
        planMode: rec.permissionMode === 'plan',
        hookContext: promptHookContext,
      });
      const requestMessages = rec.messages.slice(0, -1).filter((m) => !m.notice);
      // 请求前估算各部分占用；拿到真实 usage 后再按比例校准
      const contextEstimate = estimateBreakdown({
        model,
        system,
        tools,
        messages: requestMessages,
        cwd: rec.cwd,
        cacheHitRate: cacheHitRateOf(rec.usage),
        providerKind: profile.kind,
        capabilityOverrides: profile.modelCapabilities,
      });
      host.setContext(rec, contextEstimate, false);

      let result: Awaited<ReturnType<typeof streamChat>> | undefined;
      let usedKeyId: string | undefined;
      const keyErrors = new Map<string, string>();
      let lastError: unknown;
      try {
        // 同组多 Key：按策略逐个尝试；仅在尚未输出任何 token 时透明重试
        for (const candidate of selection.candidates) {
          let started = false;
          try {
            result = await streamChat({
              profile: candidate.profile,
              model,
              system,
              messages: requestMessages,
              tools,
              blocks: assistant.content,
              signal: abort.signal,
              idleTimeoutSec: host.config.idleTimeoutSec ?? 180,
              maxTokens: MAX_TOKENS,
              effort: rec.effort,
              onEffortDropped: () => {
                effortDropped = true;
              },
              onBlockStart: (index, block) => {
                started = true;
                host.hub.broadcastSession(rec.id, {
                  type: 'block_delta',
                  sessionId: rec.id,
                  messageId: assistant.id,
                  index,
                  delta: { kind: 'block_start', block },
                });
              },
              onText: (index, text) => {
                started = true;
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
            host.markKeySuccess(rec.profileId, rec.groupId, candidate.keyId);
            usedKeyId = candidate.keyId;
            break;
          } catch (err) {
            lastError = err;
            if (rt.interrupted || abort.signal.aborted) throw err;
            if (candidate.keyId && !started) keyErrors.set(candidate.keyId, errorMessage(err));
            // 已开始输出，或错误不属于 Key 级故障（400 等）：按原错误路径处理
            const retry = !started && host.markKeyFailure(rec.profileId, rec.groupId, candidate.keyId, err);
            if (!retry) throw err;
            assistant.content.length = 0;
          }
        }
        if (!result) {
          if (lastError !== undefined) {
            const unavailable = host.keysUnavailableMessage(rec.profileId, rec.groupId, keyErrors);
            if (unavailable) throw new Error(unavailable);
            throw lastError;
          }
          throw new Error(
            host.keysUnavailableMessage(rec.profileId, rec.groupId) ?? '当前账号没有可用的 API Key',
          );
        }
      } catch (err) {
        if (rt.interrupted || abort.signal.aborted) reason = 'interrupted';
        else {
          reason = 'error';
          errorText = errorMessage(err);
        }
      }

      if (result) {
        const inputTokens = result.usage.inputTokens || 0;
        const outputTokens = result.usage.outputTokens || 0;
        const cacheReadTokens = result.usage.cacheReadTokens || 0;
        const cacheWriteTokens = result.usage.cacheWriteTokens || 0;
        const reasoningTokens = result.usage.reasoningTokens || 0;
        // 单价：账号 price 覆盖 > 内置参考价；未知模型只统计 token
        const price = priceForModel(profile, model);
        const usage = {
          ...result.usage,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          reasoningTokens,
        };
        const cost = price ? costOfUsage(price, usage, profile.kind) : undefined;
        assistant.usage = {
          ...usage,
          ...(cost !== undefined ? { costUsd: cost } : {}),
          ...(usedKeyId ? { keyId: usedKeyId } : {}),
        };
        rec.usage.inputTokens += inputTokens;
        rec.usage.outputTokens += outputTokens;
        rec.usage.cacheReadTokens = (rec.usage.cacheReadTokens ?? 0) + cacheReadTokens;
        rec.usage.cacheWriteTokens = (rec.usage.cacheWriteTokens ?? 0) + cacheWriteTokens;
        rec.usage.reasoningTokens = (rec.usage.reasoningTokens ?? 0) + reasoningTokens;
        if (cost !== undefined) rec.usage.costUsd = roundCost((rec.usage.costUsd ?? 0) + cost);
        host.calibrateContext(rec, contextEstimate, inputTokens + cacheReadTokens + cacheWriteTokens);
        host.usage.record({
          hostId: host.config.hostId,
          profileId: rec.profileId,
          model,
          // 日统计的输入包含缓存读写，保持总输入口径一致
          inputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
          outputTokens,
          costUsd: cost ?? 0,
          ...(usedKeyId ? { keyId: usedKeyId } : {}),
          ...(rec.groupId ? { groupId: rec.groupId } : {}),
        });
      }

      // 无论成功失败都下发最终消息（失败时可能是部分内容）；成功时带上本次用量
      host.hub.broadcastSession(rec.id, {
        type: 'message_end',
        sessionId: rec.id,
        message: assistant,
      });
      host.store.markDirty(rec.id, true);
      host.broadcastSummary(rec);
      if (result && effortDropped && !effortNoticeShown) {
        effortNoticeShown = true;
        host.appendNotice(rec, '当前模型不支持思考强度，本轮已自动忽略。');
      }
      // 用量落账后检查预算；notice 放在本轮回复之后，避免打断输出顺序
      if (result) host.observeBudgets(rec);

      if (!result) {
        // 请求失败或中断时若已解析出 tool_use，必须补上对应 tool_result，
        // 否则下一轮会把悬空 tool_calls 发给模型，OpenAI 兼容接口会直接 400。
        const orphanToolUses = assistant.content.filter((b) => b.type === 'tool_use');
        if (orphanToolUses.length > 0) {
          const orphanMessage: Message = {
            id: randomUUID(),
            role: 'user',
            content: orphanToolUses.map<ContentBlock>((t) => ({
              type: 'tool_result',
              toolUseId: t.id,
              content: reason === 'interrupted' ? '用户中断' : '模型请求失败，工具未执行',
              isError: true,
            })),
            createdAt: Date.now(),
          };
          rec.messages.push(orphanMessage);
          host.hub.broadcastSession(rec.id, {
            type: 'message_start',
            sessionId: rec.id,
            message: orphanMessage,
          });
          host.hub.broadcastSession(rec.id, {
            type: 'message_end',
            sessionId: rec.id,
            message: orphanMessage,
          });
          host.store.markDirty(rec.id, true);
          host.broadcastSummary(rec);
        }
        break;
      }

      if (rt.interrupted || abort.signal.aborted) reason = 'interrupted';

      const toolUses = assistant.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        // Stop hook：exit 2 / decision=block 时把 stderr 回填给模型并继续（最多两次）
        if (reason !== 'interrupted' && !abort.signal.aborted) {
          const stop = await host.runHooks(rec, hookEntries, 'Stop', {
            stopHookActive: stopHookAttempts > 0,
            signal: abort.signal,
          });
          if (stop.blocked && stopHookAttempts < 2) {
            stopHookAttempts++;
            const feedback: Message = {
              id: randomUUID(),
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `[Stop Hook 反馈] 用户配置的 Hook 要求继续处理：\n${
                    stop.feedback.join('\n\n') || '（Hook 未提供具体原因）'
                  }`,
                },
              ],
              createdAt: Date.now(),
            };
            rec.messages.push(feedback);
            host.hub.broadcastSession(rec.id, {
              type: 'message_start',
              sessionId: rec.id,
              message: feedback,
            });
            host.hub.broadcastSession(rec.id, {
              type: 'message_end',
              sessionId: rec.id,
              message: feedback,
            });
            host.store.markDirty(rec.id, true);
            host.broadcastSummary(rec);
            continue;
          }
        }
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
          : await executeToolUses(host, rec, toolUses, abort.signal, hookEntries);

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

  return {
    reason,
    ...(errorText ? { error: errorText } : {}),
    ...(lastAssistantText(rec) ? { lastText: lastAssistantText(rec) } : {}),
  };
}

/** 最近一条包含文本的 assistant 消息内容（用于 Task 结果）。 */
function lastAssistantText(rec: SessionRecord): string | undefined {
  for (let i = rec.messages.length - 1; i >= 0; i--) {
    const message = rec.messages[i]!;
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return undefined;
}

function roundCost(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

async function executeToolUses(
  host: Host,
  rec: SessionRecord,
  toolUses: Array<Extract<ContentBlock, { type: 'tool_use' }>>,
  signal: AbortSignal,
  hookEntries: import('@tandem/protocol').HookEntry[],
): Promise<ContentBlock[]> {
  const perTool: ContentBlock[][] = new Array(toolUses.length);

  // 按调用顺序分批：相邻只读工具并行，写类工具等待前面的调用完成。
  // 不能把所有只读工具提到最前，否则同批的 Write 后 Read 会读到旧内容。
  const batches: number[][] = [];
  let reads: number[] = [];
  toolUses.forEach((tool, index) => {
    const parallel =
      tool.name === 'Task' ? isReadOnlySubagentInput(tool.input) : PARALLEL_TOOLS.has(tool.name);
    if (parallel) {
      reads.push(index);
      return;
    }
    if (reads.length > 0) {
      batches.push(reads);
      reads = [];
    }
    batches.push([index]);
  });
  if (reads.length > 0) batches.push(reads);

  const runOne = async (index: number): Promise<ContentBlock[]> => {
    const tool = toolUses[index];
    if (signal.aborted) {
      return [{ type: 'tool_result', toolUseId: tool.id, content: '用户中断', isError: true }];
    }
    const pre = await host.runHooks(rec, hookEntries, 'PreToolUse', {
      toolName: tool.name,
      toolInput: tool.input,
      toolUseId: tool.id,
      signal,
    });
    if (pre.blocked) {
      return [
        {
          type: 'tool_result',
          toolUseId: tool.id,
          content: `Hook 阻止了该工具调用：\n${pre.feedback.join('\n') || '（Hook 未提供原因）'}`,
          isError: true,
        },
      ];
    }

    // ExitPlanMode：不执行工具，转为计划审批；批准后切换权限模式并继续本轮
    if (tool.name === 'ExitPlanMode') {
      const planArg =
        tool.input && typeof tool.input === 'object'
          ? (tool.input as Record<string, unknown>).plan
          : '';
      const decision = await host.requestPlanApproval(rec, planArg, tool.id, signal);
      return [
        {
          type: 'tool_result',
          toolUseId: tool.id,
          content: decision.allowed
            ? decision.reason ?? '计划已获批准，请开始执行。'
            : `计划未获批准：${decision.reason ?? '用户要求继续完善计划'}`,
          ...(decision.allowed ? {} : { isError: true }),
        },
      ];
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
    // 写类工具执行前做检查点快照（Bash 改动无法追踪：命令任意，不纳入检查点）
    if ((tool.name === 'Write' || tool.name === 'Edit') && tool.input && typeof tool.input === 'object') {
      const filePath = (tool.input as Record<string, unknown>).file_path;
      if (typeof filePath === 'string' && filePath) host.snapshotForCheckpoint(rec, filePath);
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
      runSubagent: (input: { description: string; prompt: string; subagentType?: string }) =>
        host.runSubagent(rec, input, signal),
    };
    const def = host.toolDefinition(tool.name, rec.cwd);
    const res =
      def?.mcp && tool.name.startsWith('mcp__')
        ? await host.mcp.callTool(def.mcp.server, def.mcp.tool, tool.input, signal)
        : await executeTool(tool.name, tool.input, toolCtx);
    let content = truncateMiddle(res.content || '(无输出)');
    const post = await host.runHooks(rec, hookEntries, 'PostToolUse', {
      toolName: tool.name,
      toolInput: tool.input,
      toolUseId: tool.id,
      toolResponse: content,
      signal,
    });
    if (post.blocked && post.feedback.length > 0) {
      content += `\n\n[Hook 反馈]\n${post.feedback.join('\n')}`;
    }
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

  for (const batch of batches) {
    if (batch.length === 1) {
      perTool[batch[0]!] = await runOne(batch[0]!);
    } else {
      await Promise.all(
        batch.map(async (index) => {
          perTool[index] = await runOne(index);
        }),
      );
    }
  }

  return perTool.flat();
}
