// 项目 Wiki：元数据、页面读写、检索、预估与后台生成任务。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bad, str, type RouteDeps } from './common.js';
import { isOwner, canAccessPath, principalOf } from '../access.js';

function projectOf(req: FastifyRequest, body?: Record<string, unknown>): string {
  const query = req.query as { project?: unknown };
  return str(body?.project) || str(query.project);
}

function assertProject(req: FastifyRequest, project: string): void {
  const principal = principalOf(req);
  if (!project) throw new Error('project 不能为空');
  if (!canAccessPath(principal, project)) throw new Error('没有该项目权限');
}

export function registerWikiRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/wiki', async (req, reply) => {
    const project = projectOf(req);
    try {
      assertProject(req, project);
      return host.wiki.meta(project);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/wiki/page', async (req, reply) => {
    const query = req.query as { project?: unknown; page?: unknown };
    try {
      const project = projectOf(req);
      assertProject(req, project);
      return host.wiki.page(project, str(query.page));
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.put('/api/wiki/page', async (req, reply) => {
    if (!isOwner(req)) return bad(reply, '只有 Host 所有者可以编辑 Wiki', 403);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const project = projectOf(req, body);
      assertProject(req, project);
      return host.wiki.saveManual(project, str(body.page), typeof body.manual === 'string' ? body.manual : '');
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/wiki/search', async (req, reply) => {
    const query = req.query as { project?: unknown; q?: unknown; limit?: unknown };
    try {
      const project = projectOf(req);
      assertProject(req, project);
      const limit = Number.isFinite(Number(query.limit)) ? Number(query.limit) : 8;
      return host.wiki.search(project, str(query.q), limit);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/wiki/estimate', async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    try {
      const project = projectOf(req);
      assertProject(req, project);
      return host.wiki.estimate({
        project,
        mode: query.mode === 'update' ? 'update' : 'generate',
        ...(str(query.profileId) ? { profileId: str(query.profileId) } : {}),
        ...(str(query.groupId) ? { groupId: str(query.groupId) } : {}),
        ...(str(query.model) ? { model: str(query.model) } : {}),
      });
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/wiki/generate', async (req, reply) => {
    if (!isOwner(req)) return bad(reply, '只有 Host 所有者可以生成 Wiki', 403);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const project = projectOf(req, body);
      assertProject(req, project);
      const maxCostUsd = Number(body.maxCostUsd);
      return host.wiki.start({
        project,
        mode: body.mode === 'update' ? 'update' : 'generate',
        ...(str(body.profileId) ? { profileId: str(body.profileId) } : {}),
        ...(str(body.groupId) ? { groupId: str(body.groupId) } : {}),
        ...(str(body.model) ? { model: str(body.model) } : {}),
        ...(str(body.effort) ? { effort: str(body.effort) as import('@tandem/protocol').ReasoningEffort } : {}),
        ...(Number.isFinite(maxCostUsd) && maxCostUsd > 0 ? { maxCostUsd } : {}),
      });
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/wiki/jobs', async (req, reply) => {
    const project = projectOf(req);
    try {
      assertProject(req, project);
      return host.wiki.jobsFor(project);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/wiki/jobs/:id/cancel', async (req, reply) => {
    if (!isOwner(req)) return bad(reply, '只有 Host 所有者可以取消生成', 403);
    const { id } = req.params as { id: string };
    return { ok: host.wiki.cancel(id) };
  });

  app.post('/api/wiki/schedule', async (req, reply) => {
    if (!isOwner(req)) return bad(reply, '只有 Host 所有者可以创建定时更新', 403);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const project = projectOf(req, body);
      assertProject(req, project);
      return host.wiki.ensureDailySchedule(project);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
}
