// 斜杠命令。
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expandHome } from '../util/path.js';
import { str, type RouteDeps } from './common.js';
import { memberCanAccessPath, principalOf, isOwnerLike } from '../team/access.js';

export function registerCommandRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/commands', async (req) => {
    const query = req.query as { cwd?: string };
    const principal = principalOf(req);
    const cwd = str(query.cwd) ? path.resolve(expandHome(str(query.cwd))) : process.cwd();
    if (!isOwnerLike(principal) && !memberCanAccessPath(principal, cwd)) return [];
    return host.listCommands(cwd);
  });
}
