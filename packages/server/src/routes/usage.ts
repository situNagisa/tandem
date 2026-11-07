// 用量统计。
import type { FastifyInstance } from 'fastify';
import { str, type RouteDeps } from './common.js';

export function registerUsageRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/usage', async (req) => {
    const query = req.query as { from?: string; to?: string };
    return host.usage.list(str(query.from) || undefined, str(query.to) || undefined);
  });
}
