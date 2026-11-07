// 运行意图（runState）的读写：每完成一个模型响应/工具结果就原子落盘并 fsync，
// Host 崩溃或重启后据此继续运行，而不是从头再来。
import type { ContentBlock } from '@tandem/protocol';
import type { Host } from './host.js';
import type { RunState, SessionRecord } from './types.js';

const COMPLETED_LIMIT = 100;

function runtimeOf(host: Host, rec: SessionRecord) {
  return host.ensureRuntime(rec.id);
}

/** 本轮开始：写入 runState（保留上一次的已完成列表，便于诊断断点）。 */
export function startRun(host: Host, rec: SessionRecord, turnMessageId?: string): void {
  const rt = runtimeOf(host, rec);
  const previous = rec.runState;
  rec.runState = {
    version: 1,
    startedAt: previous?.startedAt ?? Date.now(),
    updatedAt: Date.now(),
    ...(turnMessageId ?? previous?.turnMessageId
      ? { turnMessageId: turnMessageId ?? previous?.turnMessageId }
      : {}),
    completedMessages: previous?.completedMessages ?? [],
    queue: rt.queue.map((blocks) => cloneBlocks(blocks)),
    inFlightTools: [],
    pendingPermissions: [...rt.pending.values()].map((entry) => entry.request),
    phase: 'model',
    permissionMode: rec.permissionMode,
  };
  persist(host, rec);
}

/** 把运行时状态（排队消息、待审批、进行中工具）同步进 runState 并 fsync。 */
export function persist(
  host: Host,
  rec: SessionRecord,
  patch: Partial<Pick<RunState, 'phase' | 'assistantMessageId' | 'permissionMode'>> = {},
): void {
  if (!rec.runState) return;
  const rt = runtimeOf(host, rec);
  rec.runState = {
    ...rec.runState,
    ...patch,
    updatedAt: Date.now(),
    queue: rt.queue.map((blocks) => cloneBlocks(blocks)),
    pendingPermissions: [...rt.pending.values()].map((entry) => entry.request),
    permissionMode: patch.permissionMode ?? rec.permissionMode,
  };
  host.store.saveNow(rec.id);
}

/** 消息已完整写进会话（assistant 完整响应 / tool_result 消息）：记完成并 fsync。 */
export function noteMessageCompleted(
  host: Host,
  rec: SessionRecord,
  messageId: string,
  phase?: RunState['phase'],
): void {
  if (!rec.runState) return;
  if (!rec.runState.completedMessages.includes(messageId)) {
    rec.runState.completedMessages.push(messageId);
    if (rec.runState.completedMessages.length > COMPLETED_LIMIT) {
      rec.runState.completedMessages.splice(
        0,
        rec.runState.completedMessages.length - COMPLETED_LIMIT,
      );
    }
  }
  persist(host, rec, phase ? { phase } : {});
}

export function setAssistantMessage(host: Host, rec: SessionRecord, messageId: string): void {
  persist(host, rec, { assistantMessageId: messageId, phase: 'model' });
}

export function toolStarted(host: Host, rec: SessionRecord, id: string, name: string): void {
  if (!rec.runState) return;
  if (!rec.runState.inFlightTools.some((tool) => tool.id === id)) {
    rec.runState.inFlightTools.push({ id, name, startedAt: Date.now() });
  }
  persist(host, rec, { phase: 'tools' });
}

export function toolFinished(host: Host, rec: SessionRecord, id: string): void {
  if (!rec.runState) return;
  rec.runState.inFlightTools = rec.runState.inFlightTools.filter((tool) => tool.id !== id);
  persist(host, rec);
}

/** 本轮结束：还有排队消息时保留 runState（等 drainQueue），否则清除并 fsync。 */
export function finishRun(host: Host, rec: SessionRecord): void {
  const rt = runtimeOf(host, rec);
  if (rt.queue.length > 0) {
    rec.runState = {
      version: 1,
      startedAt: rec.runState?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
      ...(rec.runState?.turnMessageId ? { turnMessageId: rec.runState.turnMessageId } : {}),
      completedMessages: rec.runState?.completedMessages ?? [],
      queue: rt.queue.map((blocks) => cloneBlocks(blocks)),
      inFlightTools: [],
      pendingPermissions: [],
      phase: 'model',
      permissionMode: rec.permissionMode,
    };
  } else {
    delete rec.runState;
  }
  host.store.saveNow(rec.id);
}

/** 恢复时把 runState 里的排队消息放回运行时。 */
export function restoreQueue(host: Host, rec: SessionRecord): void {
  const rt = runtimeOf(host, rec);
  const queued = rec.runState?.queue ?? [];
  if (queued.length) {
    rt.queue = [...queued.map((blocks) => cloneBlocks(blocks)), ...rt.queue];
  }
}

function cloneBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return JSON.parse(JSON.stringify(blocks)) as ContentBlock[];
}
