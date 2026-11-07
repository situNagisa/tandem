// 浏览器操作：设置、能力探测、会话状态与截图。
import type { FastifyInstance } from 'fastify';
import type { BrowserSettings } from '@tandem/protocol';
import { sanitizeBrowserSettings } from '../browser.js';
import type { RouteDeps } from './common.js';

export function registerBrowserRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/browser/settings', async () => host.browser.settings);

  app.put('/api/browser/settings', async (req) => {
    const body = (req.body ?? {}) as Partial<BrowserSettings>;
    return host.browser.updateSettings(sanitizeBrowserSettings({ ...host.browser.settings, ...body }));
  });

  app.get('/api/browser/status', async () => host.browser.status());

  app.get('/api/sessions/:id/browser/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!host.store.get(id)) return reply.code(404).send({ error: '会话不存在' });
    return host.browser.stateOf(id);
  });

  app.get('/api/sessions/:id/browser/screenshot', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { shot } = req.query as { shot?: string };
    if (!host.store.get(id)) return reply.code(404).send({ error: '会话不存在' });
    const image = host.browser.shot(id, shot);
    if (!image) return reply.code(404).send({ error: '没有可用的截图' });
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'private, max-age=300')
      .send(image.data);
  });
}
