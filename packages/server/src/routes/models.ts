// 模型列表与能力查询。
import type { FastifyInstance } from 'fastify';
import type { ListModelsInput, ProviderKind } from '@tandem/protocol';
import { PROVIDER_KINDS, bad, str, type RouteDeps } from './common.js';

export function registerModelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/models/capabilities', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const profileId = str(query.profileId);
    const model = str(query.model);
    if (!profileId || !model) return bad(reply, 'profileId 与 model 不能为空');
    const info = await host.modelCapabilities(profileId, str(query.groupId) || undefined, model);
    if (!info) return bad(reply, '账号不存在', 404);
    return info;
  });

  app.post('/api/models', async (req) => {
    const raw = (req.body ?? {}) as Partial<ListModelsInput>;
    const kind = str(raw.kind) as ProviderKind;
    if (!PROVIDER_KINDS.includes(kind)) {
      return { ok: false, models: [], error: 'provider 类型无效' };
    }
    const profileId = str(raw.profileId) || undefined;
    if (profileId && !host.profiles.get(profileId)) {
      return { ok: false, models: [], error: '账号不存在' };
    }
    return host.listModels({
      kind,
      baseUrl: str(raw.baseUrl) || undefined,
      apiKey: str(raw.apiKey) || undefined,
      profileId,
      groupId: str(raw.groupId) || undefined,
    });
  });
}
