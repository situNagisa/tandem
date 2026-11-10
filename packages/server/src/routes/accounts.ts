// 工作站：主机加入/退出、本机内嵌启动，以及主机侧的快照同步接口。
import os from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteDeps } from './common.js';
import { bad, str } from './common.js';
import { principalOf } from '../team/access.js';
import { embeddedDataDir, embeddedStatus, startEmbeddedWorkstation } from '../workstation/manager.js';
import { readWorkstationMeta } from '../workstation/server.js';
import { joinWorkstation } from '../workstation/join.js';

export function isPublicAccountPath(pathname: string): boolean {
  return (
    pathname === '/api/accounts/status' ||
    pathname === '/api/accounts/workspace/sync' ||
    pathname === '/api/accounts/workspace/snapshot'
  );
}

/** 本机所有可达地址；加入方上报给中心，登录后客户端据此自动添加主机。 */
function selfName(app: FastifyInstance): string {
  const address = app.server.address();
  const port = address && typeof address === 'object' && address.port ? address.port : 7878;
  return port === 8270 ? os.hostname() : `${os.hostname()}:${port}`;
}

function localUrls(app: FastifyInstance): string[] {
  const address = app.server.address();
  const port = address && typeof address === 'object' && address.port ? address.port : 7878;
  const bound = address && typeof address === 'object' ? address.address : '127.0.0.1';
  const lan = bound === '0.0.0.0' || bound === '::' || bound === '::0';
  const urls = new Set<string>([`http://127.0.0.1:${port}`]);
  if (!lan && bound && bound !== '127.0.0.1' && bound !== '::1') urls.add(`http://${bound}:${port}`);
  if (lan) {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        const family = String(entry.family);
        if ((family === 'IPv4' || family === '4') && !entry.internal) urls.add(`http://${entry.address}:${port}`);
      }
    }
  }
  return [...urls];
}

export function registerAccountRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;
  const accounts = () => host.accounts;
  const isHostOwner = (req: FastifyRequest) => principalOf(req).kind === 'owner';

  app.get('/api/accounts/status', async (req) => {
    if (accounts().mode() === 'center') accounts().ensureSelfHost(localUrls(app));
    return accounts().status();
  });

  // ---------- 本机作为主机：工作站加入 / 本机内嵌启动工作站 ----------
  app.get('/api/workstation/local/status', async (req, reply) => {
    if (!isHostOwner(req)) return bad(reply, '仅 Host 所有者可以查看工作站状态', 403);
    const join = accounts().workstationJoin();
    const embedded = embeddedStatus(host.home);
    return {
      mode: accounts().mode(),
      role: accounts().status().role,
      embedded: { running: embedded.running, urls: embedded.urls, ...(embedded.port ? { port: embedded.port } : {}) },
      join: join
        ? {
            url: join.url,
            workspaceName: join.workspace.name,
            fingerprint: join.fingerprint,
            connected: deps.workstation?.status().connected ?? false,
          }
        : null,
    };
  });

  app.post('/api/workstation/local/enable', async (req, reply) => {
    if (!isHostOwner(req)) return bad(reply, '仅 Host 所有者可以启动本机工作站', 403);
    const address = app.server.address();
    const bound = address && typeof address === 'object' ? address.address : '127.0.0.1';
    const bindHost = bound === '0.0.0.0' || bound === '::' || bound === '::0' ? '0.0.0.0' : '127.0.0.1';
    try {
      const info = await startEmbeddedWorkstation(host.home, bindHost, host.version);
      const meta = readWorkstationMeta(embeddedDataDir(host.home));
      return { ...info, initialized: meta.initialized };
    } catch (err) {
      return bad(reply, `无法启动本机工作站：${(err as Error).message}`, 500);
    }
  });

  app.post('/api/workstation/join', async (req, reply) => {
    if (!isHostOwner(req)) return bad(reply, '仅 Host 所有者可以把本机加入工作站', 403);
    const body = (req.body ?? {}) as {
      workstationUrl?: unknown;
      code?: unknown;
      username?: unknown;
      password?: unknown;
      totp?: unknown;
      name?: unknown;
    };
    return joinWorkstation(host, deps.workstation, {
      workstationUrl: str(body.workstationUrl),
      code: str(body.code),
      username: str(body.username),
      password: typeof body.password === 'string' ? body.password : '',
      totp: typeof body.totp === 'string' ? body.totp : '',
      name: str(body.name) || selfName(app),
      urls: localUrls(app),
    });
  });

  app.post('/api/workstation/leave', async (req, reply) => {
    if (!isHostOwner(req)) return bad(reply, '仅 Host 所有者可以让本机退出工作站', 403);
    deps.workstation?.stop();
    accounts().leaveWorkspace();
    return reply.code(204).send();
  });

  // 中心主动推送或加入方之间中转的签名快照（公开但必须中心私钥签名）。
  app.post('/api/accounts/workspace/sync', async (req, reply) => {
    const token = req.headers['x-tandem-workspace-token'];
    const expected = accounts().syncSecret();
    if (expected && (typeof token !== 'string' || token !== expected)) {
      return bad(reply, '工作区快照口令无效', 401);
    }
    const ok = accounts().applySignedSnapshot(req.body);
    if (!ok) return bad(reply, '快照签名无效或本机不是加入方 Host', 400);
    return reply.code(204).send();
  });

  app.get('/api/accounts/workspace/snapshot', async (req, reply) => {
    if (accounts().mode() !== 'center') return bad(reply, '该 Host 不是账号中心', 404);
    const token = req.headers['x-tandem-workspace-token'];
    const expected = accounts().syncSecret();
    if (expected && (typeof token !== 'string' || token !== expected)) {
      return bad(reply, '需要加入方 Host 的工作区口令', 401);
    }
    accounts().ensureSelfHost(localUrls(app));
    return accounts().signedSnapshot();
  });
}
