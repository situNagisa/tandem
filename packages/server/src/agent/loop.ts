// Agent 循环：用户消息 -> 模型 -> 执行工具 -> 回填 tool_result -> 继续，直到没有工具调用。
import { randomUUID } from 'node:crypto';
import type { ContentBlock, Message, PermissionRequest } from '@tandem/protocol';
import type { Host } from '../host.js';
import type { SessionRecord } from '../types.js';
import { streamChat } from '../providers/index.js';
import { executeTool } from '../tools/index.js';
import { isReadOnlySubagentInput } from '../tools/task.js';
import { errorMessage, truncateMiddle } from '../util/text.js';
import { costOfUsage, priceForModel } from '../usage.js';
import {
  autoCompactTriggerTokens,
  cacheHitRateOf,
  estimateBreakdown,
  trimOldToolResults,
} from '../context.js';
import { isContextLengthError } from '../providers/http-error.js';
import { compactHistory } from '../host/compaction.js';
import { normalizeContextSettings } from '../context-settings.js';
import { redactMessages } from '../redact.js';
import { withNetworkRetry } from './retry.js';
import { KeysExhaustedError } from '../key-rotation.js';
import { replayUnfinishedTools } from './resume.js';
import {
  chooseAutoRoute,
  judgeDifficulty,
  looksLikeInvalidJson,
  noteInvalidOutput,
  noteToolFailure,
  noteTurnEnd,
  recordRouteSavings,
  routeSignalsOf,
  routingSettingsOf,
  type RouteSignals,
} from '../model-routing.js';
import { appendNotice } from '../host/commands.js';
import {
  finishRun,
  noteMessageCompleted,
  setAssistantMessage,
  startRun,
  toolFinished,
  toolStarted,
} from '../run-state.js';

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
  /** Host 重启后的续跑：补完悬空 tool_use（重新请求审批/只读重放）后继续。 */
  resume?: { pendingPermissions: PermissionRequest[] };
  /** 恢复时的触发消息 id（runState 中记录）。 */
  turnMessageId?: string;
}

export async function runTurn(
  host: Host,
  rec: SessionRecord,
  options: TurnOptions = {},
): Promise<TurnResult> {
  const rt = host.ensureRuntime(rec.id);
  if (rt.running || rt.deleted) return { reason: 'error', error: '会话正在运行' };
  const entryStatus = rec.status;
  rt.running = true;
  rt.interrupted = false;
  const abort = new AbortController();
  rt.abort = abort;
  const allowTask = options.allowTask !== false;
  const routingSettings = rec.autoRoute ? routingSettingsOf(host) : undefined;
  // 运行意图落盘：Host 崩溃/重启后据此续跑；trigger 为当前轮的用户消息
  const turnMessageId =
    options.turnMessageId ??
    [...rec.messages].reverse().find((m) => m.role === 'user' && !m.notice)?.id;
  startRun(host, rec, turnMessageId);
  rt.turnMessageId = turnMessageId;

  let reason: 'done' | 'interrupted' | 'error' = 'done';
  let errorText: string | undefined;
  let loopCompleted = false;
  let effortDropped = false;
  let effortNoticeShown = false;
  // 单轮内最多自动压缩两次，避免在极端历史下反复请求压缩模型
  let autoCompacts = 0;
  // 单轮内最多交接三次，避免备用分组也不可用时无限切换
  let handoffs = 0;
  // 自动路由：本轮是否出现工具失败（用于简单成功计数）与难度判断缓存
  let turnHadToolFailure = false;
  let judgedDifficulty: RouteSignals['judge'] | undefined;
  let judgeAttempted = false;

  // 按需连接项目级 MCP，并顺带重试之前失败的服务器；失败不影响本轮
  await host.mcp.prepare(rec.cwd).catch(() => {});
  const tools = host.toolDefinitions(rec, allowTask);
  const hookEntries = host.hooks.entriesForRun(rec.cwd);
  // 本项目 + 全局 secrets 的打码函数：工具输出、Hook 反馈、模型请求都经过它
  const redact = host.secrets.redactorFor(rec.cwd);
  let stopHookAttempts = 0;

  // SessionStart：每个会话首次运行时执行一次，stdout/JSON 作为附加上下文
  let sessionStartContext = '';
  if (!rt.sessionStartDone) {
    rt.sessionStartDone = true;
    const start = await host.runHooks(rec, hookEntries, 'SessionStart', {
      source: options.resume ? 'resume' : 'startup',
      signal: abort.signal,
    });
    sessionStartContext = redact(start.contexts.join('\n\n'));
  }
  const promptHookContext = redact(
    [sessionStartContext, rt.pendingHookContext].filter(Boolean).join('\n\n'),
  );
  delete rt.pendingHookContext;

  try {
    // Host 重启后：先把上一条 assistant 里悬空的 tool_use 处理掉（只读重放/补错误结果/恢复审批）
    if (options.resume) {
      await replayUnfinishedTools(host, rec, abort.signal, hookEntries, options.resume);
    }
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (rt.interrupted || abort.signal.aborted) {
        reason = 'interrupted';
        break;
      }

      host.setStatus(rec, 'running');
      // 自动路由：每轮（含工具循环的每次请求）按当前信号重新选模型
      let routed: import('@tandem/protocol').ModelRouteDecision | undefined;
      if (rec.autoRoute && routingSettings) {
        const turnMessage = rec.messages.find((message) => message.id === turnMessageId);
        const toolDepth = countToolDepth(rec, turnMessageId);
        if (routingSettings.judge && !judgeAttempted) {
          judgeAttempted = true;
          const text = (turnMessage?.content ?? [])
            .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
          judgedDifficulty = await judgeDifficulty(host, routingSettings, text);
        }
        const signals = routeSignalsOf(
          host,
          rec,
          turnMessage,
          toolDepth,
          entryStatus === 'error' || rec.routeState?.lastFailed === true,
        );
        if (judgedDifficulty) signals.judge = judgedDifficulty;
        const previous = rec.route;
        routed = chooseAutoRoute(host, rec, signals);
        if (
          routed &&
          (!previous ||
            previous.profileId !== routed.profileId ||
            (previous.groupId ?? '') !== (routed.groupId ?? '') ||
            previous.model !== routed.model)
        ) {
          appendNotice(
            host,
            rec,
            `自动：本轮使用 ${routed.model}（理由：${routed.reason}）`,
            routed,
          );
        }
      }
      const requestProfileId = routed?.profileId ?? rec.profileId;
      const requestGroupId = routed?.groupId ?? (routed ? undefined : rec.groupId);
      const selection = host.keyCandidates(requestProfileId, requestGroupId);
      const profile = selection.effective ?? host.profileFor(requestProfileId, requestGroupId);
      if (!profile) throw new Error('当前会话的账号不存在，请在界面上重新选择账号');
      const model = routed?.model || rec.model || profile.defaultModel;
      if (!model) throw new Error('当前账号没有配置模型');
      // 分组 Key 全部冷却/停用：交给交接流程（切换备用分组或等待重置），而不是直接失败
      if (!selection.candidates.some((candidate) => candidate.profile.apiKey)) {
        if (handoffs < 3) {
          const outcome = await host.triggerHandoff(rec, 'ratelimit', abort.signal);
          handoffs += 1;
          if (outcome === 'continue') continue;
          reason = 'interrupted';
          break;
        }
        throw new KeysExhaustedError(
          host.keysUnavailableMessage(requestProfileId, requestGroupId) ?? '当前账号没有配置 API Key',
        );
      }
      // 预算到达阻止阈值：先尝试交接（allow-once 时跳过，仍按原逻辑放行一次）
      const blockedBudget = rt.budgetAllowOnce
        ? undefined
        : host.budgets.blockingRule({
            profileId: requestProfileId,
            ...(requestGroupId ? { groupId: requestGroupId } : {}),
            model,
          });
      if (blockedBudget && handoffs < 3) {
        const outcome = await host.triggerHandoff(rec, 'budget', abort.signal);
        handoffs += 1;
        if (outcome === 'continue') continue;
        reason = 'interrupted';
        break;
      }
      host.assertBudget(rec, model, { profileId: requestProfileId, groupId: requestGroupId });
      // 预计 2 轮内耗尽：仅在本轮尚未交接时主动提示一次
      if (handoffs === 0) {
        const quota = host.refreshQuota(rec);
        if (quota.turnsLeft !== undefined && quota.turnsLeft <= 2) {
          const outcome = await host.triggerHandoff(rec, 'forecast', abort.signal);
          handoffs += 1;
          if (outcome === 'continue') continue;
          reason = 'interrupted';
          break;
        }
      }

      const contextSettings = normalizeContextSettings(host.config.context);
      const autoCompactMeta = {
        enabled: contextSettings.autoCompact,
        threshold: contextSettings.autoCompactThreshold,
      };
      // 发给模型前统一打码：既防止用户粘贴的值再次上行，也让上下文占用里的预览不含明文
      const buildRequestMessages = (excludeId?: string): Message[] =>
        redactMessages(
          trimOldToolResults(
            rec.messages.filter((m) => !m.notice && m.id !== excludeId),
            contextSettings,
          ).messages,
          redact,
        );
      const measure = (systemText: string, messages: Message[]) =>
        estimateBreakdown({
          model,
          system: systemText,
          tools,
          messages,
          cwd: rec.cwd,
          cacheHitRate: cacheHitRateOf(rec.usage),
          providerKind: profile.kind,
          capabilityOverrides: profile.modelCapabilities,
          autoCompact: autoCompactMeta,
        });

      let built = host.buildSystemFor(rec, { allowTask, hookContext: promptHookContext });
      let system = built.system;
      let requestMessages = buildRequestMessages();
      let contextEstimate = measure(system, requestMessages);

      // 请求前自动压缩：预计输入达到阈值时，把较早历史压成摘要，保留最近 N 轮原文
      if (
        contextSettings.autoCompact &&
        autoCompacts < 2 &&
        contextEstimate.usedTokens >=
          autoCompactTriggerTokens(contextEstimate.contextWindow, contextSettings)
      ) {
        const compacted = await compactHistory(host, rec, rec.messages, {
          model,
          keepTurns: contextSettings.autoCompactKeepTurns,
          auto: true,
          signal: abort.signal,
        }).catch((err) => {
          if (!rt.interrupted && !abort.signal.aborted) {
            host.appendNotice(rec, `自动压缩失败，已按原上下文继续：${errorMessage(err)}`);
          }
          return undefined;
        });
        if (compacted) {
          autoCompacts += 1;
          rec.messages = compacted.messages;
          host.observeBudgets(rec);
          host.store.markDirty(rec.id, true);
          host.broadcastSnapshot(rec);
          host.broadcastSummary(rec);
          // 压缩可能刚写入项目记忆，重建系统提示
          built = host.buildSystemFor(rec, { allowTask, hookContext: promptHookContext });
          system = built.system;
          requestMessages = buildRequestMessages();
          contextEstimate = measure(system, requestMessages);
        }
      }

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
      setAssistantMessage(host, rec, assistant.id);

      // 记录本轮实际注入的段落；变化时随 WS 推送，会话开头可展开查看
      host.recordInjections(rec, built.parts, turnMessageId);
      requestMessages = buildRequestMessages(assistant.id);
      // 请求前估算各部分占用；拿到真实 usage 后再按比例校准
      contextEstimate = measure(system, requestMessages);
      host.setContext(rec, contextEstimate, false);

      let result: Awaited<ReturnType<typeof streamChat>> | undefined;
      let usedKeyId: string | undefined;
      const keyErrors = new Map<string, string>();
      let contextRetryUsed = false;
      try {
        for (;;) {
          try {
            // 网络错误/超时全部失败后进入「等待网络」指数退避；每次重试重新挑 Key
            result = await withNetworkRetry(
              host,
              rec,
              abort.signal,
              async () => {
                keyErrors.clear();
                const attemptKeys = host.keyCandidates(requestProfileId, requestGroupId);
                if (attemptKeys.candidates.length === 0) {
                  throw new KeysExhaustedError(
                    host.keysUnavailableMessage(requestProfileId, requestGroupId) ??
                      '当前账号没有可用的 API Key',
                  );
                }
                let attemptError: unknown;
                // 同组多 Key：按策略逐个尝试；仅在尚未输出任何 token 时透明重试
                for (const candidate of attemptKeys.candidates) {
                  let started = false;
                  try {
                    const attempt = await streamChat({
                      profile: candidate.profile,
                      onRateLimit: (info) =>
                        host.recordKeyQuota(requestProfileId, requestGroupId, candidate.keyId, info),
                      model,
                      system: redact(system),
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
                    host.markKeySuccess(requestProfileId, requestGroupId, candidate.keyId);
                    usedKeyId = candidate.keyId;
                    return attempt;
                  } catch (err) {
                    attemptError = err;
                    if (rt.interrupted || abort.signal.aborted) throw err;
                    if (candidate.keyId && !started) keyErrors.set(candidate.keyId, errorMessage(err));
                    // 已开始输出，或错误不属于 Key 级故障（400 等）：按原错误路径处理
                    const retry =
                      !started &&
                      host.markKeyFailure(requestProfileId, requestGroupId, candidate.keyId, err);
                    if (!retry) throw err;
                    assistant.content.length = 0;
                  }
                }
                if (attemptError !== undefined) {
                  const unavailable = host.keysUnavailableMessage(
                    requestProfileId,
                    requestGroupId,
                    keyErrors,
                  );
                  const status = (attemptError as { status?: unknown } | undefined)?.status;
                  if (status === 429 || unavailable) {
                    throw new KeysExhaustedError(
                      unavailable ?? errorMessage(attemptError ?? '额度不足'),
                    );
                  }
                  throw attemptError;
                }
                throw new KeysExhaustedError(
                  host.keysUnavailableMessage(requestProfileId, requestGroupId) ??
                    '当前账号没有可用的 API Key',
                );
              },
              () => {
                // 重试前清空这一条 assistant 的流式内容并让客户端覆盖显示，成功时不重复输出
                assistant.content.length = 0;
                host.hub.broadcastSession(rec.id, {
                  type: 'message_start',
                  sessionId: rec.id,
                  message: assistant,
                });
                setAssistantMessage(host, rec, assistant.id);
              },
            );
            break;
          } catch (err) {
            // provider 报「上下文超长」：压缩历史后重试一次，而不是直接失败
            if (
              contextRetryUsed ||
              rt.interrupted ||
              abort.signal.aborted ||
              !isContextLengthError(err)
            ) {
              throw err;
            }
            contextRetryUsed = true;
            const index = rec.messages.findIndex((m) => m.id === assistant.id);
            const history = index >= 0 ? rec.messages.slice(0, index) : rec.messages;
            const tail = index >= 0 ? rec.messages.slice(index) : [];
            const compacted = await compactHistory(host, rec, history, {
              model,
              keepTurns: contextSettings.autoCompactKeepTurns,
              auto: true,
              force: true,
              signal: abort.signal,
            }).catch(() => undefined);
            if (!compacted) throw err;
            autoCompacts += 1;
            rec.messages = [...compacted.messages, ...tail];
            assistant.content.length = 0;
            host.observeBudgets(rec);
            host.store.markDirty(rec.id, true);
            host.broadcastSnapshot(rec);
            host.broadcastSummary(rec);
            built = host.buildSystemFor(rec, { allowTask, hookContext: promptHookContext });
            system = built.system;
            host.recordInjections(rec, built.parts, turnMessageId);
            requestMessages = buildRequestMessages(assistant.id);
            contextEstimate = measure(system, requestMessages);
            host.setContext(rec, contextEstimate, false);
            host.hub.broadcastSession(rec.id, {
              type: 'message_start',
              sessionId: rec.id,
              message: assistant,
            });
            setAssistantMessage(host, rec, assistant.id);
          }
        }
      } catch (err) {
        const exhausted =
          err instanceof KeysExhaustedError ||
          (!!host.keysUnavailableMessage(requestProfileId, requestGroupId) &&
            (err as { status?: unknown } | undefined)?.status === 429);
        if (!rt.interrupted && !abort.signal.aborted && exhausted) {
          // 请求失败前未产生任何输出：移除空 assistant 占位，交接到备用分组后重新请求
          const index = rec.messages.findIndex((m) => m.id === assistant.id);
          if (index >= 0 && assistant.content.length === 0) {
            rec.messages.splice(index, 1);
            host.store.markDirty(rec.id, true);
            host.broadcastSnapshot(rec);
          }
          assistant.content.length = 0;
          // 自动路由：先给其他候选一次机会（失败 Key 已进入冷却），再走交接
          if (rec.autoRoute && routed && handoffs === 0) {
            handoffs += 1;
            continue;
          }
          const outcome = await host.triggerHandoff(rec, 'ratelimit', abort.signal);
          handoffs += 1;
          if (outcome === 'continue') continue;
          reason = 'interrupted';
        } else if (rt.interrupted || abort.signal.aborted) reason = 'interrupted';
        else {
          reason = 'error';
          if (rec.autoRoute && err instanceof SyntaxError) {
            noteInvalidOutput(rec);
            turnHadToolFailure = true;
          }
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
          profileId: requestProfileId,
          model,
          // 日统计的输入包含缓存读写，保持总输入口径一致
          inputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
          outputTokens,
          costUsd: cost ?? 0,
          ...(usedKeyId ? { keyId: usedKeyId } : {}),
          ...(requestGroupId ? { groupId: requestGroupId } : {}),
        });
        if (rec.autoRoute && routed) {
          recordRouteSavings(host, rec, assistant.usage!, cost);
        }
        host.refreshQuota(rec);
      }

      // 无论成功失败都下发最终消息（失败时可能是部分内容）；成功时带上本次用量
      host.hub.broadcastSession(rec.id, {
        type: 'message_end',
        sessionId: rec.id,
        message: assistant,
      });
      host.store.markDirty(rec.id, true);
      host.broadcastSummary(rec);
      if (result) {
        noteMessageCompleted(
          host,
          rec,
          assistant.id,
          assistant.content.some((b) => b.type === 'tool_use') ? 'tools' : 'model',
        );
      }
      if (result && effortDropped && !effortNoticeShown) {
        effortNoticeShown = true;
        host.appendNotice(rec, '当前模型不支持思考强度，本轮已自动忽略。');
      }
      // 用量落账后检查预算；notice 放在本轮回复之后，避免打断输出顺序
      if (result) {
        host.observeBudgets(rec);
        host.refreshQuota(rec);
      }

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
        if (rec.autoRoute) {
          const answer = assistant.content
            .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
          if (looksLikeInvalidJson(answer)) {
            noteInvalidOutput(rec);
            turnHadToolFailure = true;
          }
        }
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
                  text: redact(
                    `[Stop Hook 反馈] 用户配置的 Hook 要求继续处理：\n${
                      stop.feedback.join('\n\n') || '（Hook 未提供具体原因）'
                    }`,
                  ),
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
          : await executeToolUses(host, rec, toolUses, abort.signal, hookEntries, redact);

      if (rec.autoRoute && reason !== 'interrupted') {
        if (noteToolFailure(rec, resultBlocks)) turnHadToolFailure = true;
      }

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
      noteMessageCompleted(host, rec, toolMessage.id, 'model');

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
    if (errorText) errorText = redact(errorText);
    rt.running = false;
    rt.abort = undefined;
    rt.turnMessageId = undefined;
    // 本轮结束：清除运行意图（若还有排队消息则保留 queue，等 drainQueue）
    finishRun(host, rec);
    if (rec.autoRoute && routingSettings) {
      noteTurnEnd(rec, reason, routingSettings.preference, turnHadToolFailure);
    }
    host.setStatus(rec, reason === 'error' ? 'error' : 'idle');
    // 回合完成即未读；用户正在看时客户端会立刻调用 read 接口清除（多端同步）。
    if ((rec.depth ?? 0) === 0 && !rec.evalRun && reason !== 'interrupted') {
      rec.unread = true;
    }
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

/** 本轮已执行的工具调用数（自动路由的工具深度信号）。 */
function countToolDepth(rec: SessionRecord, turnMessageId?: string): number {
  let started = !turnMessageId;
  let count = 0;
  for (const message of rec.messages) {
    if (!started) {
      if (message.id === turnMessageId) started = true;
      continue;
    }
    count += message.content.filter((block) => block.type === 'tool_use').length;
  }
  return count;
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
  redact: (text: string) => string,
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
          content: redact(`Hook 阻止了该工具调用：\n${pre.feedback.join('\n') || '（Hook 未提供原因）'}`),
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
          content: redact(auth.reason ?? '操作被拒绝'),
          isError: true,
        },
      ];
    }
    // 写类工具执行前做检查点快照（Bash 改动无法追踪：命令任意，不纳入检查点）
    if ((tool.name === 'Write' || tool.name === 'Edit') && tool.input && typeof tool.input === 'object') {
      const filePath = (tool.input as Record<string, unknown>).file_path;
      if (typeof filePath === 'string' && filePath) host.snapshotForCheckpoint(rec, filePath);
    }
    // 记录进行中的工具：Host 在同一时刻崩溃后，恢复时据此判断哪些不能自动重放
    toolStarted(host, rec, tool.id, tool.name);
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
      runSubagent: (input: { description: string; prompt: string; subagentType?: string; model?: string }) =>
        host.runSubagent(rec, input, signal),
      getSkill: (name: string) => host.skills.resolve(name, rec.cwd),
      ...(rec.board
        ? { proposeCards: (input: unknown) => host.boards.proposeFromSession(rec, input) }
        : {}),
      home: host.home,
      memory: host.memory,
      backgroundTasks: host.tasks,
      browser: host.browser,
      secretEnv: host.secrets.envFor(rec.cwd, 'bash'),
      sandbox: host.sandboxProfileFor(tool.id),
      redact,
    };
    const def = host.toolDefinition(tool.name, rec.cwd);
    const res =
      def?.mcp && tool.name.startsWith('mcp__')
        ? await host.mcp.callTool(def.mcp.server, def.mcp.tool, tool.input, signal)
        : await executeTool(tool.name, tool.input, toolCtx);
    let content = redact(truncateMiddle(res.content || '(无输出)'));
    const post = await host.runHooks(rec, hookEntries, 'PostToolUse', {
      toolName: tool.name,
      toolInput: tool.input,
      toolUseId: tool.id,
      toolResponse: content,
      signal,
    });
    if (post.blocked && post.feedback.length > 0) {
      content += redact(`\n\n[Hook 反馈]\n${post.feedback.join('\n')}`);
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
    // 工具结果已拿到：立即 fsync（含 inFlightTools 清理），供重启恢复判断
    toolFinished(host, rec, tool.id);
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
