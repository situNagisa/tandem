// 评测：用例 CRUD、批量运行、结果读取与取消。
import type { FastifyInstance } from 'fastify';
import type { SaveEvalCaseInput, StartEvalRunInput } from '@tandem/protocol';
import { errorMessage } from '../util/text.js';
import { bad, type RouteDeps } from './common.js';

export function registerEvalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/evals/suites', async () => ({ suites: host.evals.listSuites() }));

  app.get('/api/evals/cases', async (req) => {
    const query = req.query as { suite?: string };
    return { cases: host.evals.listCases(query.suite) };
  });

  app.post('/api/evals/cases', async (req, reply) => {
    try {
      return await host.evals.saveCase((req.body ?? {}) as SaveEvalCaseInput);
    } catch (err) {
      return bad(reply, errorMessage(err));
    }
  });

  app.delete('/api/evals/cases/:suite/:name', async (req, reply) => {
    const params = req.params as { suite: string; name: string };
    if (!host.evals.deleteCase(params.suite, params.name)) return bad(reply, '评测用例不存在', 404);
    return { ok: true };
  });

  app.get('/api/evals/runs', async () => host.evals.listRuns());

  app.post('/api/evals/runs', async (req, reply) => {
    try {
      return host.evals.start((req.body ?? {}) as StartEvalRunInput);
    } catch (err) {
      return bad(reply, errorMessage(err));
    }
  });

  app.get('/api/evals/runs/:id', async (req, reply) => {
    const params = req.params as { id: string };
    const run = host.evals.getRun(params.id);
    if (!run) return bad(reply, '评测运行不存在', 404);
    return run;
  });

  app.post('/api/evals/runs/:id/cancel', async (req, reply) => {
    const params = req.params as { id: string };
    if (!host.evals.cancel(params.id)) return bad(reply, '评测运行不存在或已结束', 404);
    return { ok: true };
  });
}
