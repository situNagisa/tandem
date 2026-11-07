// 项目记忆。
import type { FastifyInstance } from 'fastify';
import { bad, str, type RouteDeps } from './common.js';

export function registerMemoryRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/memory', async (req, reply) => {
    const query = req.query as { scope?: string; project?: string };
    const scope = query.scope === 'global' ? 'global' : 'project';
    try {
      return host.memory.read(scope, str(query.project) || undefined);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.put('/api/memory', async (req, reply) => {
    const body = (req.body ?? {}) as { scope?: unknown; project?: unknown; text?: unknown };
    const scope = body.scope === 'global' ? 'global' : 'project';
    const project = typeof body.project === 'string' ? body.project : undefined;
    if (typeof body.text !== 'string') return bad(reply, 'text 必须是字符串');
    try {
      return host.memory.write(scope, project, body.text);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.delete('/api/memory', async (req, reply) => {
    const query = req.query as { scope?: string; project?: string };
    const scope = query.scope === 'global' ? 'global' : 'project';
    try {
      return { ok: host.memory.remove(scope, str(query.project) || undefined) };
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/memory/list', async () => host.memory.listItems());

  app.post('/api/memory/import', async (req, reply) => {
    const body = (req.body ?? {}) as {
      project?: unknown;
      text?: unknown;
      source?: unknown;
      scope?: unknown;
    };
    if (typeof body.project !== 'string' || !body.project) return bad(reply, 'project 不能为空');
    if (typeof body.text !== 'string' || !body.text.trim()) return bad(reply, 'text 不能为空');
    const scope = body.scope === 'global' ? 'global' : 'project';
    try {
      const result = host.memory.merge(
        scope,
        scope === 'project' ? body.project : undefined,
        body.text,
        typeof body.source === 'string' ? body.source : '其它 Host',
      );
      return { ok: true, merged: result.merged, entries: result.file.entries };
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
}
