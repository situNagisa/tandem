// 斜杠命令。
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expandHome } from '../util/path.js';
import { str, type RouteDeps } from './common.js';

export function registerCommandRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/commands', async (req) => {
    const query = req.query as { cwd?: string };
    const cwd = str(query.cwd) ? path.resolve(expandHome(str(query.cwd))) : process.cwd();
    return host.listCommands(cwd);
  });
}
