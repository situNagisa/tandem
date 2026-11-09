// 工作站服务：账号注册/登录、主机登记、授权，以及主机出站隧道的转发。
// 只转发端到端加密流量（/_e2e）；会话内容对工作站不可见。只在内网使用。
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import os from 'node:os';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { HostTunnel } from '@tandem/relay/tunnel';
import {
  TUNNEL_PATH,
  TUNNEL_VERSION,
  b64u,
  isValidHostId,
  parseJson,
  registrationMessage,
  unb64u,
  type TunnelChallenge,
  type TunnelHello,
} from '@tandem/relay/wire';
import type {
  WorkspaceHostInfo,
  WorkstationHostClaimInput,
  WorkstationHostClaimResult,
  WorkstationGrantInput,
  WorkstationRegisterInput,
  WorkstationSettingsInput,
  WorkspaceAccount,
} from '@tandem/protocol';
import { AccountsStore } from '../accounts/store.js';
import { readJson } from '../config.js';
import { IS_DEBUG_FLAVOR } from '../flavor.js';

const MAX_FRAME = 40 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const TUNNEL_PING_MS = 20_000;
const MAX_STREAMS = 256;
const BYTES_PER_SEC = 16 * 1024 * 1024;

export interface WorkstationOptions {
  /** accounts.json 所在目录（工作站独立数据目录）。 */
  home: string;
  hostId?: string;
  hostName?: string;
  version?: string;
}

export interface WorkstationHandle {
  app: FastifyInstance;
  store: AccountsStore;
  /** 启动监听并返回实际地址。 */
  listen: (port: number, host: string) => Promise<{ port: number; urls: string[] }>;
  close: () => Promise<void>;
}

interface WsAccount {
  account: WorkspaceAccount;
  token: string;
}

const PUBLIC_PATHS = new Set([
  '/api/workstation/status',
  '/api/workstation/setup',
  '/api/workstation/register',
  '/api/workstation/login',
  '/api/workstation/refresh',
  '/api/workstation/logout',
  '/api/workstation/hosts/claim',
  '/api/accounts/status',
  '/api/accounts/login',
  '/api/accounts/refresh',
  '/api/accounts/logout',
  '/api/accounts/workspace/snapshot',
]);

function tokenOf(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  const query = req.query as Record<string, unknown> | undefined;
  return typeof query?.token === 'string' ? query.token : '';
}

function accountOf(req: FastifyRequest): WsAccount {
  return (req as FastifyRequest & { wsAccount: WsAccount }).wsAccount;
}

function ed25519Public(raw: Uint8Array) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw) }, format: 'jwk' });
}

function shortId(hostId: string): string {
  return `${hostId.slice(0, 8)}…`;
}

export function createWorkstation(options: WorkstationOptions): WorkstationHandle {
  const hostId =
    options.hostId ?? `ws-${createHash('sha256').update(path.resolve(options.home)).digest('hex').slice(0, 24)}`;
  const store = new AccountsStore({
    home: options.home,
    hostId,
    hostName: options.hostName ?? os.hostname(),
    ...(options.version ? { version: options.version } : {}),
    platform: process.platform,
  });
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  // 调试版：自动创建本地测试账号并挂上仅回环可用的免密登录；发布构建不会加载这个模块。
  // 回归/联调用 TANDEM_DEBUG_ACCOUNT=0 模拟发布语义（只影响 debug 构建）。
  const debugAccountEnabled =
    IS_DEBUG_FLAVOR && process.env.TANDEM_DEBUG_ACCOUNT !== '0';
  const debugReady = debugAccountEnabled
    ? import('../debug/workstationService.js')
        .then((mod) => mod.ensureDebugWorkstation(store, options.home, app))
        .catch((err: unknown) => {
          console.warn('[workstation] 调试初始化失败:', (err as Error).message);
        })
    : Promise.resolve();
  const tunnels = new Map<string, HostTunnel>();
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const tunnelWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  void app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });

  // 隧道请求体必须原样流给主机；API 请求才解析 JSON。
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (req, payload, done) => {
    const url = (req.raw.url ?? '').split('?')[0] ?? '';
    if (url.startsWith('/h/') || url === TUNNEL_PATH) return done(null);
    const chunks: Buffer[] = [];
    payload.on('data', (chunk: Buffer) => chunks.push(chunk));
    payload.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!raw.length) return done(null);
      const type = String(req.headers['content-type'] ?? '');
      if (type.includes('application/json')) {
        try {
          done(null, JSON.parse(raw.toString('utf8')));
        } catch (err) {
          done(Object.assign(new Error('JSON 格式无效'), { statusCode: 400 }));
        }
      } else {
        done(null, raw);
      }
    });
    payload.on('error', (err) => done(err));
  });

  const publicPaths = () => PUBLIC_PATHS;

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const urlPath = (req.raw.url ?? '').split('?')[0] ?? '';
    if (!(urlPath.startsWith('/api/workstation') || urlPath.startsWith('/api/accounts'))) return;
    if (publicPaths().has(urlPath)) return;
    const token = tokenOf(req);
    if (!token) return reply.code(401).send({ error: '未授权：缺少账号令牌' });
    const found = store.accountFromToken(token);
    if (!found) return reply.code(401).send({ error: '账号令牌无效或已被吊销' });
    (req as FastifyRequest & { wsAccount: WsAccount }).wsAccount = { account: found.account, token };
  });

  app.setErrorHandler((rawErr: unknown, _req, reply) => {
    const err = rawErr as { statusCode?: number; message?: string };
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) console.error('[workstation] 请求处理失败:', rawErr);
    reply.code(status).send({ error: err.message ?? '服务器内部错误' });
  });

  const version = options.version;
  const addressInfo = () => {
    const address = app.server.address();
    const port = address && typeof address === 'object' && address.port ? address.port : 8481;
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
    return { port, urls: [...urls] };
  };

  app.get('/healthz', async () => ({ ok: true, hostsOnline: tunnels.size, initialized: store.mode() === 'center' }));

  // ---------- 公开接口 ----------
  app.get('/api/workstation/status', async () => {
    const { urls } = addressInfo();
    return { ...store.workstationStatus(urls), ...(debugAccountEnabled ? { debug: true } : {}) };
  });

  app.post('/api/workstation/setup', async (req, reply) => {
    if (store.mode() === 'center') return reply.code(409).send({ error: '工作站已初始化，请注册或登录' });
    const body = (req.body ?? {}) as { name?: unknown; username?: unknown; password?: unknown };
    const name = typeof body.name === 'string' ? body.name : '';
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    return store.initializeWorkstation(name, username, password);
  });

  app.post('/api/workstation/register', async (req, reply) => {
    if (store.mode() !== 'center') return reply.code(404).send({ error: '工作站尚未初始化' });
    const body = (req.body ?? {}) as WorkstationRegisterInput;
    return store.registerAccount(body);
  });

  app.post('/api/workstation/login', async (req, reply) => {
    if (store.mode() !== 'center') return reply.code(404).send({ error: '工作站尚未初始化' });
    return store.login((req.body ?? {}) as never);
  });

  app.post('/api/workstation/refresh', async (req, reply) => {
    if (store.mode() !== 'center') return reply.code(404).send({ error: '工作站尚未初始化' });
    const body = (req.body ?? {}) as { refreshToken?: unknown };
    return store.refresh(typeof body.refreshToken === 'string' ? body.refreshToken : '');
  });

  app.post('/api/workstation/logout', async (req, reply) => {
    const body = (req.body ?? {}) as { refreshToken?: unknown };
    store.logout(typeof body.refreshToken === 'string' ? body.refreshToken : '');
    return reply.code(204).send();
  });

  const claimResult = (req: FastifyRequest, host: WorkspaceHostInfo): WorkstationHostClaimResult => {
    const hostHeader = req.headers.host;
    const url = hostHeader ? `http://${hostHeader}` : addressInfo().urls[0]!;
    return {
      workspace: store.status().workspace!,
      workstation: { url, publicKey: store.workstationPublicKey()!, hostId },
      hostId: host.id,
      snapshotVersion: store.snapshotVersion(),
      syncToken: store.syncSecret() ?? '',
    };
  };

  app.post('/api/workstation/hosts/claim', async (req, reply) => {
    if (store.mode() !== 'center') return reply.code(404).send({ error: '工作站尚未初始化' });
    const body = (req.body ?? {}) as Partial<WorkstationHostClaimInput>;
    if (!body.code || !body.host) return reply.code(400).send({ error: '缺少绑定码或主机信息' });
    const { host } = store.claimHost(body.code, body.host);
    return claimResult(req, host);
  });

  app.get('/api/accounts/workspace/snapshot', async (req, reply) => {
    if (store.mode() !== 'center') return reply.code(404).send({ error: '本机不是工作站' });
    const token = req.headers['x-tandem-workspace-token'];
    const expected = store.syncSecret();
    if (expected && (typeof token !== 'string' || token !== expected)) {
      return reply.code(401).send({ error: '需要主机的工作站口令' });
    }
    return store.signedSnapshot();
  });

  // ---------- 账号接口 ----------
  app.get('/api/workstation/me', async (req) => {
    const { account } = accountOf(req);
    const status = store.status();
    return {
      account,
      workspace: status.workspace,
      hostId,
      role: account.role,
      projectDirs: [],
    };
  });

  app.get('/api/workstation/hosts', async (req) => store.visibleHostsForAccount(accountOf(req).account.id));

  app.post('/api/workstation/hosts/bind-code', async (req) => store.createHostBindCode(accountOf(req).account.id));

  app.post('/api/workstation/hosts/register', async (req, reply) => {
    const { account } = accountOf(req);
    const body = (req.body ?? {}) as { host?: WorkstationHostClaimInput['host'] };
    if (!body.host) return reply.code(400).send({ error: '缺少主机信息' });
    const host = store.registerHost(account.id, body.host);
    return claimResult(req, host);
  });

  app.delete('/api/workstation/hosts/:id', async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    store.removeHostByOwner(id, accountOf(req).account.id);
    // 移除后立即断开该主机的隧道；主机下次重连会因未登记被拒绝。
    const tunnel = tunnels.get(id);
    if (tunnel) {
      tunnels.delete(id);
      tunnel.closeAll('主机已被主人移除');
      tunnel.socket.close(4404, '主机已被主人移除');
    }
    return reply.code(204).send();
  });

  app.post('/api/workstation/hosts/:id/grants', async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    const body = (req.body ?? {}) as WorkstationGrantInput;
    return store.setHostGrant(id, accountOf(req).account.id, body);
  });

  app.delete('/api/workstation/hosts/:id/grants/:accountId', async (req, reply) => {
    const params = req.params as { id: string; accountId: string };
    store.removeHostGrant(decodeURIComponent(params.id), accountOf(req).account.id, decodeURIComponent(params.accountId));
    return reply.code(204).send();
  });

  app.get('/api/workstation/accounts', async (req) => {
    const query = req.query as Record<string, unknown>;
    return store.listAccountSummaries(typeof query.q === 'string' ? query.q : '');
  });

  const admin = (req: FastifyRequest, reply: import('fastify').FastifyReply): boolean => {
    const role = accountOf(req).account.role;
    if (role === 'admin' || role === 'owner') return true;
    void reply.code(403).send({ error: '仅工作站管理员可以执行此操作' });
    return false;
  };

  app.get('/api/workstation/overview', async (req, reply) => {
    if (!admin(req, reply)) return;
    return store.overview();
  });

  app.patch('/api/workstation/settings', async (req, reply) => {
    if (!admin(req, reply)) return;
    const body = (req.body ?? {}) as WorkstationSettingsInput;
    store.setRegistration(body, accountOf(req).account.username);
    return store.workstationStatus(addressInfo().urls);
  });

  app.post('/api/workstation/invites', async (req, reply) => {
    if (!admin(req, reply)) return;
    return store.createInvite(accountOf(req).account.username);
  });

  app.get('/api/workstation/audit', async (req, reply) => {
    if (!admin(req, reply)) return;
    const query = req.query as Record<string, unknown>;
    const limit = Math.max(1, Math.min(Number(query.limit ?? 200) || 200, 500));
    const state = (store as unknown as { state?: { mode: string; audit?: unknown[] } }).state;
    if (!state || state.mode !== 'center') return [];
    return (state.audit ?? []).slice(-limit);
  });

  // 旧客户端兼容：账号中心接口名不变，语义改为工作站。
  app.get('/api/accounts/status', async () => store.status());
  app.post('/api/accounts/login', async (req) => store.login((req.body ?? {}) as never));
  app.post('/api/accounts/refresh', async (req) => {
    const body = (req.body ?? {}) as { refreshToken?: unknown };
    return store.refresh(typeof body.refreshToken === 'string' ? body.refreshToken : '');
  });
  app.post('/api/accounts/logout', async (req, reply) => {
    const body = (req.body ?? {}) as { refreshToken?: unknown };
    store.logout(typeof body.refreshToken === 'string' ? body.refreshToken : '');
    return reply.code(204).send();
  });
  app.get('/api/accounts/me', async (req, reply) => {
    const me = store.me(tokenOf(req));
    if (!me) return reply.code(403).send({ error: '不是工作站账号令牌' });
    return me;
  });
  app.get('/api/accounts/hosts', async (req) => store.hostsFor(tokenOf(req)));

  // ---------- 隧道 ----------
  const parseClientUrl = (raw: string): { hostId: string; url: string } | null => {
    const match = /^\/h\/([^/?#]+)(\/[^#]*|\?[^#]*)?$/.exec(raw);
    if (!match || !isValidHostId(match[1])) return null;
    let rest = match[2] ?? '/';
    if (rest.startsWith('?')) rest = `/${rest}`;
    return { hostId: match[1], url: rest };
  };

  const proxy = (req: FastifyRequest, reply: import('fastify').FastifyReply): void => {
    reply.hijack();
    const raw = req.raw;
    const res = reply.raw;
    const fail = (status: number, message: string) => {
      const body = JSON.stringify({ error: message });
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'access-control-allow-origin': '*',
      });
      res.end(body);
    };
    const target = parseClientUrl(raw.url ?? '');
    if (!target) return fail(404, 'Not Found');
    if (!target.url.startsWith('/_e2e')) return fail(403, '工作站只转发端到端加密连接（/_e2e）');
    const tunnel = tunnels.get(target.hostId);
    if (!tunnel) return fail(502, '主机不在线');
    tunnel.proxyHttp(raw, res, target.url);
  };
  app.all('/h/:hostId', proxy);
  app.all('/h/:hostId/*', proxy);

  const handleTunnel = (ws: WebSocket): void => {
    const challenge = randomBytes(32).toString('base64url');
    let hostId: string | null = null;
    let tunnel: HostTunnel | null = null;
    const timer = setTimeout(() => ws.close(4408, '握手超时'), HELLO_TIMEOUT_MS);
    ws.send(JSON.stringify({ type: 'challenge', v: TUNNEL_VERSION, nonce: challenge } satisfies TunnelChallenge));
    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      try {
        if (isBinary) throw new Error('hello 必须是文本帧');
        const hello = parseJson<TunnelHello>(Buffer.from(data as Buffer));
        if (hello.type !== 'hello' || !isValidHostId(hello.hostId)) throw new Error('hello 无效');
        const registered = store.hostPublicKey(hello.hostId);
        if (!registered) {
          ws.close(4404, '主机未登记：请先在客户端添加主机');
          return;
        }
        if (registered !== hello.pub) {
          ws.close(4403, '主机公钥与登记不一致');
          return;
        }
        const pub = unb64u(hello.pub);
        if (pub.length !== 32) throw new Error('公钥长度无效');
        const ok = verify(null, registrationMessage(challenge, hello.hostId), ed25519Public(pub), unb64u(hello.sig));
        if (!ok) {
          ws.close(4401, '签名无效');
          return;
        }
        hostId = hello.hostId;
      } catch (err) {
        ws.close(4400, (err as Error).message.slice(0, 100));
        return;
      }
      const previous = tunnels.get(hostId);
      tunnel = new HostTunnel(hostId, ws, { maxStreams: MAX_STREAMS, bytesPerSec: BYTES_PER_SEC }, clientWss);
      tunnels.set(hostId, tunnel);
      if (previous) {
        previous.closeAll('主机已在别处重连');
        previous.socket.close(4409, '被同一公钥的新连接取代');
      }
      store.markHostOnline(hostId, true);
      ws.send(JSON.stringify({ type: 'ready' }));
      console.log(`[workstation] 主机上线 ${shortId(hostId)}（在线 ${tunnels.size}）`);
    });

    let alive = true;
    ws.on('pong', () => (alive = true));
    const pinger = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, TUNNEL_PING_MS);
    pinger.unref();

    ws.on('close', () => {
      clearTimeout(timer);
      clearInterval(pinger);
      if (hostId && tunnel) {
        tunnel.closeAll('主机已断开');
        if (tunnels.get(hostId) === tunnel) {
          tunnels.delete(hostId);
          store.markHostOnline(hostId, false);
          console.log(`[workstation] 主机下线 ${shortId(hostId)}（在线 ${tunnels.size}）`);
        }
      }
    });
    ws.on('error', () => ws.terminate());
  };

  const refuse = (socket: Duplex, status: string): void => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const rawUrl = req.url ?? '';
    if (rawUrl.split('?')[0] === TUNNEL_PATH) {
      tunnelWss.handleUpgrade(req, socket, head, (ws) => handleTunnel(ws));
      return;
    }
    const target = parseClientUrl(rawUrl);
    if (!target) return refuse(socket, '404 Not Found');
    if (!target.url.startsWith('/_e2e')) return refuse(socket, '403 Forbidden');
    const tunnel = tunnels.get(target.hostId);
    if (!tunnel) return refuse(socket, '502 Bad Gateway');
    tunnel.proxyWebSocket(req, socket, head, target.url, () => undefined);
  });

  // ---------- 静态 Web UI ----------
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
  const hasWeb = existsSync(path.join(webDist, 'index.html'));
  if (hasWeb) {
    void app.register(fastifyStatic, { root: webDist, prefix: '/' });
  }
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '';
    if (!hasWeb || req.method !== 'GET' || url.startsWith('/api') || url.startsWith('/h/') || url === TUNNEL_PATH) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return reply.sendFile('index.html');
  });

  return {
    app,
    store,
    listen: async (port, host) => {
      await debugReady;
      await app.listen({ port, host });
      const info = addressInfo();
      return info;
    },
    close: async () => {
      for (const tunnel of tunnels.values()) tunnel.socket.close(1001, '工作站关闭');
      store.close();
      await app.close();
    },
  };
}

/** 读取已存在的工作站数据（用于判断是否已初始化）。 */
export function readWorkstationMeta(home: string): { initialized: boolean } {
  const raw = readJson<{ mode?: string }>(path.join(home, 'accounts.json'));
  return { initialized: raw?.mode === 'center' };
}

export { hostIdFromHome };

function hostIdFromHome(home: string): string {
  return `ws-${createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 24)}`;
}

export type { WorkstationHostClaimResult };
