// 定时任务。
import type { FastifyInstance } from 'fastify';
import type { ScheduleInput } from '@tandem/protocol';
import { errorMessage } from '../util/text.js';
import { bad, type RouteDeps } from './common.js';

export function registerScheduleRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/schedules', async () => host.schedules.list());

  app.post('/api/schedules', async (req, reply) => {
    try {
      return host.schedules.upsert(req.body as ScheduleInput);
    } catch (err) {
      return bad(reply, errorMessage(err));
    }
  });

  app.put('/api/schedules/:id', async (req, reply) => {
    const params = req.params as { id: string };
    try {
      return host.schedules.upsert(req.body as ScheduleInput, params.id);
    } catch (err) {
      return bad(reply, errorMessage(err));
    }
  });

  app.delete('/api/schedules/:id', async (req, reply) => {
    const params = req.params as { id: string };
    if (!host.schedules.remove(params.id)) return bad(reply, '定时任务不存在', 404);
    return { ok: true };
  });

  app.post('/api/schedules/:id/run', async (req, reply) => {
    const params = req.params as { id: string };
    const result = await host.schedules.run(params.id, true);
    if (!result.ok && result.error === '定时任务不存在') return bad(reply, result.error, 404);
    return result;
  });
}
