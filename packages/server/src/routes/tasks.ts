// 后台任务。
import type { FastifyInstance } from 'fastify';
import { bad, str, type RouteDeps } from './common.js';

export function registerTaskRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/tasks', async (req) => {
    const query = req.query as { sessionId?: string };
    return host.tasks.list(str(query.sessionId) || undefined);
  });

  app.get('/api/tasks/:id/output', async (req, reply) => {
    const params = req.params as { id: string };
    const query = req.query as { since?: string };
    const since = Number(query.since);
    const result = host.tasks.output(params.id, Number.isFinite(since) ? since : 0);
    if (!result) return bad(reply, '后台任务不存在', 404);
    return result;
  });

  app.post('/api/tasks/:id/kill', async (req, reply) => {
    const params = req.params as { id: string };
    const task = await host.tasks.kill(params.id);
    if (!task) return bad(reply, '后台任务不存在', 404);
    return task;
  });
}
