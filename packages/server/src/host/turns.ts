// 消息入口、回合调度、中断、排队与 /compact。
import { randomUUID } from 'node:crypto';
import type { ContentBlock, Message, Todo } from '@tandem/protocol';
import { BUILTIN_NAMES, findCommandBody, parseSlashCommand } from '../agent/commands.js';
import { runTurn } from '../agent/loop.js';
import { completeText } from '../providers/index.js';
import { persist as persistRunState } from '../run-state.js';
import { errorMessage } from '../util/text.js';
import type { SessionRecord, SessionRuntime } from '../types.js';
import type { Host } from '../host.js';
import { compactHistory } from './compaction.js';
import { cleanTitle, isContentBlock, rememberTextOf } from './helpers.js';

export function ensureRuntime(host: Host, id: string): SessionRuntime {
  let rt = host.runtimes.get(id);
  if (!rt) {
    rt = {
      running: false,
      interrupted: false,
      draining: false,
      queue: [],
      pending: new Map(),
      deleted: false,
    };
    host.runtimes.set(id, rt);
  }
  return rt;
}

export async function send(host: Host, sessionId: string, content: ContentBlock[]): Promise<void> {
  const rec = host.store.get(sessionId);
  if (!rec) throw new Error('会话不存在');
  const rt = host.ensureRuntime(sessionId);
  if (rt.deleted) return;
  const blocks = Array.isArray(content) ? content.filter(isContentBlock) : [];
  if (blocks.length === 0) throw new Error('消息不能为空');
  // 运行中发送：排队，等本轮（含工具循环）结束后执行
  if (rt.running || rt.draining) {
    rt.queue.push(blocks);
    persistRunState(host, rec);
    return;
  }
  await host.handleUserContent(rec, blocks);
}

export async function handleUserContent(host: Host, rec: SessionRecord, content: ContentBlock[]): Promise<void> {
  // #记住…：直接写入项目记忆，不发给模型
  const remembered = rememberTextOf(content);
  if (remembered !== undefined) {
    if (!remembered) {
      host.appendNotice(rec, '用法：#记住 <要长期保留的项目事实或约定>');
      return;
    }
    try {
      const file = host.memory.add(rec.cwd, remembered);
      host.appendNotice(rec, `已记住（${file.name} · ${file.entries} 条）：${remembered}`);
    } catch (err) {
      host.appendNotice(rec, `写入项目记忆失败：${errorMessage(err)}`);
    }
    return;
  }
  const first = content[0];
  if (content.length === 1 && first?.type === 'text' && first.text.trim().startsWith('/')) {
    const cmd = parseSlashCommand(first.text);
    // 只把已知命令当命令；以 / 开头的普通路径仍按普通消息处理
    if (
      cmd &&
      (BUILTIN_NAMES.has(cmd.name) ||
        findCommandBody(cmd.name, rec.cwd) !== undefined ||
        host.skills.list(rec.cwd).some((skill) => skill.name === cmd.name))
    ) {
      if (await host.handleCommand(rec, cmd)) return;
    }
  }
  await host.sendToModel(rec, content);
}

export async function sendToModel(host: Host, rec: SessionRecord, content: ContentBlock[]): Promise<void> {
  const text = content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  const rt = host.ensureRuntime(rec.id);

  // UserPromptSubmit：可阻止消息，stdout/JSON 作为下一轮系统提示的附加上下文
  if (text) {
    const hookResult = await host.runHooks(rec, host.hooks.entriesForRun(rec.cwd), 'UserPromptSubmit', {
      prompt: text,
    });
    if (hookResult.blocked) {
      host.appendLocalAssistant(
        rec,
        `用户消息被 Hook 阻止：\n${hookResult.feedback.join('\n') || '（Hook 没有给出原因）'}`,
      );
      return;
    }
    if (hookResult.contexts.length > 0) {
      rt.pendingHookContext = hookResult.contexts.join('\n\n');
    }
  }

  // 首条用户消息且标题仍是默认值时，先截取正文做兜底标题，再异步让模型生成更短的标题
  const isFirstUserMessage = !rec.messages.some((m) => m.role === 'user');
  const needsTitle = (!rec.title || rec.title === '新会话') && !!text;
  if (needsTitle) rec.title = text.slice(0, 30);
  const message: Message = {
    id: randomUUID(),
    role: 'user',
    content,
    createdAt: Date.now(),
  };
  rec.messages.push(message);
  // 每轮开始创建检查点：本轮 Write/Edit 执行前把原文件快照进去
  rt.checkpoint = host.checkpoints.create(rec.id, message.id);
  host.hub.broadcastSession(rec.id, {
    type: 'message_start',
    sessionId: rec.id,
    message,
  });
  host.hub.broadcastSession(rec.id, {
    type: 'message_end',
    sessionId: rec.id,
    message,
  });
  host.store.markDirty(rec.id, true);
  host.broadcastSummary(rec);
  const result = await runTurn(host, rec);
  if (rec.board) host.boards.noteTurn(rec.id, result);
  // 主会话回合结束写入收件箱（子代理只把结果回传父会话，不单独提醒；评测内部会话与看板卡片不打扰）
  if ((rec.depth ?? 0) === 0 && !rec.evalRun && !rec.board) {
    host.pushInbox(
      host.inbox.recordTurnEnd(rec.id, rec.title, result.reason, result.error),
    );
  }
  if (needsTitle && isFirstUserMessage) void host.autoTitle(rec, text, rec.title);
}

export async function autoTitle(host: Host, rec: SessionRecord, firstText: string, baseTitle: string): Promise<void> {
  const titleKey = host.keyCandidates(rec.profileId, rec.groupId).candidates[0];
  const profile = titleKey?.profile ?? host.profileFor(rec.profileId, rec.groupId);
  const model = rec.model || profile?.defaultModel || '';
  if (!profile?.apiKey || !model) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const raw = await completeText({
      profile,
      model,
      system: '你是会话标题生成器。只输出标题本身，不要解释、不要引号、不要标点。',
      prompt: host.promptTemplates.render(
        'autoTitle',
        { text: firstText.slice(0, 2000) },
        rec.cwd,
      ),
      maxTokens: 200,
      signal: controller.signal,
    });
    host.markKeySuccess(rec.profileId, rec.groupId, titleKey?.keyId);
    const title = cleanTitle(raw);
    if (!title || rec.title !== baseTitle) return;
    rec.title = title;
    host.store.markDirty(rec.id, false);
    host.broadcastSummary(rec);
  } catch (err) {
    host.markKeyFailure(rec.profileId, rec.groupId, titleKey?.keyId, err);
    // 生成失败不打扰用户，保留截取正文的兜底标题
  } finally {
    clearTimeout(timer);
  }
}

export async function drainQueue(host: Host, sessionId: string): Promise<void> {
  const rec = host.store.get(sessionId);
  if (!rec) return;
  const rt = host.ensureRuntime(sessionId);
  if (rt.running || rt.draining || rt.deleted) return;
  rt.draining = true;
  try {
    while (rt.queue.length > 0 && !rt.deleted) {
      const next = rt.queue.shift()!;
      persistRunState(host, rec);
      await host.handleUserContent(rec, next);
    }
  } finally {
    rt.draining = false;
  }
}

export function interrupt(host: Host, sessionId: string): void {
  // 先级联中断子代理会话，再中断主会话
  for (const child of host.store.list()) {
    if (child.parentId !== sessionId) continue;
    const childRt = host.runtimes.get(child.id);
    if (childRt?.running) host.interrupt(child.id);
  }
  const rt = host.runtimes.get(sessionId);
  if (!rt) return;
  rt.queue = [];
  if (!rt.running) return;
  rt.interrupted = true;
  rt.abort?.abort();
  // 拒绝所有待审批请求，让工具循环尽快退出
  for (const pending of [...rt.pending.values()]) pending.resolve('deny');
}

export function updateTodos(host: Host, rec: SessionRecord, todos: Todo[]): void {
  rec.todos = todos;
  host.store.markDirty(rec.id, true);
  host.hub.broadcastSession(rec.id, {
    type: 'todos',
    sessionId: rec.id,
    todos,
  });
  host.broadcastSummary(rec);
}

export async function compactSession(host: Host, rec: SessionRecord): Promise<void> {
  const rt = host.ensureRuntime(rec.id);
  if (rt.running) return;
  rt.running = true;
  rt.interrupted = false;
  const abort = new AbortController();
  rt.abort = abort;
  let failed: string | undefined;

  try {
    host.setStatus(rec, 'running');
    const selection = host.keyCandidates(rec.profileId, rec.groupId);
    const profile = selection.candidates[0]?.profile ?? host.profileFor(rec.profileId, rec.groupId);
    if (!profile?.apiKey) {
      throw new Error(
        host.keysUnavailableMessage(rec.profileId, rec.groupId) ?? '当前账号未配置 API Key',
      );
    }
    const model = rec.model || profile.defaultModel;
    if (!model) throw new Error('当前账号没有配置模型');
    host.assertBudget(rec, model);
    if (rec.messages.length === 0) {
      host.appendLocalAssistant(rec, '当前没有可压缩的对话。');
      return;
    }

    // 手动 /compact 压缩全部历史；提示词与自动压缩共用注册表里的 compact 一条
    const compacted = await compactHistory(host, rec, rec.messages, {
      model,
      keepTurns: 0,
      auto: false,
      signal: abort.signal,
    });
    if (!compacted) throw new Error('当前没有可压缩的对话。');
    rec.messages = compacted.messages;
    host.observeBudgets(rec);
    host.store.markDirty(rec.id, true);
    host.broadcastSummary(rec);
    host.broadcastSnapshot(rec);
  } catch (err) {
    failed = abort.signal.aborted ? '用户中断' : errorMessage(err);
  } finally {
    rt.running = false;
    rt.abort = undefined;
    host.setStatus(rec, failed && failed !== '用户中断' ? 'error' : 'idle');
    host.store.markDirty(rec.id, true);
    host.hub.broadcastSession(rec.id, {
      type: 'turn_end',
      sessionId: rec.id,
      reason: failed ? (failed === '用户中断' ? 'interrupted' : 'error') : 'done',
      ...(failed && failed !== '用户中断' ? { error: failed } : {}),
    });
    host.pushInbox(
      host.inbox.recordTurnEnd(
        rec.id,
        rec.title,
        failed ? (failed === '用户中断' ? 'interrupted' : 'error') : 'done',
        failed && failed !== '用户中断' ? failed : undefined,
      ),
    );
    if (failed) {
      host.hub.broadcastSession(rec.id, { type: 'error', message: failed });
    }
    host.broadcastSummary(rec);
    void host.drainQueue(rec.id);
    void host.refreshEnv(rec.id);
  }
}
