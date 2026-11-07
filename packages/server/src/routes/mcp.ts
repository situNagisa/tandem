// MCP 服务器配置。
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expandHome } from '../util/path.js';
import { bad, str, type RouteDeps } from './common.js';

export function registerMcpRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/mcp', async (req) => {
    const query = req.query as { cwd?: string; retry?: string };
    const cwd = str(query.cwd) ? path.resolve(expandHome(str(query.cwd))) : undefined;
    const retry = str(query.retry) === '1';
    // GET 默认只补齐尚未连接的服务器，不重试失败项；只有显式刷新才强制重连。
    if (retry) void host.mcp.prepare(cwd, true);
    else if (cwd) void host.mcp.prepare(cwd, false, false);
    return { servers: host.mcp.servers(cwd), status: host.mcp.status(cwd) };
  });

  app.put('/api/mcp', async (req, reply) => {
    try {
      const servers = await host.mcp.save(req.body);
      return { servers, status: host.mcp.status() };
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
}
