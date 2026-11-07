// Skills（兼容 Claude Code 的 SKILL.md）。
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expandHome } from '../util/path.js';
import { bad, str, type RouteDeps } from './common.js';

export function registerSkillRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/skills', async (req) => {
    const query = req.query as { cwd?: string };
    const cwd = str(query.cwd) ? path.resolve(expandHome(str(query.cwd))) : process.cwd();
    return host.listSkills(cwd);
  });

  app.put('/api/skills/state', async (req, reply) => {
    const body = (req.body ?? {}) as { disabled?: unknown; cwd?: unknown };
    if (!Array.isArray(body.disabled)) return bad(reply, 'disabled 必须是路径数组');
    const cwd = str(body.cwd) ? path.resolve(expandHome(str(body.cwd))) : process.cwd();
    return host.setSkillState(
      body.disabled.filter((item): item is string => typeof item === 'string'),
      cwd,
    );
  });
}
