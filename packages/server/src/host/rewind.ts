// 检查点快照与对话/文件回退。
import type { Checkpoint, RewindInput, Session } from '@tandem/protocol';
import { isSubPath, resolvePath } from '../util/path.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';
import { httpError } from './helpers.js';

export function snapshotForCheckpoint(host: Host, rec: SessionRecord, rawPath: string): void {
  const rt = host.runtimes.get(rec.id);
  const checkpoint = rt?.checkpoint;
  if (!checkpoint) return;
  const abs = resolvePath(rec.cwd, rawPath);
  // cwd 之外的文件不纳入检查点，避免回退时误改仓库外内容
  if (!isSubPath(rec.cwd, abs)) return;
  host.checkpoints.snapshotFile(checkpoint, rec.cwd, abs);
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
  if (!input || typeof input.checkpointId !== 'string' || !input.checkpointId) {
    throw httpError('checkpointId 不能为空', 400);
  }

  const list = host.checkpoints.list(sessionId);
  const target = list.find((cp) => cp.id === input.checkpointId);
  if (!target) throw httpError('检查点不存在', 404);

  if (input.restoreFiles) {
    // 从最新检查点往最早恢复，同一文件最终落到最早的那份快照
    const ordered = [...list].sort((a, b) => b.createdAt - a.createdAt);
    for (const cp of ordered) {
      if (cp.createdAt < target.createdAt && cp.id !== target.id) continue;
      for (const file of cp.files) host.checkpoints.restoreFile(cp, rec.cwd, file);
    }
  }
  if (input.restoreConversation) {
    const index = rec.messages.findIndex((m) => m.id === target.messageId);
    if (index >= 0) rec.messages = rec.messages.slice(0, index);
  }

  // 被回退的检查点不再有效
  host.checkpoints.removeFrom(sessionId, target.id);
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
