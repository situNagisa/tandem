// 工作站：主机加入/退出、本机内嵌启动，以及主机侧的快照同步接口。
import os from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteDeps } from './common.js';
import { bad, str } from './common.js';
import { principalOf } from '../team/access.js';
import { embeddedDataDir, embeddedStatus, startEmbeddedWorkstation } from '../workstation/manager.js';
import { readWorkstationMeta } from '../workstation/server.js';

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
    const workstationUrl = str(body.workstationUrl);
    if (!workstationUrl) return bad(reply, '请填写工作站地址');
    const target = workstationUrl.trim().replace(/\/+$/, '');
    // 已加入同一工作站：幂等返回当前状态（重复执行同一条安装命令不报错）；已加入别的工作站才拒绝。
    const existing = accounts().workstationJoin();
    if (existing) {
      if (existing.url.replace(/\/+$/, '').toLowerCase() === target.toLowerCase()) {
        deps.workstation?.start();
        return accounts().status();
      }
      return bad(reply, `本机已加入工作站 ${existing.url}，请先退出后再加入其他工作站`, 409);
    }
    const code = str(body.code);
    let accessToken: string | undefined;
    const username = str(body.username);
    if (!code) {
      if (!username || typeof body.password !== 'string' || !body.password) {
        return bad(reply, '请填写绑定码，或用工作站账号登录');
      }
      let res: Response;
      try {
        res = await fetch(`${target}/api/workstation/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            password: body.password,
            ...(typeof body.totp === 'string' && body.totp ? { totp: body.totp } : {}),
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        return bad(reply, `无法连接工作站：${(err as Error).message}`, 502);
      }
      const data = (await res.json().catch(() => ({}))) as { accessToken?: string; error?: string };
      if (!res.ok || !data.accessToken) return bad(reply, data.error ?? `工作站返回 ${res.status}`, 502);
      accessToken = data.accessToken;
    }
    const status = await accounts().registerAsHost(
      target,
      {
        id: host.config.hostId,
        name: str(body.name) || selfName(app),
        urls: localUrls(app),
        ...(host.version ? { version: host.version } : {}),
        platform: process.platform,
      },
      code ? { code } : { accessToken: accessToken! },
    );
    deps.workstation?.start();
    // 加入后立刻切到账号级模型账号，并把本机旧 profiles（含 Key）迁移到工作站。
    void host.enableWorkstationProfiles();
    return status;
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
