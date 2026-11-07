// Fastify 服务：启动、鉴权、静态托管；REST / WebSocket 路由在 ./routes 下按资源注册。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { RelayPairInfo } from '@tandem/protocol';
import type { Host } from './host.js';
import { startPrPolling } from './vcs.js';
import { registerSttRoutes } from './stt.js';
import { isPublicSharePath, registerShareRoutes } from './share/routes.js';
import { isPublicTeamPath, registerTeamRoutes } from './routes/team.js';
import { guardMemberRequest, ownerPrincipal, type Principal } from './team/access.js';
import type { RouteDeps } from './routes/common.js';
import { registerHostRoutes } from './routes/host.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerModelRoutes } from './routes/models.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerPermissionRoutes } from './routes/permissions.js';
import { registerHookRoutes } from './routes/hooks.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerSubagentPresetRoutes } from './routes/subagent-presets.js';
import { registerPromptTemplateRoutes } from './routes/prompt-templates.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerBudgetRoutes } from './routes/budgets.js';
import { registerPairRoutes } from './routes/pair.js';
import { registerExternalRoutes } from './routes/external.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerEvalRoutes } from './routes/evals.js';
import { registerCommandRoutes } from './routes/commands.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerBrowserRoutes } from './routes/browser.js';
import { registerWsRoutes } from './routes/ws.js';

export async function createApp(
  host: Host,
  extras: { relay?: { pairInfo(): RelayPairInfo | undefined } } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 30 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });
  await app.register(websocket, {
    options: { maxPayload: 32 * 1024 * 1024 }, // 允许客户端发送图片附件
  });

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  const hasWeb = existsSync(path.join(webDist, 'index.html'));

  // 鉴权：/api 与 /ws 必须带 token（Bearer 或 ?token=），静态文件放行
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const urlPath = (req.raw.url ?? '').split('?')[0] ?? '';
    // 只读分享的公开接口自带 Share token，不能要求 Host 主 token。
    if (isPublicSharePath(urlPath)) return;
    // 接受邀请用一次性邀请码鉴权。
    if (isPublicTeamPath(urlPath)) return;
    if (!urlPath.startsWith('/api') && urlPath !== '/ws') return;

    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : undefined;
    const query = req.query as Record<string, unknown> | undefined;
    const token = bearer || (typeof query?.token === 'string' ? query.token : undefined);
    if (!token) return reply.code(401).send({ error: '未授权：缺少 token' });
    let principal: Principal;
    if (token === host.config.token) {
      principal = ownerPrincipal();
    } else {
      const member = host.team.authenticate(token);
      if (!member) return reply.code(401).send({ error: '未授权：token 无效或已被吊销' });
      principal = {
        kind: 'member',
        id: member.id,
        name: member.name,
        role: member.role,
        projectDirs: member.projectDirs,
      };
    }
    req.team = principal;
    const denied = guardMemberRequest(host, principal, req.method, urlPath);
    if (denied) return reply.code(denied.code).send({ error: denied.message });
  });

  app.setErrorHandler((rawErr: unknown, _req, reply) => {
    const err = rawErr as { statusCode?: number; message?: string };
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) console.error('[tandem] 请求处理失败:', rawErr);
    reply.code(status).send({ error: err.message ?? '服务器内部错误' });
  });

  // ---------- 会话只读分享（内网） ----------
  registerShareRoutes(app, host);

  const deps: RouteDeps = { host, ...(extras.relay ? { relay: extras.relay } : {}) };

  registerHostRoutes(app, deps);
  registerTeamRoutes(app, deps);

  // 本机语音转写（用户自己的 Whisper；不联网）
  registerSttRoutes(app, host);

  registerProfileRoutes(app, deps);
  registerModelRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerPermissionRoutes(app, deps);
  registerHookRoutes(app, deps);
  registerMcpRoutes(app, deps);
  registerSubagentPresetRoutes(app, deps);
  registerPromptTemplateRoutes(app, deps);
  registerUsageRoutes(app, deps);
  registerBudgetRoutes(app, deps);
  registerPairRoutes(app, deps);
  registerExternalRoutes(app, deps);
  registerConfigRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerFsRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerScheduleRoutes(app, deps);
  registerEvalRoutes(app, deps);
  registerCommandRoutes(app, deps);
  registerSkillRoutes(app, deps);
  registerBrowserRoutes(app, deps);
  registerWsRoutes(app, deps);

  // PR/CI 轮询：只覆盖已被客户端打开且有 PR 的会话
  const stopPrPolling = startPrPolling(host);
  app.addHook('onClose', async () => {
    stopPrPolling();
    host.team.close();
  });

  // ---------- 静态 Web UI ----------
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
    });
  }

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const urlPath = (req.raw.url ?? '').split('?')[0] ?? '';
    const accept = req.headers.accept ?? '';
    if (
      hasWeb &&
      req.method === 'GET' &&
      !urlPath.startsWith('/api') &&
      urlPath !== '/ws' &&
      (accept.includes('text/html') || accept === '*/*' || accept === '')
    ) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not Found' });
  });

  return app;
}
