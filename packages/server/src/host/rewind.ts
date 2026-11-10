// 检查点快照与对话/文件回退。
import type { Checkpoint, RewindInput, Session } from '@tandem/protocol';
import { isSubPath, resolvePath } from '../util/path.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';
import { httpError } from './helpers.js';

export function snapshotForCheckpoint(
  host: Host,
  rec: SessionRecord,
  absPath: string,
  before: Buffer | undefined,
): void {
  const rt = host.runtimes.get(rec.id);
  const checkpoint = rt?.checkpoint;
  if (!checkpoint) return;
  // cwd 之外的文件不纳入检查点，避免回退时误改仓库外内容
  if (!isSubPath(rec.cwd, absPath)) return;
  host.checkpoints.snapshotFile(checkpoint, rec.cwd, absPath, before);
}

export function listCheckpoints(host: Host, sessionId: string): Checkpoint[] {
  return host.checkpoints.list(sessionId);
}

export function isRunning(host: Host, sessionId: string): boolean {
  const rt = host.runtimes.get(sessionId);
  return !!rt && (rt.running || rt.draining);
}

export function rewind(host: Host, sessionId: string, input: RewindInput): Session | undefined {
  const rec = host.store.get(sessionId);
  if (!rec) return undefined;
  if (host.isRunning(sessionId)) throw httpError('会话正在运行，无法回退', 409);

  const list = host.checkpoints.list(sessionId);
  const target = input.checkpointId ? list.find((cp) => cp.id === input.checkpointId) : undefined;
  if (input.checkpointId && !target) throw httpError('检查点不存在', 404);
  if (!target && input.restoreFiles) {
    throw httpError('没有可用的文件检查点，只能恢复对话', 400);
  }
  const anchorMessageId = target?.messageId ?? input.messageId;
  if (!target && !input.restoreConversation) {
    throw httpError('缺少检查点，只能恢复对话', 400);
  }

  if (target && input.restoreFiles) {
    // 从最新检查点往最早恢复，同一文件最终落到最早的那份快照
    const ordered = [...list].sort((a, b) => b.createdAt - a.createdAt);
    for (const cp of ordered) {
      if (cp.createdAt < target.createdAt && cp.id !== target.id) continue;
      for (const file of cp.files) host.checkpoints.restoreFile(cp, rec.cwd, file);
    }
  }
  if (input.restoreConversation) {
    if (!anchorMessageId) throw httpError('缺少要回退的消息', 400);
    const index = rec.messages.findIndex((m) => m.id === anchorMessageId);
    // 消息可能已被删除（例如导入会话）；此时保持对话不变而不是悄悄回退到开头
    if (index >= 0) rec.messages = rec.messages.slice(0, index);
  }

  // 被回退的检查点不再有效
  if (target) host.checkpoints.removeFrom(sessionId, target.id);
  const rt = host.runtimes.get(sessionId);
  if (rt) delete rt.checkpoint;
  host.store.markDirty(sessionId, true);
  host.setStatus(rec, 'idle');
  // 旧事件不再适用于回退后的状态，清空缓冲让客户端以快照为准
  host.hub.resetSession(sessionId);
  host.broadcastSummary(rec);
  host.broadcastSnapshot(rec);
  return host.toSession(rec);
}
