// Hooks 配置。
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expandHome } from '../util/path.js';
import { bad, str, type RouteDeps } from './common.js';

export function registerHookRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/hooks', async (req) => {
    const query = req.query as { cwd?: string };
    const cwd = str(query.cwd) ? path.resolve(expandHome(str(query.cwd))) : undefined;
    return host.hooks.settings(cwd);
  });

  app.put('/api/hooks', async (req, reply) => {
    const body = (req.body ?? {}) as { cwd?: unknown; entries?: unknown };
    if (!Array.isArray(body.entries)) return bad(reply, 'entries 必须是数组');
    const cwd = str(body.cwd) ? path.resolve(expandHome(str(body.cwd))) : undefined;
    return host.hooks.save(body.entries, cwd);
  });

  app.put('/api/hooks/trust', async (req, reply) => {
    const body = (req.body ?? {}) as { cwd?: unknown; trusted?: unknown };
    const cwd = str(body.cwd);
    if (!cwd) return bad(reply, 'cwd 不能为空');
    return host.hooks.setTrust(path.resolve(expandHome(cwd)), body.trusted === true);
  });
}
