// 仅调试版加载：演示工作区路由随后端模块一起在发布构建中被剔除。
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../routes/common.js';

export async function registerDebugDemoRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { registerDemoRoutes } = await import('../routes/demo.js');
  registerDemoRoutes(app, deps);
}
