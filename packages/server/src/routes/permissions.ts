// Host 级权限规则的读写。
import type { FastifyInstance } from 'fastify';
import { bad, type RouteDeps } from './common.js';

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
}
