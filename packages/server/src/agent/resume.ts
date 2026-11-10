// Host 重启后的会话恢复：扫描 runState，按设置自动续跑或暂停等待确认。
// 续跑时对未完成的 tool_use：只读工具重新执行；有副作用的工具不自动重放，
// 补一条 isError 的 tool_result 让模型人工确认；等待审批的请求重新广播。
import type { ContentBlock, HookEntry, PermissionRequest } from '@tandem/protocol';
import type { Host } from '../host.js';
import type { SessionRecord } from '../types.js';
import { runTurn } from './loop.js';
import { executeTool } from '../tools/index.js';
import { errorMessage, truncateMiddle } from '../util/text.js';
import { noteMessageCompleted, restoreQueue, setAssistantMessage } from '../run-state.js';

export interface ResumeOptions {
  /** 等待审批中的请求（来自 runState），恢复后按原 id 重新广播。 */
  pendingPermissions: PermissionRequest[];
}

/** Host 启动时调用：自动继续或恢复为暂停。 */
export async function recoverAfterRestart(host: Host): Promise<void> {
  // 后台任务：运行中的已在任务管理器里标记 lost，这里在会话里补一条提示
  for (const task of host.tasks.takeNewlyLost()) {
    const rec = host.store.get(task.sessionId);
    if (!rec) continue;
    host.appendNotice(
      rec,
      `后台任务 ${task.id}（${task.command.slice(0, 80)}）在 Host 重启后已丢失运行状态，输出仍可查看；如仍需要请让模型重新运行。`,
    );
  }

  const mode = host.settings().resumeOnRestart;
  for (const rec of host.store.list()) {
    // Wiki 生成的隐藏只读会话不跨重启恢复；清掉残留，避免后台继续调模型。
    if (rec.wikiRun) {
      host.store.delete(rec.id);
      continue;
    }
    if (!rec.runState) continue;
    if (mode === 'pause') {
      rec.resumePaused = true;
      host.store.markDirty(rec.id, false);
      host.broadcastSummary(rec);
      continue;
    }
    void resumeSession(host, rec).catch((err) => {
      console.warn(`[tandem] 恢复会话 ${rec.id} 失败:`, errorMessage(err));
    });
  }
}

/** 恢复一个中断的会话；也用于用户手动点击「继续运行」。 */
export async function resumeSession(host: Host, rec: SessionRecord): Promise<void> {
  if (rec.wikiRun) {
    host.store.delete(rec.id);
    return;
  }
  const rt = host.ensureRuntime(rec.id);
  if (rt.running || rt.draining) return;
  const before = rec.runState;
  if (!before) {
    if (rec.resumePaused) {
      delete rec.resumePaused;
      host.store.markDirty(rec.id, false);
      host.broadcastSummary(rec);
    }
    return;
  }
  restoreQueue(host, rec);
  delete rec.resumePaused;
  // 注意：先取最后一条非 notice 消息，再插入恢复 notice（notice 是 assistant，会遮住真实断点）
  let last: SessionRecord['messages'][number] | undefined;
  for (let i = rec.messages.length - 1; i >= 0; i--) {
    const candidate = rec.messages[i]!;
    if (candidate.notice) continue;
    last = candidate;
    break;
  }
  host.appendNotice(rec, 'Host 重启后已恢复运行');
  host.store.markDirty(rec.id, false);

  const unfinished = last?.role === 'assistant'
    ? last.content.filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
    : [];
  const pending = [...before.pendingPermissions];

  // 崩溃发生在模型请求中途（phase=model）：这条 assistant 还没完整，不能当工具调用重放，
  // 丢掉后重新请求（已输出部分未完整落盘，避免把半截内容发给模型）。
  if (unfinished.length > 0 && before.phase === 'model') {
    if (last?.role === 'assistant' && last.id === before.assistantMessageId) {
      rec.messages.pop();
      host.store.markDirty(rec.id, true);
    }
    await runTurn(host, rec, {
      resume: { pendingPermissions: pending },
      turnMessageId: before.turnMessageId,
    });
    return;
  }

  if (unfinished.length > 0) {
    await runTurn(host, rec, {
      resume: { pendingPermissions: pending },
      turnMessageId: before.turnMessageId,
    });
    return;
  }

  const lastHasToolResult =
    last?.role === 'user' && last.content.some((block) => block.type === 'tool_result');
  if (last && (last.role === 'user' || lastHasToolResult)) {
    await runTurn(host, rec, {
      resume: { pendingPermissions: pending },
      turnMessageId: before.turnMessageId,
    });
    return;
  }

  // 最后一条 assistant 已完整（没有未完成工具调用）：这一轮其实已经结束，
  // 只是 runState 还没来得及清除；直接清掉并执行排队消息。
  delete rec.runState;
  host.store.saveNow(rec.id);
  host.setStatus(rec, 'idle');
  host.broadcastSummary(rec);
  void host.drainQueue(rec.id);
}

/** 在 runTurn 内部调用：处理上一条 assistant 里悬空的 tool_use。 */
export async function replayUnfinishedTools(
  host: Host,
  rec: SessionRecord,
  signal: AbortSignal,
  hookEntries: HookEntry[],
  options: ResumeOptions,
): Promise<void> {
  let last: SessionRecord['messages'][number] | undefined;
  for (let i = rec.messages.length - 1; i >= 0; i--) {
    const candidate = rec.messages[i]!;
    if (candidate.notice) continue;
    last = candidate;
    break;
  }
  if (!last || last.role !== 'assistant') return;
  const toolUses = last.content.filter(
    (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
  );
  if (toolUses.length === 0) return;

  const pendingByToolUse = new Map(
    options.pendingPermissions.map((request) => [request.toolUseId, request]),
  );
  const results: ContentBlock[] = [];

  for (const tool of toolUses) {
    if (signal.aborted) {
      results.push({
        type: 'tool_result',
        toolUseId: tool.id,
        content: '用户中断',
        isError: true,
      });
      continue;
    }
    const pending = pendingByToolUse.get(tool.id);
    if (pending) {
      const decision = await host.restorePendingPermission(rec, pending, signal);
      if (pending.toolName === 'ExitPlanMode') {
        results.push(...handleRestoredPlan(host, rec, tool.id, decision.decision, decision.reason));
        continue;
      }
      if (decision.decision === 'deny') {
        results.push({
          type: 'tool_result',
          toolUseId: tool.id,
          content: decision.reason?.trim() || 'Host 重启后审批被拒绝',
          isError: true,
        });
        continue;
      }
      const blocks = await runRecoveredTool(host, rec, tool, signal, hookEntries);
      results.push(...blocks);
      continue;
    }

    const def = host.toolDefinition(tool.name, rec.cwd);
    if (def && def.readOnly && !def.requiresApproval) {
      const blocks = await runRecoveredTool(host, rec, tool, signal, hookEntries);
      results.push(...blocks);
      continue;
    }
    results.push({
      type: 'tool_result',
      toolUseId: tool.id,
      content: 'Host 重启，此工具调用未确认是否完成，请检查后再继续',
      isError: true,
    });
  }

  const message = {
    id: crypto.randomUUID(),
    role: 'user' as const,
    content: results,
    createdAt: Date.now(),
  };
  rec.messages.push(message);
  host.hub.broadcastSession(rec.id, { type: 'message_start', sessionId: rec.id, message });
  host.hub.broadcastSession(rec.id, { type: 'message_end', sessionId: rec.id, message });
  host.store.markDirty(rec.id, true);
  noteMessageCompleted(host, rec, message.id);
  setAssistantMessage(host, rec, last.id);
  host.broadcastSummary(rec);
}

function handleRestoredPlan(
  host: Host,
  rec: SessionRecord,
  toolUseId: string,
  decision: 'allow' | 'allow_always' | 'deny',
  reason?: string,
): ContentBlock[] {
  if (decision === 'deny') {
    rec.plan = { ...(rec.plan ?? { content: '', createdAt: Date.now() }), status: 'rejected' };
    host.store.markDirty(rec.id, true);
    host.hub.broadcastSession(rec.id, { type: 'plan', sessionId: rec.id, plan: { ...rec.plan } });
    return [
      {
        type: 'tool_result',
        toolUseId,
        content: `计划未获批准：${reason ?? '用户要求继续完善计划'}`,
        isError: true,
      },
    ];
  }
  const mode = decision === 'allow_always' ? 'acceptEdits' : 'default';
  rec.permissionMode = mode;
  if (rec.plan) {
    rec.plan = { ...rec.plan, status: 'approved', approvalMode: mode };
    host.store.markDirty(rec.id, true);
    host.hub.broadcastSession(rec.id, { type: 'plan', sessionId: rec.id, plan: { ...rec.plan } });
  }
  host.broadcastSummary(rec);
  return [
    {
      type: 'tool_result',
      toolUseId,
      content:
        mode === 'acceptEdits'
          ? '计划已获批准，已切换到自动接受编辑模式，请开始执行计划。'
          : '计划已获批准，请开始执行计划（编辑操作会逐个询问）。',
    },
  ];
}

async function runRecoveredTool(
  host: Host,
  rec: SessionRecord,
  tool: Extract<ContentBlock, { type: 'tool_use' }>,
  signal: AbortSignal,
  hookEntries: HookEntry[],
): Promise<ContentBlock[]> {
  const redact = host.secrets.redactorFor(rec.cwd);
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
  const toolCtx = {
    cwd: rec.cwd,
    session: rec,
    env: host.env,
    signal,
    updateTodos: (todos: SessionRecord['todos']) => host.updateTodos(rec, todos),
    setUsage: (usage: SessionRecord['usage']) => {
      rec.usage.inputTokens += usage.inputTokens;
      rec.usage.outputTokens += usage.outputTokens;
      host.store.markDirty(rec.id, false);
    },
    runSubagent: (input: {
      description: string;
      prompt: string;
      subagentType?: string;
      model?: string;
      role?: import('@tandem/protocol').RouteRole;
      domain?: import('@tandem/protocol').RouteDomain;
      toolUseId?: string;
    }) => host.runSubagent(rec, { ...input, toolUseId: input.toolUseId ?? tool.id }, signal),
    getSkill: (name: string) => host.skills.resolve(name, rec.cwd),
    home: host.home,
    memory: host.memory,
    backgroundTasks: host.tasks,
    devices: host.devices,
    secretEnv: host.secrets.envFor(rec.cwd, 'bash'),
    snapshot: (absPath: string, before: Buffer | undefined) => host.snapshotForCheckpoint(rec, absPath, before),
    redact,
  };
  let content = '';
  let isError = false;
  let images: ContentBlock[] | undefined;
  try {
    const def = host.toolDefinition(tool.name, rec.cwd);
    const res =
      def?.mcp && tool.name.startsWith('mcp__')
        ? await host.mcp.callTool(def.mcp.server, def.mcp.tool, tool.input, signal)
        : await executeTool(tool.name, tool.input, toolCtx);
    content = redact(truncateMiddle(res.content || '(无输出)'));
    isError = !!res.isError;
    images = res.images;
  } catch (err) {
    content = redact(`工具执行失败：${errorMessage(err)}`);
    isError = true;
  }
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
    { type: 'tool_result', toolUseId: tool.id, content, ...(isError ? { isError: true } : {}) },
  ];
  if (images) blocks.push(...images);
  return blocks;
}
