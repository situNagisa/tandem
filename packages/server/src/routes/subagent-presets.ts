// 子代理预设。
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expandHome } from '../util/path.js';
import { bad, str, type RouteDeps } from './common.js';

export function registerSubagentPresetRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/subagent-presets', async (req) => {
    const query = req.query as { cwd?: string };
    const cwd = str(query.cwd) ? path.resolve(expandHome(str(query.cwd))) : undefined;
    return { presets: host.subagentPresets.list(cwd) };
  });

  app.put('/api/subagent-presets', async (req, reply) => {
    const body = (req.body ?? {}) as { cwd?: unknown; presets?: unknown };
    const cwd = str(body.cwd) ? path.resolve(expandHome(str(body.cwd))) : undefined;
    try {
      return { presets: host.subagentPresets.save(body.presets, cwd) };
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
}
