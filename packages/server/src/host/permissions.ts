// 权限审批：规则判定、plan 模式、会话级 allow、待审批冒泡与重启恢复。
import { randomUUID } from 'node:crypto';
import type { PermissionDecision, PermissionRequest } from '@tandem/protocol';
import { persist as persistRunState } from '../run-state.js';
import { PLAN_ALLOWED, describeTool } from '../tools/index.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';
import { commandPrefix } from './helpers.js';

export async function requestPlanApproval(host: Host, rec: SessionRecord,
    planInput: unknown,
    toolUseId: string,
    signal: AbortSignal): Promise<{ allowed: boolean; reason?: string }> {
  if (rec.permissionMode !== 'plan') {
    return { allowed: false, reason: 'ExitPlanMode 只能在计划模式下使用' };
  }
  const content = typeof planInput === 'string' ? planInput.trim() : '';
  if (!content) {
    return { allowed: false, reason: '计划内容为空：请通过 plan 参数提交 markdown 计划' };
  }
  if (signal.aborted) return { allowed: false, reason: '用户中断' };

  rec.plan = { content, createdAt: Date.now(), status: 'pending' };
  host.store.markDirty(rec.id, true);
  host.hub.broadcastSession(rec.id, { type: 'plan', sessionId: rec.id, plan: { ...rec.plan } });

  const result = await host.askPermission(rec, 'ExitPlanMode', { plan: content }, toolUseId, signal);
  if (signal.aborted) return { allowed: false, reason: '用户中断' };
  if (!result.allowed) {
    rec.plan = { ...rec.plan, status: 'rejected' };
    host.store.markDirty(rec.id, true);
    host.hub.broadcastSession(rec.id, { type: 'plan', sessionId: rec.id, plan: { ...rec.plan } });
    return { allowed: false, reason: result.reason ?? '用户要求继续完善计划' };
  }

  const mode: 'acceptEdits' | 'default' = result.decision === 'allow_always' ? 'acceptEdits' : 'default';
  rec.permissionMode = mode;
  rec.plan = { ...rec.plan, status: 'approved', approvalMode: mode };
  host.store.markDirty(rec.id, true);
  host.hub.broadcastSession(rec.id, { type: 'plan', sessionId: rec.id, plan: { ...rec.plan } });
  host.broadcastSummary(rec);
  return {
    allowed: true,
    reason:
      mode === 'acceptEdits'
        ? '计划已获批准，已切换到自动接受编辑模式，请开始执行计划。'
        : '计划已获批准，请开始执行计划（编辑操作会逐个询问）。',
  };
}

export async function authorize(host: Host, rec: SessionRecord,
    toolName: string,
    input: unknown,
    toolUseId: string,
    signal: AbortSignal): Promise<{ allowed: boolean; reason?: string }> {
  const def = host.toolDefinition(toolName, rec.cwd);
  const mode = rec.permissionMode;

  // plan 模式：只允许只读工具，写类工具直接拒绝
  if (mode === 'plan' && !PLAN_ALLOWED.has(toolName)) {
    return { allowed: false, reason: `plan 模式下不允许执行 ${toolName}（只允许只读工具）` };
  }
  if (!def) return { allowed: true }; // 交给执行器返回“未知工具”

  // Host 级规则：deny > ask > allow，deny 在 bypassPermissions 下依然生效
  const rule = host.permissionRules.evaluate(toolName, input, rec.cwd);
  if (rule === 'deny') {
    return { allowed: false, reason: `被权限规则拒绝: ${describeTool(toolName, input)}` };
  }
  if (mode === 'bypassPermissions') return { allowed: true };
  if (rule === 'ask') {
    if (signal.aborted) return { allowed: false, reason: '用户中断' };
    return host.askPermission(rec, toolName, input, toolUseId, signal);
  }
  if (rule === 'allow') return { allowed: true };

  // Memory 的 view 是纯读取；写入按 Edit 类操作审批
  if (toolName === 'Memory' && (input as Record<string, unknown> | null)?.action === 'view') {
    return { allowed: true };
  }
  // 只读且无需审批的工具直接放行
  if (def.readOnly && !def.requiresApproval) return { allowed: true };
  // 会话级 allow_always 优先于权限模式的默认行为
  if (host.isAllowed(rec, toolName, input)) return { allowed: true };
  if (
    mode === 'acceptEdits' &&
    (toolName === 'Write' || toolName === 'Edit' || toolName === 'Memory')
  ) {
    return { allowed: true };
  }
  if (!def.requiresApproval) return { allowed: true };
  if (signal.aborted) return { allowed: false, reason: '用户中断' };

  return host.askPermission(rec, toolName, input, toolUseId, signal);
}

export function isAllowed(host: Host, rec: SessionRecord, toolName: string, input: unknown): boolean {
  const command =
    toolName === 'Bash' && input && typeof input === 'object'
      ? String((input as Record<string, unknown>).command ?? '').replace(/\s+/g, ' ').trim()
      : '';
  for (const entry of rec.allowedTools) {
    if (entry === toolName) return true;
    if (toolName === 'Bash' && entry.startsWith('Bash:')) {
      const prefix = entry.slice('Bash:'.length);
      if (prefix && command.startsWith(prefix)) return true;
    }
  }
  return false;
}

export function askPermission(host: Host, rec: SessionRecord,
    toolName: string,
    input: unknown,
    toolUseId: string,
    signal: AbortSignal): Promise<{ allowed: boolean; reason?: string; decision?: PermissionDecision }> {
  const rt = host.ensureRuntime(rec.id);
  const request: PermissionRequest = {
    id: randomUUID(),
    sessionId: rec.id,
    toolUseId,
    toolName,
    input,
    description: describeTool(toolName, input),
    ...(rec.parentId
      ? { depth: rec.depth ?? 1, sourceTitle: rec.title }
      : {}),
  };
  const ancestors = host.ancestorsOf(rec);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (decision: PermissionDecision, customReason?: string) => {
      if (settled) return;
      settled = true;
      host.permissions.delete(request.id);
      rt.pending.delete(request.id);
      signal.removeEventListener('abort', onAbort);
      persistRunState(host, rec);

      if (decision === 'allow_always' && toolName !== 'ExitPlanMode') {
        host.addAllowed(rec, toolName, input);
      }
      host.hub.broadcastSession(rec.id, {
        type: 'permission_resolved',
        requestId: request.id,
        sessionId: rec.id,
        decision,
      });
      // 收件箱：任意一端处理后，所有端从待审批列表移除
      const resolved = host.inbox.resolvePermission(request.id, decision);
      if (resolved) host.pushInbox(resolved);
      // 逐级冒泡：祖先会话（子代理/主会话）的订阅者都能同步审批状态
      for (const ancestor of ancestors) {
        host.hub.broadcastSession(ancestor.id, {
          type: 'permission_resolved',
          requestId: request.id,
          sessionId: rec.id,
          decision,
        });
      }
      if (rt.pending.size === 0 && rt.running && !rt.interrupted && rec.status === 'waiting_permission') {
        host.setStatus(rec, 'running');
      }
      resolve({
        allowed: decision !== 'deny',
        decision,
        reason:
          decision === 'deny'
            ? customReason?.trim() ||
              (signal.aborted ? '用户中断' : '用户拒绝了该操作')
            : undefined,
      });
    };
    const onAbort = () => settle('deny');

    rt.pending.set(request.id, { request, resolve: settle });
    host.permissions.set(request.id, { sessionId: rec.id, resolve: settle });
    signal.addEventListener('abort', onAbort, { once: true });
    persistRunState(host, rec);

    host.setStatus(rec, 'waiting_permission');
    host.hub.broadcastSession(rec.id, { type: 'permission_request', request, sessionId: rec.id });
    // 收件箱：一次请求只记一条（不按祖先重复），带上会话标题与子代理来源
    host.pushInbox(host.inbox.recordPermission(request, rec.title));
    // 子代理/孙代理的权限请求逐级冒泡，主会话订阅者可直接审批
    for (const ancestor of ancestors) {
      host.hub.broadcastSession(ancestor.id, { type: 'permission_request', request, sessionId: ancestor.id });
    }
  });
}

export function resolvePermission(host: Host, requestId: string, decision: PermissionDecision, reason?: string): void {
  if (decision !== 'allow' && decision !== 'allow_always' && decision !== 'deny') return;
  host.permissions.get(requestId)?.resolve(
    decision,
    typeof reason === 'string' ? reason : undefined,
  );
}

export function restorePendingPermission(host: Host, rec: SessionRecord,
    request: PermissionRequest,
    signal: AbortSignal): Promise<{ decision: PermissionDecision; reason?: string }> {
  const rt = host.ensureRuntime(rec.id);
  const ancestors = host.ancestorsOf(rec);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (decision: PermissionDecision, customReason?: string) => {
      if (settled) return;
      settled = true;
      host.permissions.delete(request.id);
      rt.pending.delete(request.id);
      signal.removeEventListener('abort', onAbort);
      if (decision === 'allow_always' && request.toolName !== 'ExitPlanMode') {
        host.addAllowed(rec, request.toolName, request.input);
      }
      host.hub.broadcastSession(rec.id, {
        type: 'permission_resolved',
        requestId: request.id,
        sessionId: rec.id,
        decision,
      });
      const resolved = host.inbox.resolvePermission(request.id, decision);
      if (resolved) host.pushInbox(resolved);
      for (const ancestor of ancestors) {
        host.hub.broadcastSession(ancestor.id, {
          type: 'permission_resolved',
          requestId: request.id,
          sessionId: rec.id,
          decision,
        });
      }
      if (
        rt.pending.size === 0 &&
        rt.running &&
        !rt.interrupted &&
        rec.status === 'waiting_permission'
      ) {
        host.setStatus(rec, 'running');
      }
      persistRunState(host, rec);
      resolve({
        decision,
        ...(decision === 'deny'
          ? {
              reason:
                customReason?.trim() ||
                (signal.aborted ? '用户中断' : '用户拒绝了该操作'),
            }
          : {}),
      });
    };
    const onAbort = () => settle('deny', signal.aborted ? '用户中断' : undefined);

    rt.pending.set(request.id, { request, resolve: settle });
    host.permissions.set(request.id, { sessionId: rec.id, resolve: settle });
    signal.addEventListener('abort', onAbort, { once: true });
    host.setStatus(rec, 'waiting_permission');
    host.hub.broadcastSession(rec.id, { type: 'permission_request', request, sessionId: rec.id });
    host.pushInbox(host.inbox.recordPermission(request, rec.title));
    for (const ancestor of ancestors) {
      host.hub.broadcastSession(ancestor.id, {
        type: 'permission_request',
        request,
        sessionId: ancestor.id,
      });
    }
    persistRunState(host, rec);
  });
}

export function addAllowed(host: Host, rec: SessionRecord, toolName: string, input: unknown): void {
  if (toolName === 'ExitPlanMode') return;
  let entry = toolName;
  if (toolName === 'Bash' && input && typeof input === 'object') {
    const command = String((input as Record<string, unknown>).command ?? '');
    entry = `Bash:${commandPrefix(command)}`;
  }
  if (!rec.allowedTools.includes(entry)) {
    rec.allowedTools.push(entry);
    host.store.markDirty(rec.id, true);
  }
}

export function ancestorsOf(host: Host, rec: SessionRecord): SessionRecord[] {
  const out: SessionRecord[] = [];
  const seen = new Set<string>([rec.id]);
  let cursor = rec;
  while (cursor.parentId) {
    if (seen.has(cursor.parentId)) break;
    seen.add(cursor.parentId);
    const parent = host.store.get(cursor.parentId);
    if (!parent) break;
    out.push(parent);
    cursor = parent;
  }
  return out;
}
