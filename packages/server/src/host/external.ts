// 外部会话（Claude Code / Codex）变更通知与跨 Host 导入。
import type { Session } from '@tandem/protocol';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';

export function notifyExternalSessionsChanged(host: Host): void {
  host.hub.broadcastAll({ type: 'external_sessions_changed' });
}

export async function importSession(host: Host, input: { session?: unknown; cwd?: unknown }): Promise<SessionRecord> {
  const source = input.session as Session | undefined;
  if (!source || typeof source !== 'object' || !Array.isArray(source.messages)) {
    throw new Error('session 无效');
  }
  const rawCwd =
    typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : source.cwd;
  if (!rawCwd) throw new Error('cwd 不能为空');
  const profiles = host.profiles.list();
  const profile = host.profiles.get(source.profileId) ?? profiles[0];
  if (!profile) throw new Error('目标 Host 还没有账号，请先创建账号');
  const groupId =
    profile.id === source.profileId &&
    source.groupId &&
    profile.groups?.some((g) => g.id === source.groupId)
      ? source.groupId
      : undefined;
  const rec = await host.createSession({
    cwd: rawCwd,
    profileId: profile.id,
    title: source.title || '导入的会话',
    permissionMode: source.permissionMode,
    ...(groupId ? { groupId } : {}),
    ...(profile.id === source.profileId && source.model ? { model: source.model } : {}),
  });
  rec.messages = structuredClone(source.messages);
  rec.todos = Array.isArray(source.todos) ? structuredClone(source.todos) : [];
  if (source.plan) rec.plan = structuredClone(source.plan);
  if (source.usage) rec.usage = { ...source.usage };
  if (source.effort) rec.effort = source.effort;
  host.store.markDirty(rec.id, false);
  host.broadcastSummary(rec);
  return rec;
}
