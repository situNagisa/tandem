// 账号制工作区：中心创建/登录/刷新、加入码、Host 快照同步、账号与授权管理。
import os from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  AccountLoginInput,
  AccountTokens,
  WorkspaceAccountInput,
  WorkspaceAccountUpdateInput,
  WorkspaceJoinInput,
} from '@tandem/protocol';
import type { RouteDeps } from './common.js';
import { bad, str } from './common.js';
import { principalOf } from '../team/access.js';
import { embeddedDataDir, embeddedStatus, startEmbeddedWorkstation } from '../workstation/manager.js';
import { readWorkstationMeta } from '../workstation/server.js';

export function isPublicAccountPath(pathname: string): boolean {
  return (
    pathname === '/api/accounts/status' ||
    pathname === '/api/accounts/login' ||
    pathname === '/api/accounts/refresh' ||
    pathname === '/api/accounts/logout' ||
    pathname === '/api/accounts/workspace/join' ||
    pathname === '/api/accounts/workspace/sync' ||
    pathname === '/api/accounts/workspace/snapshot'
  );
}

function tokenOf(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  const query = req.query as Record<string, unknown> | undefined;
  return typeof query?.token === 'string' ? query.token : '';
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
  /** 中心管理：Host 所有者 token，或工作区所有者/管理员账号。 */
  const manager = (req: FastifyRequest, ownerOnly = false): boolean => {
    const principal = principalOf(req);
    if (principal.kind === 'owner') return true;
    if (principal.kind !== 'account') return false;
    return ownerOnly ? principal.accountRole === 'owner' : principal.accountRole === 'owner' || principal.accountRole === 'admin';
  };

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

  app.post('/api/accounts/setup', async (req, reply) => {
    if (!isHostOwner(req)) return bad(reply, '仅 Host 所有者可以创建工作区', 403);
    const body = (req.body ?? {}) as { name?: unknown; username?: unknown; password?: unknown };
    const result = accounts().setup(str(body.name), str(body.username), typeof body.password === 'string' ? body.password : '', localUrls(app), selfName(app));
    return result;
  });

  app.post('/api/accounts/login', async (req) => {
    if (accounts().mode() !== 'center') throw Object.assign(new Error('该 Host 不是账号中心'), { statusCode: 404 });
    accounts().ensureSelfHost(localUrls(app));
    const body = (req.body ?? {}) as AccountLoginInput;
    return accounts().login(body);
  });

  app.post('/api/accounts/refresh', async (req, reply) => {
    if (accounts().mode() !== 'center') return bad(reply, '该 Host 不是账号中心', 404);
    const body = (req.body ?? {}) as { refreshToken?: unknown };
    return accounts().refresh(str(body.refreshToken));
  });

  app.post('/api/accounts/logout', async (req, reply) => {
    const body = (req.body ?? {}) as { refreshToken?: unknown };
    accounts().logout(str(body.refreshToken));
    return reply.code(204).send();
  });

  app.get('/api/accounts/me', async (req, reply) => {
    const me = accounts().me(tokenOf(req));
    if (!me) return bad(reply, '不是工作区账号令牌', 403);
    return me;
  });

  app.get('/api/accounts/hosts', async (req, reply) => {
    const token = tokenOf(req);
    const principal = principalOf(req);
    if (principal.kind === 'owner') {
      const overview = accounts().overview();
      return overview.hosts;
    }
    if (principal.kind !== 'account') return bad(reply, '需要工作区账号令牌', 403);
    return accounts().hostsFor(token);
  });

  app.get('/api/accounts/workspace', async (req, reply) => {
    if (accounts().mode() === 'center') {
      if (!manager(req)) return bad(reply, '仅工作区所有者/管理员可以查看工作区', 403);
      accounts().ensureSelfHost(localUrls(app));
      return accounts().overview();
    }
    const member = accounts().memberOverview();
    if (!member) return bad(reply, '本机没有加入工作区', 404);
    // 成员主机按账号范围过滤主机列表，避免协作者看到未授权机器。
    const principal = principalOf(req);
    if (principal.kind === 'account') {
      return { ...member, hosts: accounts().hostsFor(tokenOf(req)) };
    }
    return member;
  });

  app.post('/api/accounts/workspace/join-code', async (req, reply) => {
    if (!manager(req, true)) return bad(reply, '仅工作区所有者可以生成加入码', 403);
    const principal = principalOf(req);
    return accounts().createJoinCode(principal.kind === 'account' ? principal.username : 'owner');
  });

  app.post('/api/accounts/workspace/join', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<WorkspaceJoinInput> & { centerUrl?: unknown };
    if (accounts().mode() === 'center') {
      if (!body.host || !body.code) return bad(reply, '缺少加入码或 Host 信息');
      return accounts().acceptJoin({ code: body.code, host: body.host });
    }
    // 加入方：本机所有者填写中心地址 + 加入码，由本机去中心换取信任。
    if (!isHostOwner(req)) return bad(reply, '仅 Host 所有者可以让本机加入工作区', 403);
    const centerUrl = str(body.centerUrl);
    const code = str(body.code);
    if (!centerUrl || !code) return bad(reply, '缺少账号中心地址或加入码');
    return accounts().joinWorkspace(centerUrl, code, {
      id: host.config.hostId,
      name: selfName(app),
      urls: localUrls(app),
      ...(host.version ? { version: host.version } : {}),
      platform: process.platform,
    });
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

  app.post('/api/accounts/workspace/leave', async (req, reply) => {
    if (!isHostOwner(req)) return bad(reply, '仅 Host 所有者可以让本机退出工作区', 403);
    accounts().leaveWorkspace();
    return reply.code(204).send();
  });

  app.delete('/api/accounts/workspace/hosts/:id', async (req, reply) => {
    if (!manager(req, true)) return bad(reply, '仅工作区所有者可以移除 Host', 403);
    const id = decodeURIComponent((req.params as { id: string }).id);
    const principal = principalOf(req);
    accounts().removeHost(id, principal.kind === 'account' ? principal.username : 'owner');
    return reply.code(204).send();
  });

  app.get('/api/accounts/accounts', async (req, reply) => {
    if (!manager(req)) return bad(reply, '仅工作区所有者/管理员可以查看账号', 403);
    return accounts().listAccounts();
  });

  app.post('/api/accounts/accounts', async (req, reply) => {
    if (!manager(req, true)) return bad(reply, '仅工作区所有者可以创建账号', 403);
    const principal = principalOf(req);
    return accounts().createAccount((req.body ?? {}) as WorkspaceAccountInput, principal.kind === 'account' ? principal.username : 'owner');
  });

  app.patch('/api/accounts/accounts/:id', async (req, reply) => {
    if (!manager(req, true)) return bad(reply, '仅工作区所有者可以修改账号', 403);
    const id = decodeURIComponent((req.params as { id: string }).id);
    const principal = principalOf(req);
    return accounts().updateAccount(id, (req.body ?? {}) as WorkspaceAccountUpdateInput, principal.kind === 'account' ? principal.username : 'owner');
  });

  app.post('/api/accounts/accounts/:id/revoke', async (req, reply) => {
    if (!manager(req, true)) return bad(reply, '仅工作区所有者可以吊销账号', 403);
    const id = decodeURIComponent((req.params as { id: string }).id);
    const principal = principalOf(req);
    if (principal.kind === 'account' && principal.id === id) return bad(reply, '不能吊销当前登录的账号', 400);
    accounts().revokeAccount(id, principal.kind === 'account' ? principal.username : 'owner');
    return reply.code(204).send();
  });

  app.get('/api/accounts/audit', async (req, reply) => {
    if (!manager(req)) return bad(reply, '仅工作区所有者/管理员可以查看审计', 403);
    const url = new URL(req.raw.url ?? '/api/accounts/audit', 'http://local');
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500));
    const state = (accounts() as unknown as { state?: { mode: string; audit?: unknown[] } }).state;
    if (!state || state.mode !== 'center') return [];
    return (state.audit ?? []).slice(-limit);
  });
}
