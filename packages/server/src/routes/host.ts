// Host 信息与本机设置。
import type { FastifyInstance } from 'fastify';
import type { ContextSettings, VoiceSettings } from '@tandem/protocol';
import type { RouteDeps } from './common.js';
import { principalOf, isOwnerLike } from '../access.js';

export function registerHostRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/host', async (req) => {
    const info = host.info();
    return isOwnerLike(principalOf(req)) ? info : { ...info, homeDir: '' };
  });

  app.get('/api/settings', async () => host.settings());

  app.put('/api/settings', async (req) => {
    const body = (req.body ?? {}) as {
      resumeOnRestart?: unknown;
      voice?: unknown;
      context?: unknown;
      aiReview?: unknown;
      handoff?: unknown;
      modelRouting?: unknown;
      sandbox?: unknown;
      updateShareDir?: unknown;
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
      ...(body.handoff && typeof body.handoff === 'object'
        ? { handoff: body.handoff as import('@tandem/protocol').HandoffSettings }
        : {}),
      ...(body.modelRouting && typeof body.modelRouting === 'object'
        ? { modelRouting: body.modelRouting as import('@tandem/protocol').ModelRoutingSettings }
        : {}),
      ...(body.sandbox && typeof body.sandbox === 'object'
        ? { sandbox: body.sandbox as import('@tandem/protocol').SandboxSettings }
        : {}),
      ...(typeof body.updateShareDir === 'string' ? { updateShareDir: body.updateShareDir } : {}),
    });
  });

  app.get('/api/sandbox/status', async () => host.sandboxStatusInfo());
}
