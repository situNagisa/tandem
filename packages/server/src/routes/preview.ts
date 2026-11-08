// 应用预览：自动识别地址、打开/刷新/设备尺寸、点选元素与改前快照。
import type { FastifyInstance } from 'fastify';
import { bad } from './common.js';
import type { RouteDeps } from './common.js';

export function registerPreviewRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  const withSession = (
    id: string,
    reply: Parameters<typeof bad>[0],
  ): boolean => {
    if (!host.store.get(id)) {
      bad(reply, '会话不存在', 404);
      return false;
    }
    return true;
  };

  app.get('/api/sessions/:id/preview/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    return host.preview.stateOf(id);
  });

  app.post('/api/sessions/:id/preview/open', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    const body = (req.body ?? {}) as { url?: unknown; width?: unknown; height?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    try {
      return await host.preview.open(id, url, {
        ...(typeof body.width === 'number' ? { width: body.width } : {}),
        ...(typeof body.height === 'number' ? { height: body.height } : {}),
      });
    } catch (err) {
      return bad(reply, (err as Error).message || '打开预览失败');
    }
  });

  app.post('/api/sessions/:id/preview/reload', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    return host.preview.reload(id);
  });

  app.post('/api/sessions/:id/preview/back', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    return host.preview.back(id);
  });

  app.post('/api/sessions/:id/preview/forward', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    return host.preview.forward(id);
  });

  app.post('/api/sessions/:id/preview/resize', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    const body = (req.body ?? {}) as { width?: unknown; height?: unknown };
    if (typeof body.width !== 'number' || typeof body.height !== 'number') {
      return bad(reply, 'width/height 必须是数字');
    }
    return host.preview.resize(id, body.width, body.height);
  });

  app.get('/api/sessions/:id/preview/detect', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    return host.preview.detect(id);
  });

  app.post('/api/sessions/:id/preview/select', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    const body = (req.body ?? {}) as { x?: unknown; y?: unknown };
    if (typeof body.x !== 'number' || typeof body.y !== 'number') {
      return bad(reply, 'x/y 必须是数字');
    }
    try {
      return await host.preview.select(id, body.x, body.y);
    } catch (err) {
      return bad(reply, (err as Error).message || '选取元素失败');
    }
  });

  app.get('/api/sessions/:id/preview/screenshot', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    const { shot } = req.query as { shot?: string };
    const image = host.preview.shot(id, shot);
    if (!image) return bad(reply, '没有可用的预览截图', 404);
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'private, max-age=300')
      .send(image.data);
  });

  app.get('/api/sessions/:id/preview/snapshots', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    return host.preview.snapshots(id);
  });

  app.post('/api/sessions/:id/preview/snapshots', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    const body = (req.body ?? {}) as { label?: unknown };
    try {
      return await host.preview.snapshot(id, typeof body.label === 'string' ? body.label : undefined);
    } catch (err) {
      return bad(reply, (err as Error).message || '截取快照失败');
    }
  });

  app.delete('/api/sessions/:id/preview/snapshots/:snapshotId', async (req, reply) => {
    const { id, snapshotId } = req.params as { id: string; snapshotId: string };
    if (!withSession(id, reply)) return reply;
    if (!host.preview.deleteSnapshot(id, snapshotId)) return bad(reply, '快照不存在', 404);
    return reply.code(204).send();
  });

  app.get('/api/sessions/:id/preview/mount', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!withSession(id, reply)) return reply;
    return host.preview.mount(id, req.socket.remoteAddress);
  });
}
