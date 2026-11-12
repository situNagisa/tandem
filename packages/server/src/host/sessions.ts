// 会话读取、转换与 CRUD。
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AiReviewSettings,
  ContentBlock,
  ContextSettings,
  HostInfo,
  HostSettings,
  MessagePage,
  PermissionMode,
  PermissionRequest,
  ReasoningEffort,
  Session,
  SessionStatus,
  SessionSummary,
  SessionTurns,
} from '@tandem/protocol';
import { effectiveProfile, saveHostSettings } from '../config.js';
import { normalizeContextSettings } from '../context-settings.js';
import { recoverAfterRestart as recoverRuns, resumeSession } from '../agent/resume.js';
import { createWorktree, gitRepoRoot, removeWorktree, worktreeCleanliness } from '../worktree.js';
import { errorMessage } from '../util/text.js';
import { expandHome } from '../util/path.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';
import { EFFORTS, PERMISSION_MODES, httpError, sanitizeVoiceSettings } from './helpers.js';
import { notifyExternalSessionsChanged } from './external.js';
import { normalizeHandoffSettings } from '../handoff.js';
import {
  normalizeDelegation,
  normalizeRouteBias,
  normalizeRoutingSettings,
} from '../routing-settings.js';
import { routingSettingsOf } from '../model-routing.js';
import {
  PAGE_BYTES_MAX,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  SNAPSHOT_TAIL_BYTES,
  SNAPSHOT_TAIL_MESSAGES,
  sessionTurns,
  tailMessages,
  truncateLargeToolOutputs,
} from './message-paging.js';

export function info(host: Host): HostInfo {
  return {
    id: host.config.hostId,
    name: os.hostname(),
    platform: host.env.platform,
    version: host.version,
    homeDir: host.env.home,
  };
}

export function settings(host: Host): HostSettings {
  return {
    resumeOnRestart: host.config.resumeOnRestart === 'pause' ? 'pause' : 'auto',
    defaultDelegation: normalizeDelegation(host.config.defaultDelegation) ?? 'less',
    ...(host.config.voice ? { voice: host.config.voice } : {}),
    context: normalizeContextSettings(host.config.context),
    ...(host.config.aiReview ? { aiReview: sanitizeAiReview(host.config.aiReview) } : {}),
    ...(host.config.handoff ? { handoff: normalizeHandoffSettings(host.config.handoff) } : {}),
    ...(normalizeRoutingSettings(host.config.modelRouting)
      ? { modelRouting: normalizeRoutingSettings(host.config.modelRouting)! }
      : {}),
    sandbox: host.sandbox.get(),
    ...(host.config.updateShareDir ? { updateShareDir: host.config.updateShareDir } : {}),
    ...(host.config.devices ? { devices: host.config.devices } : {}),
  };
}

function sanitizeAiReview(input: AiReviewSettings): AiReviewSettings {
  const profileId = typeof input.profileId === 'string' && input.profileId.trim() ? input.profileId.trim() : undefined;
  const groupId = typeof input.groupId === 'string' && input.groupId.trim() ? input.groupId.trim() : undefined;
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined;
  const effort = EFFORTS.has(input.effort as ReasoningEffort) ? (input.effort as ReasoningEffort) : undefined;
  return {
    ...(profileId ? { profileId } : {}),
    ...(groupId ? { groupId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(input.blockOnBlocker === true ? { blockOnBlocker: true } : {}),
  };
}

export function updateSettings(host: Host, input: Partial<HostSettings>): HostSettings {
  if (input.resumeOnRestart === 'auto' || input.resumeOnRestart === 'pause') {
    host.config.resumeOnRestart = input.resumeOnRestart;
  }
  const defaultDelegation = normalizeDelegation(input.defaultDelegation);
  if (defaultDelegation) host.config.defaultDelegation = defaultDelegation;
  if (input.voice !== undefined) {
    host.config.voice = sanitizeVoiceSettings(input.voice);
  }
  if (input.context && typeof input.context === 'object') {
    host.config.context = normalizeContextSettings(input.context as Partial<ContextSettings>);
  }
  if (input.sandbox && typeof input.sandbox === 'object') {
    host.sandbox.set(input.sandbox);
  }
  if (input.aiReview !== undefined) {
    const next = sanitizeAiReview(input.aiReview ?? {});
    if (Object.keys(next).length) host.config.aiReview = next;
    else delete host.config.aiReview;
  }
  if (input.handoff !== undefined) {
    const next = normalizeHandoffSettings(input.handoff);
    if (next) host.config.handoff = next;
    else delete host.config.handoff;
  }
  if (input.modelRouting !== undefined) {
    const next = normalizeRoutingSettings(input.modelRouting);
    if (next) host.config.modelRouting = next;
    else delete host.config.modelRouting;
  }
  if (input.updateShareDir !== undefined) {
    const dir = typeof input.updateShareDir === 'string' ? input.updateShareDir.trim() : '';
    if (dir) host.config.updateShareDir = dir;
    else delete host.config.updateShareDir;
  }
  if (input.devices && typeof input.devices === 'object') {
    const adbPath = typeof input.devices.adbPath === 'string' ? input.devices.adbPath.trim() : '';
    const devices: NonNullable<HostSettings['devices']> = {};
    if (adbPath) devices.adbPath = adbPath;
    if (input.devices.serialMock === true) devices.serialMock = true;
    if (input.devices.allowPeer === false) devices.allowPeer = false;
    if (Object.keys(devices).length) host.config.devices = devices;
    else delete host.config.devices;
  }
  saveHostSettings(host.home, {
    resumeOnRestart: host.settings().resumeOnRestart,
    ...(host.config.defaultDelegation ? { defaultDelegation: host.config.defaultDelegation } : {}),
    ...(host.config.voice ? { voice: host.config.voice } : {}),
    context: normalizeContextSettings(host.config.context),
    ...(host.config.aiReview ? { aiReview: sanitizeAiReview(host.config.aiReview) } : {}),
    ...(host.config.handoff ? { handoff: normalizeHandoffSettings(host.config.handoff) } : {}),
    modelRouting: normalizeRoutingSettings(host.config.modelRouting) ?? null,
    ...(host.config.updateShareDir ? { updateShareDir: host.config.updateShareDir } : {}),
    ...(host.config.devices ? { devices: host.config.devices } : {}),
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
  const list = host.store.list().filter((rec) => !rec.evalRun && !rec.wikiRun);
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
  const quota = host.estimateQuota(rec);
  const context = rec.context ? { ...rec.context, quota } : undefined;
  return {
    id: rec.id,
    title: rec.title,
    cwd: rec.cwd,
    profileId: rec.profileId,
    ...(rec.groupId ? { groupId: rec.groupId } : {}),
    model: rec.model,
    ...(rec.autoRoute ? { autoRoute: true } : {}),
    ...(rec.routeBias ? { routeBias: rec.routeBias } : {}),
    ...(rec.route ? { route: { ...rec.route, scores: { ...rec.route.scores } } } : {}),
    ...(rec.routeSavings ? { routeSavings: { ...rec.routeSavings } } : {}),
    permissionMode: rec.permissionMode,
    status: rec.status,
    ...(rec.retryInfo ? { retryInfo: { ...rec.retryInfo } } : {}),
    ...(rec.resumePaused ? { resumePaused: true } : {}),
    ...(rec.effort ? { effort: rec.effort } : {}),
    ...(rec.delegation ? { delegation: rec.delegation } : {}),
    ...(rec.routeNative ? { routeNative: true } : {}),
    // 可选字段只在有值时下发，老客户端不受影响
    ...(rec.pinned ? { pinned: true } : {}),
    ...(rec.pinnedInProject ? { pinnedInProject: true } : {}),
    ...(rec.pinnedTurns && rec.pinnedTurns.length ? { pinnedTurns: [...rec.pinnedTurns] } : {}),
    ...(rec.archived ? { archived: true } : {}),
    ...(rec.unread ? { unread: true } : {}),
    ...(rec.env ? { env: { ...rec.env } } : {}),
    ...(rec.parentId ? { parentId: rec.parentId } : {}),
    ...(rec.parentToolUseId ? { parentToolUseId: rec.parentToolUseId } : {}),
    ...(typeof rec.depth === 'number' ? { depth: rec.depth } : {}),
    ...(rec.forkedFrom ? { forkedFrom: { ...rec.forkedFrom } } : {}),
    ...(rec.scheduledBy ? { scheduledBy: { ...rec.scheduledBy } } : {}),
    ...(rec.worktree ? { worktree: { ...rec.worktree } } : {}),
    ...(rec.board ? { board: { ...rec.board, boardName: host.boards.nameOf(rec.board.boardId) } } : {}),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    usage: { ...rec.usage },
    ...(rec.aiReviewUsage ? { aiReviewUsage: { ...rec.aiReviewUsage } } : {}),
    ...(context ? { context } : {}),
    ...(rec.handoff ? { handoff: { ...rec.handoff } } : {}),
    quota,
    ...(rec.demo ? { demo: true } : {}),
    ...(rec.demoScenario ? { demoScenario: rec.demoScenario } : {}),
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

/** 分页视图：尾部消息 + 总数/首条 id；超大工具输出只保留首尾。 */
export function toSessionPaged(host: Host, rec: SessionRecord, tail: number): Session {
  const page = tailMessages(rec.messages, tail, SNAPSHOT_TAIL_BYTES);
  const messages = truncateLargeToolOutputs(page);
  return {
    ...host.toSummary(rec),
    messages,
    todos: rec.todos,
    ...(rec.plan ? { plan: { ...rec.plan } } : {}),
    totalMessages: rec.messages.length,
    firstMessageId: messages[0]?.id,
    hasEarlier: page.length < rec.messages.length,
  };
}

export function snapshot(
  host: Host,
  id: string,
  tail?: number,
): {
  session: Session;
  pendingPermissions: PermissionRequest[];
  totalMessages?: number;
  firstMessageId?: string;
  truncated?: boolean;
} | undefined {
  const rec = host.store.get(id);
  if (!rec) return undefined;
  const rt = host.runtimes.get(id);
  const pendingPermissions = rt ? [...rt.pending.values()].map((p) => p.request) : [];
  if (tail === undefined) {
    return { session: host.toSession(rec), pendingPermissions };
  }
  const session = host.toSessionPaged(rec, tail);
  return {
    session,
    pendingPermissions,
    totalMessages: session.totalMessages,
    firstMessageId: session.firstMessageId,
    truncated: session.hasEarlier === true,
  };
}

/** 向前翻页 / 按需取一段；向前翻页优先按偏移倒序读日志，磁盘尚未追上时回退到内存切片。 */
export function messagePage(
  host: Host,
  rec: SessionRecord,
  options: { beforeId?: string; aroundId?: string; limit?: number },
): MessagePage {
  const limit = Math.max(
    1,
    Math.min(
      Number.isFinite(options.limit) ? Math.floor(options.limit as number) : PAGE_LIMIT_DEFAULT,
      PAGE_LIMIT_MAX,
    ),
  );
  const totalMessages = rec.messages.length;
  let messages: SessionRecord['messages'] | undefined;
  let hasEarlier = false;
  let lastMessageId: string | undefined;
  let nextMessageId: string | undefined;
  let hasLater: boolean | undefined;
  const beforeId = options.beforeId;
  if (options.aroundId) {
    const index = rec.messages.findIndex((message) => message.id === options.aroundId);
    if (index < 0) {
      return { messages: [], totalMessages, hasEarlier: false, hasLater: false };
    }
    const before = Math.floor((limit - 1) / 2);
    let start = Math.max(0, index - before);
    let end = Math.min(totalMessages, start + limit);
    start = Math.max(0, end - limit);
    messages = rec.messages.slice(start, end);
    hasEarlier = start > 0;
    hasLater = end < totalMessages;
    lastMessageId = messages[messages.length - 1]?.id;
    nextMessageId = rec.messages[end]?.id;
  } else if (beforeId) {
    const beforeIndex = rec.messages.findIndex((message) => message.id === beforeId);
    const disk = host.store.readMessagePage(rec.id, {
      beforeId,
      limit,
      maxBytes: PAGE_BYTES_MAX,
    });
    // 磁盘页必须与内存中的顺序一致（防止刚回退/压缩后的旧日志），否则用内存。
    const expectStart = beforeIndex >= 0 ? Math.max(0, beforeIndex - limit) : -1;
    const diskMatches =
      !!disk &&
      beforeIndex >= 0 &&
      disk.messages.length === beforeIndex - expectStart &&
      disk.messages.every((message, i) => message.id === rec.messages[expectStart + i]?.id);
    if (disk && diskMatches) {
      messages = disk.messages;
      hasEarlier = disk.hasEarlier;
    } else if (beforeIndex >= 0) {
      messages = rec.messages.slice(expectStart, beforeIndex);
      hasEarlier = expectStart > 0;
    } else {
      messages = [];
      hasEarlier = false;
    }
  } else {
    messages = tailMessages(rec.messages, limit, PAGE_BYTES_MAX);
    hasEarlier = messages.length < totalMessages;
  }
  if (!options.aroundId) {
    lastMessageId = messages[messages.length - 1]?.id;
    if (beforeId) {
      const nextIndex = rec.messages.findIndex((message) => message.id === beforeId);
      if (nextIndex >= 0) {
        nextMessageId = beforeId;
        hasLater = nextIndex < totalMessages;
      }
    } else {
      hasLater = false;
    }
  }
  const paged = truncateLargeToolOutputs(messages);
  return {
    messages: paged,
    totalMessages,
    ...(paged[0] ? { firstMessageId: paged[0].id } : {}),
    ...(lastMessageId ? { lastMessageId } : {}),
    ...(nextMessageId ? { nextMessageId } : {}),
    hasEarlier,
    ...(hasLater !== undefined ? { hasLater } : {}),
  };
}

export function turnsFor(host: Host, rec: SessionRecord): SessionTurns {
  return { totalMessages: rec.messages.length, turns: sessionTurns(rec.messages) };
}

/** 单条消息的完整内容块（不截断），用于“显示全部”。可按消息+下标或 toolUseId 定位。 */
export function messageBlock(
  host: Host,
  rec: SessionRecord,
  lookup: { messageId?: string; index?: number; toolUseId?: string },
): ContentBlock | undefined {
  if (lookup.toolUseId) {
    for (let i = rec.messages.length - 1; i >= 0; i--) {
      const found = rec.messages[i]!.content.find(
        (block) => block.type === 'tool_result' && block.toolUseId === lookup.toolUseId,
      );
      if (found) return found;
    }
    return undefined;
  }
  const message = rec.messages.find((item) => item.id === lookup.messageId);
  const index = lookup.index ?? -1;
  if (!message || !Number.isInteger(index) || index < 0 || index >= message.content.length) {
    return undefined;
  }
  return message.content[index];
}

export function broadcastSummary(host: Host, rec: SessionRecord): void {
  // Wiki 生成使用隐藏只读会话，避免出现在侧栏/多端列表里。
  if (rec.wikiRun) return;
  host.hub.broadcastAll({ type: 'session_updated', session: host.toSummary(rec) });
}

/** 标记已读：清除未读并广播给所有端（手机/桌面共享同一份状态）。 */
export function markRead(host: Host, id: string): SessionRecord | undefined {
  const rec = host.store.get(id);
  if (!rec) return undefined;
  if (!rec.unread) return rec;
  delete rec.unread;
  host.store.markDirty(rec.id, false);
  host.broadcastSummary(rec);
  return rec;
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
    autoRoute?: unknown;
    routeBias?: unknown;
    permissionMode?: unknown;
    effort?: unknown;
    delegation?: unknown;
    routeNative?: unknown;
    title?: unknown;
    worktree?: unknown;
  }): Promise<SessionRecord> {
  const rawCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  if (!rawCwd) throw new Error('cwd 不能为空');
  const cwd = host.env.path.resolve(expandHome(rawCwd, host.env));
  let stat;
  try {
    stat = await host.env.fs.stat(cwd);
  } catch {
    throw new Error(`工作目录不存在: ${cwd}`);
  }
  if (stat.type !== 'dir') throw new Error(`工作目录不是目录: ${cwd}`);

  const profileId = typeof input.profileId === 'string' ? input.profileId : '';
  const profile = host.profiles.get(profileId);
  if (!profile) throw new Error('账号不存在，请先创建账号');
  const groupId =
    typeof input.groupId === 'string' && input.groupId.trim() ? input.groupId.trim() : undefined;
  if (groupId && !profile.groups?.some((g) => g.id === groupId)) throw new Error('分组不存在');
  const effective = effectiveProfile(profile, groupId);
  const requestedModel = typeof input.model === 'string' ? input.model.trim() : '';
  const autoRoute = input.autoRoute === true || requestedModel === 'auto';
  const routeBias = normalizeRouteBias(input.routeBias);
  // 自动/分工模式下，显式传入的模型保留为回退模型（分工时它就是规划者模型）。
  const model =
    ((autoRoute ? requestedModel !== 'auto' : true) && requestedModel) ||
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
  if (input.delegation !== undefined && !normalizeDelegation(input.delegation)) {
    throw new Error(`无效的 delegation: ${String(input.delegation)}`);
  }
  const delegation = normalizeDelegation(input.delegation) ?? host.settings().defaultDelegation ?? 'less';
  // 原生模式：显式传入为准；未传时跟随设置「模型路由 → 新会话默认」。
  const routeNative =
    typeof input.routeNative === 'boolean'
      ? input.routeNative
      : routingSettingsOf(host)?.native === true;

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
    ...(autoRoute ? { autoRoute: true } : {}),
    ...(routeBias ? { routeBias } : {}),
    permissionMode,
    ...(effort ? { effort } : {}),
    delegation,
    ...(routeNative ? { routeNative: true } : {}),
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
      autoRoute?: unknown;
      routeBias?: unknown;
      permissionMode?: unknown;
      pinned?: unknown;
      pinnedInProject?: unknown;
      pinnedTurns?: unknown;
      archived?: unknown;
      effort?: unknown;
      delegation?: unknown;
      routeNative?: unknown;
      cwd?: unknown;
    },): SessionRecord | undefined {
  const rec = host.store.get(id);
  if (!rec) return undefined;

  if (typeof patch.title === 'string' && patch.title.trim()) rec.title = patch.title.trim();
  if (typeof patch.cwd === 'string' && patch.cwd.trim()) {
    if (host.isRunning(id)) throw httpError('会话正在运行，无法切换目录', 409);
    if (host.remote) throw httpError('远端主机暂不支持切换目录，请新建会话', 501);
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
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort ?? '')) {
      throw new Error(`无效的 effort: ${patch.effort}`);
    }
    rec.effort = effort;
  }
  if (typeof patch.delegation === 'string') {
    const delegation = normalizeDelegation(patch.delegation);
    if (!delegation) throw new Error(`无效的 delegation: ${patch.delegation}`);
    rec.delegation = delegation;
  }
  if (typeof patch.routeNative === 'boolean') {
    if (patch.routeNative) rec.routeNative = true;
    else delete rec.routeNative;
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
  if (typeof patch.model === 'string' && patch.model.trim()) {
    const nextModel = patch.model.trim();
    if (nextModel === 'auto') {
      rec.autoRoute = true;
    } else {
      rec.model = nextModel;
      delete rec.autoRoute;
    }
  }
  if (typeof patch.autoRoute === 'boolean') {
    if (patch.autoRoute) rec.autoRoute = true;
    else delete rec.autoRoute;
  }
  const routeBias = normalizeRouteBias(patch.routeBias);
  if (routeBias) rec.routeBias = routeBias;
  if (typeof patch.pinned === 'boolean') {
    if (patch.pinned) rec.pinned = true;
    else delete rec.pinned;
  }
  if (typeof patch.pinnedInProject === 'boolean') {
    if (patch.pinnedInProject) rec.pinnedInProject = true;
    else delete rec.pinnedInProject;
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
    ...(src.routeBias ? { routeBias: src.routeBias } : {}),
    ...(src.routeNative ? { routeNative: true } : {}),
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
  host.devices.releaseSession(id);
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
