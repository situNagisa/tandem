// 提示词注册表。
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expandHome } from '../util/path.js';
import { bad, str, type RouteDeps } from './common.js';

export function registerPromptTemplateRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/prompt-templates', async (req) => {
    const query = req.query as { cwd?: string };
    const cwd = str(query.cwd) ? path.resolve(expandHome(str(query.cwd))) : undefined;
    return { templates: host.promptTemplates.list(cwd) };
  });

  app.put('/api/prompt-templates', async (req, reply) => {
    const body = (req.body ?? {}) as { values?: unknown; cwd?: unknown };
    const cwd = str(body.cwd) ? path.resolve(expandHome(str(body.cwd))) : undefined;
    try {
      return { templates: host.promptTemplates.save(body.values, cwd) };
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
}
