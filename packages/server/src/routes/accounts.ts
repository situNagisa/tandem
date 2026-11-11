// 主机上下文上报给工作站的账号状态。主机上下文与工作站同进程，不再有加入/退出工作站的接口。
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './common.js';

export function isPublicAccountPath(pathname: string): boolean {
  return pathname === '/api/accounts/status';
}

export function registerAccountRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;
  app.get('/api/accounts/status', async () => host.accounts.status());
}
