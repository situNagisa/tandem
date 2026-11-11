// 自建 Key 网关：管理接口（仅所有者）+ 对内网公开的 /gateway/v1/* 兼容接口（网关令牌鉴权）。
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  GatewayModelRoute,
  GatewaySettings,
  GatewayTokenInput,
  GatewayTokenUpdateInput,
  GatewayOverview,
} from '@tandem/protocol';
import type { RouteDeps } from './common.js';
import { bad, str } from './common.js';
import { gatewayMemberUsage } from '../gateway/stats.js';
import { handleGatewayChat, handleGatewayModels } from '../gateway/proxy.js';

function parseRoutes(host: RouteDeps['host'], value: unknown): GatewayModelRoute[] {
  if (!Array.isArray(value)) throw new Error('routes 必须是数组');
  const routes: GatewayModelRoute[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<GatewayModelRoute>;
    const profileId = str(item.profileId);
    const groupId = str(item.groupId);
    const models = Array.isArray(item.models)
      ? [...new Set(item.models.filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim()))]
      : [];
    if (!profileId) throw new Error('路由缺少账号');
    const profile = host.profiles.get(profileId);
    if (!profile) throw new Error(`路由账号不存在: ${profileId}`);
    if (profile.kind === 'tandem-gateway') throw new Error('网关不能把路由指回另一个 Tandem 网关账号');
    if (groupId && !profile.groups?.some((group) => group.id === groupId)) {
      throw new Error(`路由分组不存在: ${groupId}`);
    }
    if (!models.length) throw new Error(`账号「${profile.name}」的路由至少需要一个模型`);
    routes.push({
      id: str(item.id) || randomUUID(),
      profileId,
      ...(groupId ? { groupId } : {}),
      models,
    });
  }
  return routes;
}

function limitOf(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) throw new Error('限额必须是非负数字（美元）');
  return num > 0 ? Math.round(num * 1e6) / 1e6 : undefined;
}

export function registerGatewayRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/gateway', async (): Promise<GatewayOverview> => {
    const tokens = host.gateway.listTokens();
    return {
      settings: host.gateway.settingsView(),
      tokens,
      usage: gatewayMemberUsage(host.usage, tokens),
      logs: host.gateway.logsView(50),
      debugCount: host.gateway.debugCount(),
    };
  });

  app.put('/api/gateway/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<GatewaySettings>;
    try {
      const routes = body.routes !== undefined ? parseRoutes(host, body.routes) : host.gateway.settingsView().routes;
      const settings = host.gateway.updateSettings({
        enabled: body.enabled === true,
        debugBodies: body.debugBodies === true,
        routes,
      });
      return settings;
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/gateway/tokens', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<GatewayTokenInput>;
    const name = str(body.name).trim().slice(0, 40);
    if (!name) return bad(reply, '请填写令牌名称');
    try {
      const issued = host.gateway.issueToken({
        memberId: randomUUID(),
        memberName: name,
        ...(body.dailyLimitUsd !== undefined ? { dailyLimitUsd: limitOf(body.dailyLimitUsd) } : {}),
        ...(body.monthlyLimitUsd !== undefined ? { monthlyLimitUsd: limitOf(body.monthlyLimitUsd) } : {}),
        ...(body.rpm !== undefined ? { rpm: Number(body.rpm) } : {}),
        ...(body.allowedModels !== undefined ? { allowedModels: Array.isArray(body.allowedModels) ? body.allowedModels : [] } : {}),
      });
      return reply.code(201).send(issued);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/gateway/tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as GatewayTokenUpdateInput;
    try {
      const patch: GatewayTokenUpdateInput = {};
      if (body.dailyLimitUsd !== undefined) patch.dailyLimitUsd = limitOf(body.dailyLimitUsd) ?? null;
      if (body.monthlyLimitUsd !== undefined) patch.monthlyLimitUsd = limitOf(body.monthlyLimitUsd) ?? null;
      if (body.rpm !== undefined) {
        const rpm = Number(body.rpm);
        if (!Number.isFinite(rpm) || rpm <= 0) return bad(reply, 'RPM 必须大于 0');
        patch.rpm = rpm;
      }
      if (body.allowedModels !== undefined) {
        if (!Array.isArray(body.allowedModels)) return bad(reply, 'allowedModels 必须是数组');
        patch.allowedModels = body.allowedModels.filter((m): m is string => typeof m === 'string');
      }
      const token = host.gateway.updateToken(id, patch);
      if (!token) return bad(reply, '网关令牌不存在', 404);
      return token;
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.delete('/api/gateway/tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!host.gateway.revokeToken(id)) return bad(reply, '网关令牌不存在或已吊销', 404);
    return reply.code(204).send();
  });

  app.get('/api/gateway/logs', async (req) => {
    const query = req.query as { limit?: string };
    const limit = Number.parseInt(str(query.limit), 10);
    return host.gateway.logsView(Number.isFinite(limit) && limit > 0 ? limit : 100);
  });

  // ---------- 对内网公开：网关令牌鉴权（不要求 Host 主 token / 成员 token） ----------
  app.get('/gateway/v1/models', async (req, reply) => handleGatewayModels(host, req, reply));
  app.post('/gateway/v1/chat/completions', async (req, reply) => {
    await handleGatewayChat(host, req, reply, 'openai');
  });
  app.post('/gateway/v1/messages', async (req, reply) => {
    await handleGatewayChat(host, req, reply, 'anthropic');
  });
}
