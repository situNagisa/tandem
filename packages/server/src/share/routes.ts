// 只读分享：管理接口走主 token，公开接口只认分享 token，且只能读对应会话。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CreateShareInput, ShareExpiry } from '@tandem/protocol';
import type { Host } from '../host.js';
import { ShareStore } from './store.js';
import { buildPublicShare } from './sanitize.js';
import { publicUrl } from '../util/address.js';

const EXPIRIES: ShareExpiry[] = ['1h', '1d', '7d', 'never'];

export function isPublicSharePath(urlPath: string): boolean {
  return urlPath.startsWith('/api/public/shares/');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function bad(reply: FastifyReply, message: string, code = 400): FastifyReply {
  return reply.code(code).send({ error: message });
}

function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/** 生成同事可访问的地址；Host 只监听回环时给出提示。 */
function shareUrl(app: FastifyInstance, id: string, token: string): { url: string; warning?: string } {
  return publicUrl(app, `/s/${id}#${token}`);
}

function parseInput(body: unknown): Required<Pick<CreateShareInput, 'includeToolOutputs' | 'hidePaths' | 'snapshot'>> & {
  expiresIn: ShareExpiry;
} {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const expiresIn = EXPIRIES.includes(raw.expiresIn as ShareExpiry)
    ? (raw.expiresIn as ShareExpiry)
    : '7d';
  return {
    expiresIn,
    includeToolOutputs: raw.includeToolOutputs !== false,
    hidePaths: raw.hidePaths !== false,
    snapshot: raw.snapshot === true,
  };
}

export function registerShareRoutes(app: FastifyInstance, host: Host): ShareStore {
  const store = new ShareStore(host.home);

  app.post('/api/sessions/:id/shares', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const input = parseInput(req.body);
    const { meta, token } = store.create({
      sessionId: rec.id,
      sessionTitle: rec.title,
      expiresIn: input.expiresIn,
      includeToolOutputs: input.includeToolOutputs,
      hidePaths: input.hidePaths,
      snapshot: input.snapshot,
    });
    if (meta.snapshot) {
      const data = buildPublicShare({
        shareId: meta.id,
        hostName: host.info().name,
        session: rec,
        options: meta,
        live: false,
        ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}),
      });
      store.writeSnapshot(meta.id, data);
    }
    const { url, warning } = shareUrl(app, meta.id, token);
    return reply.code(201).send({
      shareId: meta.id,
      url,
      ...(warning ? { warning } : {}),
      ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}),
    });
  });

  app.get('/api/shares', async () => store.list().map((meta) => store.info(meta)));

  app.delete('/api/shares/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.remove(id)) return bad(reply, '分享不存在', 404);
    return reply.code(204).send();
  });

  // 公开只读接口：不需要 Host 主 token，只认 Authorization: Share <token>。
  app.get('/api/public/shares/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    const { id } = req.params as { id: string };
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Share ') ? auth.slice('Share '.length).trim() : '';
    const query = (req.query ?? {}) as Record<string, unknown>;
    const countAccess = query.poll !== '1';
    const meta = store.verify(id, token, clientIp(req), countAccess);
    if (!meta) return bad(reply, '分享链接无效或已撤销', 404);
    if (store.isExpired(meta)) return bad(reply, '分享链接已过期', 404);
    const rec = host.getSession(meta.sessionId);
    if (!rec) return bad(reply, '会话不存在', 404);
    if (meta.snapshot) {
      const frozen = store.readSnapshot(meta.id);
      if (frozen) return { ...frozen, live: false };
    }
    return buildPublicShare({
      shareId: meta.id,
      hostName: host.info().name,
      session: rec,
      options: meta,
      live: true,
      ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}),
    });
  });

  app.addHook('onClose', async () => store.flush());
  return store;
}

