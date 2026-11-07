// 外部会话（只读，不写原软件文件）。
import type { FastifyInstance } from 'fastify';
import type { ExternalSource } from '@tandem/protocol';
import { bad, str, type RouteDeps } from './common.js';

function isExternalSource(value: string): value is ExternalSource {
  return value === 'claude-code' || value === 'codex';
}

export function registerExternalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/external-sessions', async (req, reply) => {
    const query = req.query as { source?: string; since?: string };
    const source = str(query.source);
    if (source && !isExternalSource(source)) return bad(reply, 'source 无效');
    const since = Number(query.since);
    return host.external.list(
      source ? (source as ExternalSource) : undefined,
      Number.isFinite(since) && since > 0 ? since : undefined,
    );
  });

  app.get('/api/external-sessions/:source/:id', async (req, reply) => {
    const { source, id } = req.params as { source: string; id: string };
    if (!isExternalSource(source)) return bad(reply, 'source 无效');
    const session = host.external.preview(source, id);
    if (!session) return bad(reply, '外部会话不存在', 404);
    return session;
  });

  app.post('/api/external-sessions/:source/:id/import', async (req, reply) => {
    const { source, id } = req.params as { source: string; id: string };
    if (!isExternalSource(source)) return bad(reply, 'source 无效');
    try {
      const rec = await host.external.importSession(source, id, (req.body ?? {}) as Record<string, unknown>);
      if (!rec) return bad(reply, '外部会话不存在', 404);
      await host.refreshEnv(rec.id);
      return reply.code(201).send(host.toSummary(rec));
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
}
