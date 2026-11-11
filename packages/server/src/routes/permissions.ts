// Host 级权限规则。
import type { FastifyInstance } from 'fastify';
import { bad, str, type RouteDeps } from './common.js';

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
}
