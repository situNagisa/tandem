// 预算。
import type { FastifyInstance } from 'fastify';
import { bad, type RouteDeps } from './common.js';

export function registerBudgetRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/budgets', async () => host.budgets.list());

  app.put('/api/budgets', async (req, reply) => {
    try {
      return host.budgets.replace(req.body);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/budgets/status', async () => host.budgets.status());
}
