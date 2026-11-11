// 账号（provider profile）与其分组。
import type { FastifyInstance } from 'fastify';
import type { ProfileGroupInput, ProfileInput, ProviderKind } from '@tandem/protocol';
import { testProfile } from '../providers/index.js';
import { truncateEnd } from '../util/text.js';
import { PROVIDER_KINDS, bad, str, type RouteDeps } from './common.js';
import { isOwner, sanitizeProfilesForViewer } from '../access.js';

export function parseProfileInput(body: unknown): ProfileInput {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const kind = str(raw.kind) as ProviderKind;
  if (!PROVIDER_KINDS.includes(kind)) throw new Error('provider 类型无效');
  const models = Array.isArray(raw.models)
    ? raw.models.map((m) => str(m)).filter(Boolean)
    : [];
  const name = str(raw.name);
  if (!name) throw new Error('name 不能为空');
  const defaultModel = str(raw.defaultModel) || models[0] || '';
  if (!defaultModel) throw new Error('defaultModel 不能为空');
  return {
    name,
    kind,
    baseUrl: str(raw.baseUrl) || undefined,
    ...(raw.balanceQuery && typeof raw.balanceQuery === 'object'
      ? { balanceQuery: raw.balanceQuery as NonNullable<ProfileInput['balanceQuery']> }
      : {}),
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
    models,
    defaultModel,
    ...(raw.multiplier !== undefined && raw.multiplier !== null && raw.multiplier !== ''
      ? { multiplier: Number(raw.multiplier) }
      : {}),
    groups: parseGroupInputs(raw.groups),
    ...(raw.price && typeof raw.price === 'object'
      ? { price: raw.price as NonNullable<ProfileInput['price']> }
      : {}),
    ...(raw.modelCapabilities && typeof raw.modelCapabilities === 'object'
      ? { modelCapabilities: raw.modelCapabilities as NonNullable<ProfileInput['modelCapabilities']> }
      : {}),
  };
}

/** 分组入参：未传 groups 表示不修改；传入即整体替换。 */
function parseGroupInputs(value: unknown): ProfileGroupInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => {
      const models = Array.isArray(item.models)
        ? [...new Set(item.models.map((m) => str(m)).filter(Boolean))]
        : [];
      const kind = str(item.kind) as ProviderKind;
      const keyStrategy = str(item.keyStrategy) as ProfileGroupInput['keyStrategy'];
      const apiKeys = Array.isArray(item.apiKeys)
        ? item.apiKeys
            .filter((key): key is Record<string, unknown> => !!key && typeof key === 'object')
            .map((key) => ({
              ...(str(key.id) ? { id: str(key.id) } : {}),
              ...(str(key.label) ? { label: str(key.label) } : {}),
              ...(typeof key.apiKey === 'string' && key.apiKey ? { apiKey: key.apiKey } : {}),
              ...(typeof key.disabled === 'boolean' ? { disabled: key.disabled } : {}),
            }))
            .filter((key) => key.id || key.apiKey)
        : undefined;
      return {
        ...(str(item.id) ? { id: str(item.id) } : {}),
        name: str(item.name),
        ...(PROVIDER_KINDS.includes(kind) ? { kind } : {}),
        ...(typeof item.apiKey === 'string' && item.apiKey ? { apiKey: item.apiKey } : {}),
        ...(apiKeys !== undefined ? { apiKeys } : {}),
        ...(keyStrategy === 'failover' || keyStrategy === 'round_robin' ? { keyStrategy } : {}),
        ...(str(item.baseUrl) ? { baseUrl: str(item.baseUrl) } : {}),
        models,
        defaultModel: str(item.defaultModel) || models[0] || '',
        ...(item.multiplier !== undefined && item.multiplier !== null && item.multiplier !== ''
          ? { multiplier: Number(item.multiplier) }
          : {}),
        ...(item.modelCapabilities && typeof item.modelCapabilities === 'object'
          ? {
              modelCapabilities:
                item.modelCapabilities as NonNullable<ProfileGroupInput['modelCapabilities']>,
            }
          : {}),
      };
    })
    .filter((group) => !!group.name);
}

/** 工作站模式下模型账号是账号级：旧的按主机 API 已删除，客户端直接访问 /api/workstation/profiles。 */
function accountModeReply(host: RouteDeps['host'], reply: import('fastify').FastifyReply): boolean {
  if (!host.mirrorProfiles) return false;
  void reply.code(410).send({ error: '模型账号已改为工作站账号级，请使用 /api/workstation/profiles' });
  return true;
}

export function registerProfileRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/profiles', async (req, reply) => {
    if (accountModeReply(host, reply)) return;
    const list = host.profiles
      .list()
      .filter((profile) => profile.kind !== 'demo')
      .map((p) => host.profiles.toPublic(p));
    return isOwner(req) ? list : sanitizeProfilesForViewer(list);
  });

  app.post('/api/profiles', async (req, reply) => {
    if (accountModeReply(host, reply)) return;
    try {
      const input = parseProfileInput(req.body);
      return host.profiles.toPublic(host.profiles.create(input));
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.put('/api/profiles/:id', async (req, reply) => {
    if (accountModeReply(host, reply)) return;
    const { id } = req.params as { id: string };
    if (!host.profiles.get(id)) return bad(reply, '账号不存在', 404);
    try {
      const input = parseProfileInput(req.body);
      const updated = host.profiles.update(id, input);
      return updated ? host.profiles.toPublic(updated) : bad(reply, '账号不存在', 404);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.delete('/api/profiles/:id', async (req, reply) => {
    if (accountModeReply(host, reply)) return;
    const { id } = req.params as { id: string };
    if (!host.profiles.delete(id)) return bad(reply, '账号不存在', 404);
    return reply.code(204).send();
  });

  app.post('/api/profiles/:id/test', async (req, reply) => {
    if (accountModeReply(host, reply)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { groupId?: unknown; keyId?: unknown };
    const groupId = str(body.groupId) || undefined;
    const keyId = str(body.keyId) || undefined;
    const base = host.profiles.get(id);
    if (!base) return bad(reply, '账号不存在', 404);
    const group = groupId ? base.groups?.find((g) => g.id === groupId) : undefined;
    if (groupId && !group) return bad(reply, '分组不存在');
    // 测试分组时用分组当前可用 Key；指定 keyId 时只测该 Key
    let profile = host.keyCandidates(id, groupId).candidates[0]?.profile ?? host.profileFor(id, groupId);
    if (!profile) return bad(reply, '账号不存在', 404);
    if (keyId) {
      const key = group?.keys?.find((item) => item.id === keyId);
      if (!key) return bad(reply, 'Key 不存在', 404);
      profile = { ...profile, apiKey: key.apiKey };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      return await testProfile(profile, controller.signal);
    } catch (err) {
      return { ok: false, error: truncateEnd((err as Error).message, 500) };
    } finally {
      clearTimeout(timer);
    }
  });
}
