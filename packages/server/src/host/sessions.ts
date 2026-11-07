// 会话读取、转换与 CRUD。
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ContextSettings,
  DelegationStrategy,
  HostInfo,
  HostSettings,
  PermissionMode,
  PermissionRequest,
  ReasoningEffort,
  Session,
  SessionStatus,
  SessionSummary,
} from '@tandem/protocol';
import { effectiveProfile, saveHostSettings } from '../config.js';
import { normalizeContextSettings } from '../context-settings.js';
import { recoverAfterRestart as recoverRuns, resumeSession } from '../agent/resume.js';
import { createWorktree, gitRepoRoot, removeWorktree, worktreeCleanliness } from '../worktree.js';
import { errorMessage } from '../util/text.js';
import { expandHome } from '../util/path.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';
import { DELEGATIONS, EFFORTS, PERMISSION_MODES, httpError, sanitizeVoiceSettings } from './helpers.js';
import { notifyExternalSessionsChanged } from './external.js';

export function info(host: Host): HostInfo {
  return {
    id: host.config.hostId,
    name: os.hostname(),
    platform: process.platform,
    version: host.version,
    homeDir: os.homedir(),
  };
}

export function settings(host: Host): HostSettings {
  return {
    resumeOnRestart: host.config.resumeOnRestart === 'pause' ? 'pause' : 'auto',
    defaultDelegation:
      host.config.defaultDelegation === 'orchestrate' ||
      host.config.defaultDelegation === 'more' ||
      host.config.defaultDelegation === 'none'
        ? host.config.defaultDelegation
        : 'less',
    ...(host.config.voice ? { voice: host.config.voice } : {}),
    context: normalizeContextSettings(host.config.context),
  };
}

export function updateSettings(host: Host, input: Partial<HostSettings>): HostSettings {
  if (input.resumeOnRestart === 'auto' || input.resumeOnRestart === 'pause') {
    host.config.resumeOnRestart = input.resumeOnRestart;
  }
  if (
    input.defaultDelegation === 'orchestrate' ||
    input.defaultDelegation === 'more' ||
    input.defaultDelegation === 'less' ||
    input.defaultDelegation === 'none'
  ) {
    host.config.defaultDelegation = input.defaultDelegation;
  }
  if (input.voice !== undefined) {
    host.config.voice = sanitizeVoiceSettings(input.voice);
  }
  if (input.context && typeof input.context === 'object') {
    host.config.context = normalizeContextSettings(input.context as Partial<ContextSettings>);
  }
  saveHostSettings(host.home, {
    resumeOnRestart: host.settings().resumeOnRestart,
    ...(host.config.defaultDelegation ? { defaultDelegation: host.config.defaultDelegation } : {}),
    ...(host.config.voice ? { voice: host.config.voice } : {}),
    context: normalizeContextSettings(host.config.context),
  });
  return host.settings();
}

export function recoverAfterRestart(host: Host): Promise<void> {
  return recoverRuns(host);
}

export function resumePausedSession(host: Host, id: string): SessionRecord | undefined {
  const rec = host.store.get(id);
  if (!rec) return undefined;
  void resumeSession(host, rec).catch((err) => {
    console.warn(`[tandem] 恢复会话 ${id} 失败:`, errorMessage(err));
  });
  return rec;
}

export function retryNow(host: Host, sessionId: string): boolean {
  const rt = host.runtimes.get(sessionId);
  if (!rt?.retryInfo || !rt.retryWake) return false;
  rt.retryWake();
  return true;
}

export function getSession(host: Host, id: string): SessionRecord | undefined {
  const rec = host.store.get(id);
  if (rec) host.ensureSessionEnv(rec);
  return rec;
}

export function listSessions(host: Host): SessionRecord[] {
  // 评测运行使用的内部会话在侧栏隐藏，轨迹随评测结果单独保存。
  const list = host.store.list().filter((rec) => !rec.evalRun);
  for (const rec of list) host.ensureSessionEnv(rec);
  return list;
}

export function ensureSessionEnv(host: Host, rec: SessionRecord): void {
  if (rec.env || host.envChecked.has(rec.id)) return;
  host.envChecked.add(rec.id);
  void host.refreshEnv(rec.id).catch(() => {
    // 检测失败保持无 env，下次进程启动再试
    host.envChecked.delete(rec.id);
  });
}

export function toSummary(host: Host, rec: SessionRecord): SessionSummary {
  const secretsCount = host.secrets.countFor(rec.cwd);
  return {
    id: rec.id,
    title: rec.title,
    cwd: rec.cwd,
    profileId: rec.profileId,
    ...(rec.groupId ? { groupId: rec.groupId } : {}),
    model: rec.model,
    permissionMode: rec.permissionMode,
    status: rec.status,
    ...(rec.retryInfo ? { retryInfo: { ...rec.retryInfo } } : {}),
    ...(rec.resumePaused ? { resumePaused: true } : {}),
    ...(rec.effort ? { effort: rec.effort } : {}),
    ...(rec.delegation ? { delegation: rec.delegation } : {}),
    // 可选字段只在有值时下发，老客户端不受影响
    ...(rec.pinned ? { pinned: true } : {}),
    ...(rec.pinnedTurns && rec.pinnedTurns.length ? { pinnedTurns: [...rec.pinnedTurns] } : {}),
    ...(rec.archived ? { archived: true } : {}),
    ...(rec.env ? { env: { ...rec.env } } : {}),
    ...(rec.parentId ? { parentId: rec.parentId } : {}),
    ...(typeof rec.depth === 'number' ? { depth: rec.depth } : {}),
    ...(rec.forkedFrom ? { forkedFrom: { ...rec.forkedFrom } } : {}),
    ...(rec.scheduledBy ? { scheduledBy: { ...rec.scheduledBy } } : {}),
    ...(rec.worktree ? { worktree: { ...rec.worktree } } : {}),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    usage: { ...rec.usage },
    ...(rec.context ? { context: rec.context } : {}),
    ...(secretsCount ? { secretsCount } : {}),
  };
}

export function markScheduled(host: Host, id: string, info: { id: string; name: string }): void {
  const rec = host.store.get(id);
  if (!rec) return;
  rec.scheduledBy = info;
  host.store.markDirty(id, true);
  host.broadcastSummary(rec);
}

export function toSession(host: Host, rec: SessionRecord): Session {
  return {
    ...host.toSummary(rec),
    messages: rec.messages,
    todos: rec.todos,
    ...(rec.plan ? { plan: { ...rec.plan } } : {}),
  };
}

export function snapshot(host: Host, id: string): { session: Session; pendingPermissions: PermissionRequest[] } | undefined {
  const rec = host.store.get(id);
  if (!rec) return undefined;
  const rt = host.runtimes.get(id);
  return {
    session: host.toSession(rec),
    pendingPermissions: rt ? [...rt.pending.values()].map((p) => p.request) : [],
  };
}

export function broadcastSummary(host: Host, rec: SessionRecord): void {
  host.hub.broadcastAll({ type: 'session_updated', session: host.toSummary(rec) });
}

export function setStatus(host: Host, rec: SessionRecord, status: SessionStatus): void {
  if (rec.status === status) return;
  rec.status = status;
  host.broadcastSummary(rec);
}

export async function createSession(host: Host, input: {
    cwd?: unknown;
    profileId?: unknown;
    groupId?: unknown;
    model?: unknown;
    permissionMode?: unknown;
    effort?: unknown;
    delegation?: unknown;
    title?: unknown;
    worktree?: unknown;
  }): Promise<SessionRecord> {
  const rawCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  if (!rawCwd) throw new Error('cwd 不能为空');
  const cwd = path.resolve(expandHome(rawCwd));
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    throw new Error(`工作目录不存在: ${cwd}`);
  }
  if (!stat.isDirectory()) throw new Error(`工作目录不是目录: ${cwd}`);

  const profileId = typeof input.profileId === 'string' ? input.profileId : '';
  const profile = host.profiles.get(profileId);
  if (!profile) throw new Error('账号不存在，请先创建账号');
  const groupId =
    typeof input.groupId === 'string' && input.groupId.trim() ? input.groupId.trim() : undefined;
  if (groupId && !profile.groups?.some((g) => g.id === groupId)) throw new Error('分组不存在');
  const effective = effectiveProfile(profile, groupId);
  const model =
    (typeof input.model === 'string' && input.model.trim()) ||
    effective.defaultModel ||
    effective.models[0] ||
    '';
  if (!model) throw new Error('该账号没有可用模型');

  const permissionMode = PERMISSION_MODES.has(input.permissionMode as PermissionMode)
    ? (input.permissionMode as PermissionMode)
    : 'default';
  if (input.effort !== undefined && !EFFORTS.has(input.effort as ReasoningEffort)) {
    throw new Error(`无效的 effort: ${String(input.effort)}`);
  }
  const effort = input.effort as ReasoningEffort | undefined;
  if (input.delegation !== undefined && !DELEGATIONS.has(input.delegation as DelegationStrategy)) {
    throw new Error(`无效的 delegation: ${String(input.delegation)}`);
  }
  const delegation =
    (input.delegation as DelegationStrategy | undefined) ?? host.settings().defaultDelegation ?? 'less';

  // worktree 会话：先创建 worktree，会话 cwd 指向新目录
  const shortId = randomUUID().slice(0, 8);
  let sessionCwd = cwd;
  let worktree: SessionRecord['worktree'];
  let worktreeRepoRoot: string | undefined;
  if (input.worktree && typeof input.worktree === 'object') {
    const branch = (input.worktree as { branch?: unknown }).branch;
    const info = await createWorktree(
      host.home,
      cwd,
      typeof branch === 'string' ? branch : undefined,
      shortId,
    );
    sessionCwd = info.path;
    worktree = { path: info.path, branch: info.branch, baseBranch: info.baseBranch };
    worktreeRepoRoot = info.repoRoot;
  }

  const now = Date.now();
  const rec: SessionRecord = {
    id: randomUUID(),
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '新会话',
    cwd: sessionCwd,
    profileId,
    ...(groupId ? { groupId } : {}),
    model,
    permissionMode,
    ...(effort ? { effort } : {}),
    delegation,
    depth: 0,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [],
    todos: [],
    allowedTools: [],
    ...(worktree ? { worktree } : {}),
    ...(worktreeRepoRoot ? { worktreeRepoRoot } : {}),
    ...(worktree && worktreeRepoRoot
      ? {
          env: {
            repoRoot: worktreeRepoRoot,
            repoName: path.basename(worktreeRepoRoot),
            branch: worktree.branch,
          },
        }
      : {}),
  };
  host.store.add(rec);
  host.broadcastSummary(rec);
  return rec;
}

export function updateSession(host: Host, id: string,
    patch: {
      title?: unknown;
      profileId?: unknown;
      groupId?: unknown;
      model?: unknown;
      permissionMode?: unknown;
      pinned?: unknown;
      pinnedTurns?: unknown;
      archived?: unknown;
      effort?: unknown;
      delegation?: unknown;
      cwd?: unknown;
    },): SessionRecord | undefined {
  const rec = host.store.get(id);
  if (!rec) return undefined;

  if (typeof patch.title === 'string' && patch.title.trim()) rec.title = patch.title.trim();
  if (typeof patch.cwd === 'string' && patch.cwd.trim()) {
    if (host.isRunning(id)) throw httpError('会话正在运行，无法切换目录', 409);
    const cwd = path.resolve(expandHome(patch.cwd.trim()));
    let stat;
    try {
      stat = statSync(cwd);
    } catch {
      throw new Error(`工作目录不存在: ${cwd}`);
    }
    if (!stat.isDirectory()) throw new Error(`工作目录不是目录: ${cwd}`);
    if (cwd !== rec.cwd) {
      rec.cwd = cwd;
      // 换目录后旧的 worktree 元数据不再适用，重新检测环境
      delete rec.worktree;
      delete rec.worktreeRepoRoot;
      delete rec.env;
      host.envChecked.delete(id);
    }
  }
  if (typeof patch.effort === 'string') {
    const effort = patch.effort as SessionSummary['effort'];
    if (!['off', 'low', 'medium', 'high', 'max'].includes(effort ?? '')) {
      throw new Error(`无效的 effort: ${patch.effort}`);
    }
    rec.effort = effort;
  }
  if (typeof patch.delegation === 'string') {
    if (!DELEGATIONS.has(patch.delegation as DelegationStrategy)) {
      throw new Error(`无效的 delegation: ${patch.delegation}`);
    }
    rec.delegation = patch.delegation as DelegationStrategy;
  }
  if (typeof patch.permissionMode === 'string') {
    if (!PERMISSION_MODES.has(patch.permissionMode as PermissionMode)) {
      throw new Error(`无效的 permissionMode: ${patch.permissionMode}`);
    }
    rec.permissionMode = patch.permissionMode as PermissionMode;
  }
  if (typeof patch.profileId === 'string' && patch.profileId !== rec.profileId) {
    const profile = host.profiles.get(patch.profileId);
    if (!profile) throw new Error('账号不存在');
    rec.profileId = profile.id;
    // 换账号时分组不再适用，默认切到该账号的默认模型
    delete rec.groupId;
    if (typeof patch.model !== 'string' || !patch.model.trim()) {
      rec.model = profile.defaultModel || profile.models[0] || rec.model;
    }
  }
  if (typeof patch.groupId === 'string') {
    const groupId = patch.groupId.trim();
    if (groupId) {
      const profile = host.profiles.get(rec.profileId);
      const group = profile?.groups?.find((g) => g.id === groupId);
      if (!group) throw new Error('分组不存在');
      rec.groupId = groupId;
      // 切换分组时若没显式指定模型，用该分组的默认模型
      if (typeof patch.model !== 'string' || !patch.model.trim()) {
        rec.model = group.defaultModel || group.models[0] || rec.model;
      }
    } else {
      delete rec.groupId;
    }
  }
  if (typeof patch.model === 'string' && patch.model.trim()) rec.model = patch.model.trim();
  if (typeof patch.pinned === 'boolean') {
    if (patch.pinned) rec.pinned = true;
    else delete rec.pinned;
  }
  if (Array.isArray(patch.pinnedTurns)) {
    const ids = [...new Set(
      patch.pinnedTurns.filter((id): id is string => typeof id === 'string' && id.length > 0),
    )].slice(0, 200);
    if (ids.length) rec.pinnedTurns = ids;
    else delete rec.pinnedTurns;
  }
  if (typeof patch.archived === 'boolean') {
    if (patch.archived) rec.archived = true;
    else delete rec.archived;
  }

  host.store.markDirty(rec.id, true);
  host.broadcastSummary(rec);
  return rec;
}

export function forkSession(host: Host, id: string, messageId?: string): SessionRecord | undefined {
  const src = host.store.get(id);
  if (!src) return undefined;
  let messages = structuredClone(src.messages);
  if (messageId) {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) throw httpError('分叉点消息不存在', 400);
    messages = messages.slice(0, index + 1);
    // 停在 assistant 消息上时去掉尾部未完成的 tool_use，否则下一轮请求缺少 tool_result。
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') {
      last.content = last.content.filter((block) => block.type !== 'tool_use');
      if (last.content.length === 0) messages.pop();
    }
  }
  const now = Date.now();
  const rec: SessionRecord = {
    id: randomUUID(),
    title: `${src.title || '新会话'}（${messageId ? '分叉' : '副本'}）`,
    cwd: src.cwd,
    profileId: src.profileId,
    ...(src.groupId ? { groupId: src.groupId } : {}),
    model: src.model,
    permissionMode: src.permissionMode,
    ...(src.effort ? { effort: src.effort } : {}),
    ...(src.delegation ? { delegation: src.delegation } : {}),
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    usage: { ...src.usage },
    messages,
    todos: structuredClone(src.todos),
    allowedTools: [...src.allowedTools],
    ...(src.env ? { env: { ...src.env } } : {}),
    ...(src.plan ? { plan: structuredClone(src.plan) } : {}),
    ...(messageId
      ? { forkedFrom: { sessionId: src.id, messageId, title: src.title } }
      : {}),
  };
  host.store.add(rec);
  host.broadcastSummary(rec);
  return rec;
}

export async function deleteSession(host: Host, id: string, force = false): Promise<boolean> {
  const rec = host.store.get(id);
  if (!rec) return false;
  if (rec.worktree && !force) {
    const status = await worktreeCleanliness(rec.worktree.path);
    if (status.dirty) {
      const files = (status.detail ?? '')
        .split('\n')
        .map((line) => line.replace(/^..\s+/, '').trim())
        .filter(Boolean)
        .map((path) => (path.includes(' -> ') ? path.split(' -> ').pop()! : path));
      const shown = files.slice(0, 5).join('、');
      const summary = files.length > 5 ? `${shown} 等 ${files.length} 个文件` : shown || `${files.length} 个文件`;
      throw httpError(
        `worktree 有未提交改动（${summary}），分支 ${rec.worktree.branch} 与 worktree 目录会被一并删除`,
        409,
      );
    }
  }
  // 先级联中断正在运行的子代理
  host.interrupt(id);
  const rt = host.runtimes.get(id);
  if (rt) {
    rt.deleted = true;
    rt.interrupted = true;
    rt.queue = [];
    rt.abort?.abort();
    for (const pending of [...rt.pending.values()]) pending.resolve('deny');
    host.runtimes.delete(id);
  }
  host.store.delete(id);
  void host.browser.closeSession(id, false);
  host.hub.dropSession(id);
  host.hub.broadcastAll({ type: 'session_deleted', sessionId: id });
  // 删除导入的会话后，原外部会话应重新出现在侧栏
  if (rec.importedFrom) host.notifyExternalSessionsChanged();
  if (rec.worktree) {
    await removeWorktree(
      rec.worktreeRepoRoot ?? (await gitRepoRoot(rec.cwd)) ?? '',
      rec.worktree.path,
      rec.worktree.branch,
      force,
    ).catch((err) => {
      console.warn(`[tandem] 清理 worktree 失败:`, errorMessage(err));
    });
  }
  return true;
}
