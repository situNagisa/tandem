// Host 级权限规则与审批转交。
import type { FastifyInstance } from 'fastify';
import { bad, str, type RouteDeps } from './common.js';
import { memberCanSeeSession, principalOf } from '../team/access.js';
import { recordAudit } from '../team/audit.js';

export function registerPermissionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/permissions', async () => host.permissionRules.list());

  app.put('/api/permissions', async (req, reply) => {
    try {
      return host.permissionRules.set(req.body);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  // 审批策略学习：统计、建议、一键采纳/忽略。
  app.get('/api/permissions/insights', async () => host.permissionInsights());

  app.post('/api/permissions/suggestions/:id/adopt', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return host.adoptPermissionSuggestion(id);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.delete('/api/permissions/suggestions/:id', async (req) => {
    const { id } = req.params as { id: string };
    host.ignorePermissionSuggestion(id);
    return { ok: true };
  });

  // 用户确认草稿后保存单条规则（避免整表覆盖与他人页面上的旧数据冲突）。
  app.post('/api/permissions/rules', async (req, reply) => {
    const body = (req.body ?? {}) as { rule?: unknown };
    try {
      return host.addPermissionRule(body.rule ?? req.body);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  // 自然语言 → 规则草稿；只返回草稿，不保存。命中危险模式直接 400。
  app.post('/api/permissions/draft', async (req, reply) => {
    const body = (req.body ?? {}) as { sessionId?: unknown; text?: unknown };
    const rec = host.store.get(str(body.sessionId));
    if (!rec) return bad(reply, '会话不存在', 404);
    try {
      return await host.draftPermissionRule(rec, str(body.text));
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  // 审批转交：选择一个有审批权且能看到该会话的成员，对方收件箱出现这条审批。
  app.post('/api/permissions/:requestId/transfer', async (req, reply) => {
    const { requestId } = req.params as { requestId: string };
    const body = (req.body ?? {}) as { toMemberId?: unknown };
    const toMemberId = typeof body.toMemberId === 'string' ? body.toMemberId.trim() : '';
    if (!toMemberId) return bad(reply, 'toMemberId 不能为空');
    const actor = principalOf(req);
    const found = host.findPendingPermission(requestId);
    if (!found) return bad(reply, '审批不存在或已处理', 404);
    const target = host.team.getMember(toMemberId);
    if (!target || target.revokedAt) return bad(reply, '目标成员不存在或已吊销', 404);
    if (target.role !== 'approver' && target.role !== 'collaborator') {
      return bad(reply, '只能转交给有审批权的成员', 400);
    }
    const targetPrincipal = {
      kind: 'member' as const,
      id: target.id,
      name: target.name,
      role: target.role,
      projectDirs: target.projectDirs,
    };
    if (!memberCanSeeSession(targetPrincipal, found.rec)) {
      return bad(reply, '目标成员无权查看该会话', 400);
    }
    const request = found.request;
    request.assignedTo = { memberId: target.id, name: target.name };
    request.transferredFrom = {
      memberId: actor.id,
      name: actor.name,
      at: Date.now(),
    };
    const message = {
      type: 'permission_transferred' as const,
      requestId: request.id,
      sessionId: found.rec.id,
      request,
      from: actor.name,
      to: target.name,
    };
    host.hub.broadcastSession(found.rec.id, message);
    for (const ancestor of host.ancestorsOf(found.rec)) {
      host.hub.broadcastSession(ancestor.id, message);
    }
    // 先让客户端移除旧的待办，再推送转交后的目标事件，否则目标收件箱会被清空。
    const event = host.inbox.retargetPermission(request);
    if (event) host.pushInbox(event);
    recordAudit(host, actor, 'permission.transfer', {
      sessionId: found.rec.id,
      sessionTitle: found.rec.title,
      detail: `${request.toolName} → ${target.name}`,
    });
    return request;
  });
}
