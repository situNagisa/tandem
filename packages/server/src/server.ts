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
import { RelayAgent } from './relay/agent.js';
import { startPrPolling } from './vcs.js';
import { registerSttRoutes } from './stt.js';
import { isPublicSharePath, registerShareRoutes } from './share/routes.js';
import { isPublicTeamPath, registerTeamRoutes } from './routes/team.js';
import { isPublicAccountPath, registerAccountRoutes } from './routes/accounts.js';
import { guardMemberRequest, ownerPrincipal, type Principal } from './team/access.js';
import type { RouteDeps } from './routes/common.js';
import { registerHostRoutes } from './routes/host.js';
import { registerDoctorRoutes } from './routes/doctor.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerModelRoutes } from './routes/models.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerPermissionRoutes } from './routes/permissions.js';
import { registerHookRoutes } from './routes/hooks.js';
import { registerSecretRoutes } from './routes/secrets.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerSubagentPresetRoutes } from './routes/subagent-presets.js';
import { registerPromptTemplateRoutes } from './routes/prompt-templates.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerGatewayRoutes } from './routes/gateway.js';
import { registerBudgetRoutes } from './routes/budgets.js';
import { registerPairRoutes } from './routes/pair.js';
import { registerExternalRoutes } from './routes/external.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerWikiRoutes } from './routes/wiki.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerBoardRoutes } from './routes/board.js';
import { registerEvalRoutes } from './routes/evals.js';
import { registerCommandRoutes } from './routes/commands.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerBrowserRoutes } from './routes/browser.js';
import { registerPreviewRoutes } from './routes/preview.js';
import { registerWsRoutes } from './routes/ws.js';
import { registerSshHostRoutes } from './routes/ssh-hosts.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { SshRemoteManager } from './ssh/manager.js';
import { IS_DEBUG_FLAVOR } from './flavor.js';

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
    // 登录 / 加入码 / 中心签名快照走各自凭证，不能要求 Host token。
    if (isPublicAccountPath(urlPath)) return;
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
      const account = member ? undefined : host.accounts.authenticate(token);
      const devicePeer = member || account ? undefined : host.devices.authenticatePeer(token);
      if (!member && !account && !devicePeer) return reply.code(401).send({ error: '未授权：token 无效或已被吊销' });
      principal = account
        ? {
            kind: 'account',
            id: account.accountId,
            name: account.name,
            username: account.username,
            accountRole: account.accountRole,
            role: account.role,
            projectDirs: account.projectDirs,
            allProjects: account.allProjects,
          }
        : member
        ? {
            kind: 'member',
            id: member.id,
            name: member.name,
            role: member.role,
            projectDirs: member.projectDirs,
          }
        : {
            kind: 'device',
            role: 'observer',
            id: `device:${devicePeer!.id}`,
            name: devicePeer!.label,
            projectDirs: [],
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

  const sshHosts = new SshRemoteManager(host.home, host.version);
  app.addHook('onClose', async () => sshHosts.stop());
  // 本机作为主机加入工作站后：主动向工作站建立出站隧道（E2E 强制）。
  let workstationAgent: RelayAgent | undefined;
  const startWorkstationTunnel = () => {
    if (workstationAgent) return;
    const join = host.accounts.workstationJoin();
    if (!join) return;
    const address = app.server.address();
    const port = address && typeof address === 'object' && address.port ? address.port : 7878;
    workstationAgent = new RelayAgent(
      { url: join.url, hostKey: join.hostKey, requireE2E: true },
      host.config.hostId,
      port,
    );
    workstationAgent.start();
  };
  const stopWorkstationTunnel = () => {
    workstationAgent?.stop();
    workstationAgent = undefined;
  };
  const workstationDeps = {
    start: startWorkstationTunnel,
    stop: stopWorkstationTunnel,
    status: () => {
      const join = host.accounts.workstationJoin();
      return { connected: !!workstationAgent, ...(join ? { url: join.url } : {}) };
    },
  };
  app.addHook('onListen', async () => startWorkstationTunnel());
  app.addHook('onClose', async () => stopWorkstationTunnel());
  const deps: RouteDeps = { host, sshHosts, workstation: workstationDeps, ...(extras.relay ? { relay: extras.relay } : {}) };

  if (IS_DEBUG_FLAVOR) {
    // 调试版桌面：首次启动自动登录本机工作站的测试账号；发布构建不加载此模块。
    const { installDebugWorkstationBootstrap } = await import('./debug/workstationBootstrap.js');
    installDebugWorkstationBootstrap(app, host, workstationDeps);
  }

  registerHostRoutes(app, deps);
  registerUpdateRoutes(app, deps);
  if (IS_DEBUG_FLAVOR) {
    const { registerDebugDemoRoutes } = await import('./debug/demoRoutes.js');
    await registerDebugDemoRoutes(app, deps);
  }
  registerDoctorRoutes(app, deps);
  registerTeamRoutes(app, deps);
  registerAccountRoutes(app, deps);

  // 本机语音转写（用户自己的 Whisper；不联网）
  registerSttRoutes(app, host);

  registerProfileRoutes(app, deps);
  registerModelRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerPermissionRoutes(app, deps);
  registerHookRoutes(app, deps);
  registerSecretRoutes(app, deps);
  registerMcpRoutes(app, deps);
  registerSubagentPresetRoutes(app, deps);
  registerPromptTemplateRoutes(app, deps);
  registerUsageRoutes(app, deps);
  registerGatewayRoutes(app, deps);
  registerBudgetRoutes(app, deps);
  registerPairRoutes(app, deps);
  registerExternalRoutes(app, deps);
  registerConfigRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerWikiRoutes(app, deps);
  registerFsRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerScheduleRoutes(app, deps);
  registerBoardRoutes(app, deps);
  registerEvalRoutes(app, deps);
  registerCommandRoutes(app, deps);
  registerSkillRoutes(app, deps);
  registerBrowserRoutes(app, deps);
  registerPreviewRoutes(app, deps);
  registerWsRoutes(app, deps);
  registerSshHostRoutes(app, deps);
  registerDeviceRoutes(app, deps);

  // PR/CI 轮询：只覆盖已被客户端打开且有 PR 的会话
  const stopPrPolling = startPrPolling(host);
  app.addHook('onClose', async () => {
    stopPrPolling();
    host.team.close();
    host.accounts.close();
    host.gateway.flush();
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
