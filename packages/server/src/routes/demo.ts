// 演示工作区：创建 / 重播 / 动态步骤 / 清除。
import type { FastifyInstance } from 'fastify';
import { bad, type RouteDeps } from './common.js';

export function registerDemoRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/demo', async () => host.demo.get());

  app.post('/api/demo', async (_req, reply) => {
    try {
      return await host.demo.create();
    } catch (err) {
      return bad(reply, (err as Error).message || '创建演示工作区失败', 500);
    }
  });

  app.delete('/api/demo', async (_req, reply) => {
    try {
      await host.demo.clear();
      return { ok: true };
    } catch (err) {
      return bad(reply, (err as Error).message || '清除演示工作区失败', 500);
    }
  });

  app.post('/api/demo/scenarios/:id/replay', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await host.demo.replay(id);
    } catch (err) {
      return bad(reply, (err as Error).message || '重新播放失败');
    }
  });

  app.post('/api/demo/scenarios/:id/play', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = host.demo.play(id);
    if (!ok) return bad(reply, '演示场景不存在或尚未创建', 404);
    return { ok: true };
  });
}
