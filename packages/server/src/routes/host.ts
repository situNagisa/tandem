// Host 信息与本机设置。
import type { FastifyInstance } from 'fastify';
import type { VoiceSettings } from '@tandem/protocol';
import type { RouteDeps } from './common.js';

export function registerHostRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/host', async () => host.info());

  app.get('/api/settings', async () => host.settings());

  app.put('/api/settings', async (req) => {
    const body = (req.body ?? {}) as { resumeOnRestart?: unknown; voice?: unknown };
    return host.updateSettings({
      ...(body.resumeOnRestart === 'auto' || body.resumeOnRestart === 'pause'
        ? { resumeOnRestart: body.resumeOnRestart }
        : {}),
      ...(body.voice && typeof body.voice === 'object' ? { voice: body.voice as VoiceSettings } : {}),
    });
  });
}
