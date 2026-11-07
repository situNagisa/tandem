// Host 信息与本机设置。
import type { FastifyInstance } from 'fastify';
import type { ContextSettings, VoiceSettings } from '@tandem/protocol';
import type { RouteDeps } from './common.js';
import { principalOf } from '../team/access.js';

export function registerHostRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/host', async (req) => {
    const info = host.info();
    return principalOf(req).kind === 'member' ? { ...info, homeDir: '' } : info;
  });

  app.get('/api/settings', async () => host.settings());

  app.put('/api/settings', async (req) => {
    const body = (req.body ?? {}) as {
      resumeOnRestart?: unknown;
      voice?: unknown;
      context?: unknown;
      aiReview?: unknown;
    };
    return host.updateSettings({
      ...(body.resumeOnRestart === 'auto' || body.resumeOnRestart === 'pause'
        ? { resumeOnRestart: body.resumeOnRestart }
        : {}),
      ...(body.voice && typeof body.voice === 'object' ? { voice: body.voice as VoiceSettings } : {}),
      ...(body.context && typeof body.context === 'object'
        ? { context: body.context as ContextSettings }
        : {}),
      ...(body.aiReview && typeof body.aiReview === 'object'
        ? { aiReview: body.aiReview as import('@tandem/protocol').AiReviewSettings }
        : {}),
    });
  });
}
