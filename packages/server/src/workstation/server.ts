// 工作站服务：程序本体。账号注册/登录、主机登记、授权、会话与 agent 都在这里。
// 主机上下文（本机 + 执行器主机）在同一进程内运行，客户端只连工作站并用 /h/<hostId> 访问主机。
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type {
  ListModelsInput,
  Profile,
  ProfileInput,
  WorkspaceHostInfo,
  WorkspaceModelProxyEvent,
  WorkspaceModelProxyInput,
  WorkspaceProfileImportItem,
  WorkspaceProfileImportResult,
  WorkspaceProfilesSnapshot,
  WorkstationHostClaimInput,
  WorkstationHostClaimResult,
  WorkstationGrantInput,
  WorkstationSettingsInput,
  WorkspaceAccount,
  WorkstationRegisterInput,
} from '@tandem/protocol';
import { AccountsStore } from '../accounts/store.js';
import { effectiveProfile, loadHostConfig, readJson } from '../config.js';
import { IS_DEBUG_FLAVOR } from '../flavor.js';
import { groupUnavailableError, orderedAvailableKeys, profileWithKey } from '../key-rotation.js';
import { listModels as fetchModelList, testProfile as testProviderProfile } from '../providers/index.js';
import { truncateEnd } from '../util/text.js';
import type { StoredProfile, StoredProfileGroup } from '../types.js';
import { buildUnixInstallScript, buildWindowsInstallScript } from './installScripts.js';
import { ExecutorHub } from '../executor/hub.js';
import { WS_PATH as EXECUTOR_PATH } from '../executor/wire.js';
import { AccountProfileStore } from './profiles.js';
import { streamAccountModel, WorkstationUsageStore } from './modelProxy.js';
import { BalanceService } from './balance.js';
import { parseProfileInput } from '../routes/profiles.js';
import { LocalHost, LOCAL_HOST_SUBDIR } from './local.js';
import type { WorkstationModelBridge } from './bridge.js';
import type { HostContext } from './context.js';
import { isLoopbackAddress } from '../util/net.js';

const MAX_FRAME = 40 * 1024 * 1024;

export interface WorkstationOptions {
  /** accounts.json 所在目录（工作站独立数据目录）。 */
  home: string;
  hostId?: string;
  hostName?: string;
  version?: string;
}

export interface WorkstationModelService {
  stream: (input: WorkspaceModelProxyInput, emit: (event: WorkspaceModelProxyEvent) => void, signal: AbortSignal, hostId?: string) => Promise<void>;
  listModels: (accountId: string, input: ListModelsInput) => Promise<Awaited<ReturnType<typeof fetchModelList>>>;
  testProfile: (accountId: string, profileId: string, groupId?: string, keyId?: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface WorkstationHandle {
  app: FastifyInstance;
  store: AccountsStore;
  /** 本机主机上下文的 hostId（「添加这台机器」成功后出现在主机列表）。 */
  localHostId: string;
  /** 账号级模型账号（加密存储）。 */
  profiles: AccountProfileStore;
  /** 按账号的模型用量记账。 */
  usage: WorkstationUsageStore;
  /** 账号余额查询（5 分钟缓存）。 */
  balanceService: BalanceService;
  /** 进程内直连入口（个人模式桌面端）。 */
  modelService: WorkstationModelService;
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

const EXECUTOR_TARGET = /^(linux|darwin|windows)-(amd64|arm64)$/;

/** 执行器构建产物目录（scripts/build-executor.mjs 的输出）。 */
export function executorDistDir(): string {
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  return process.env.TANDEM_EXECUTOR_DIST
    ? path.resolve(process.env.TANDEM_EXECUTOR_DIST)
    : path.resolve(serverRoot, '../executor/dist');
}

function executorFileName(target: string): string {
  return `tandem-exec-${target}${target.startsWith('windows-') ? '.exe' : ''}`;
}

/** 目标名 → 执行器 sha256（来自构建产物的 SHA256SUMS；安装脚本嵌入它做校验）。 */
export function executorDigests(dir = executorDistDir()): Record<string, string> {
  const digests: Record<string, string> = {};
  let text = '';
  try {
    text = readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8');
  } catch {
    return digests;
  }
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?tandem-exec-(\S+?)(?:\.exe)?$/.exec(line.trim());
    if (match) digests[match[2]!] = match[1]!;
  }
  return digests;
}

export function createWorkstation(options: WorkstationOptions): WorkstationHandle {
  const hostId =
    options.hostId ?? `ws-${createHash('sha256').update(path.resolve(options.home)).digest('hex').slice(0, 24)}`;
  // 本机主机上下文的数据目录里已有（或生成）稳定的 hostId；列表里据此标记「本机」。
  const localHostId = loadHostConfig(path.join(options.home, LOCAL_HOST_SUBDIR)).hostId;
  const store = new AccountsStore({
    home: options.home,
    hostId,
    hostName: options.hostName ?? os.hostname(),
    ...(options.version ? { version: options.version } : {}),
    platform: process.platform,
    localHostId,
  });
  const profiles = new AccountProfileStore(options.home);
  const usage = new WorkstationUsageStore(options.home);
  const balances = new BalanceService();
  const rotation = new Map<string, number>();

  const profileKey = (
    accountId: string,
    profileId: string,
    groupId?: string,
    keyId?: string,
  ): { profile: StoredProfile; group?: StoredProfileGroup; keyId?: string } | undefined => {
    const stored = profiles.get(accountId, profileId);
    if (!stored) return undefined;
    const group = groupId ? stored.groups?.find((item) => item.id === groupId) : undefined;
    if (groupId && !group) return undefined;
    const effective = effectiveProfile(stored, groupId);
    const candidates = group?.keys?.length ? orderedAvailableKeys(group.keys, group.keyStrategy) : [];
    const key = keyId
      ? group?.keys?.find((item) => item.id === keyId)
      : candidates[0] ?? (keyId ? undefined : group?.keys?.[0]);
    if (keyId && !key) return undefined;
    if (group && (group.keys?.length ?? 0) > 0 && !key) return { profile: effective, group, keyId: '' };
    return {
      profile: key ? profileWithKey(effective, key) : effective,
      ...(group ? { group } : {}),
      ...(key ? { keyId: key.id } : {}),
    };
  };

  const modelService: WorkstationModelService = {
    stream: (input, emit, signal, hostId) =>
      streamAccountModel(
        { profiles, usage, accountId: input.accountId, hostId: hostId ?? 'embedded', rotation },
        input,
        emit,
        signal,
      ),
    listModels: async (accountId, input) => {
      const profile = input.profileId ? profiles.get(accountId, input.profileId) : undefined;
      const group = input.groupId ? profile?.groups?.find((item) => item.id === input.groupId) : undefined;
      const effective = profile ? effectiveProfile(profile, input.groupId) : undefined;
      const key = group?.keys?.length ? orderedAvailableKeys(group.keys, group.keyStrategy)[0] : undefined;
      const callProfile = effective && key ? profileWithKey(effective, key) : effective;
      return fetchModelList(
        { ...input, ...(callProfile?.apiKey ? { apiKey: callProfile.apiKey } : {}) },
        callProfile,
      );
    },
    testProfile: async (accountId, profileId, groupId, keyId) => {
      const resolved = profileKey(accountId, profileId, groupId, keyId);
      if (!resolved) return { ok: false, error: '账号或 Key 不存在' };
      if (resolved.group && (resolved.group.keys?.length ?? 0) > 0 && !resolved.keyId) {
        return { ok: false, error: groupUnavailableError(resolved.group, new Map()) || '分组没有可用 Key' };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        return await testProviderProfile(resolved.profile, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    },
  };

  // 主机上下文的 agent 直接调用账号级模型账号（进程内，不经签名 HTTP 代理）。
  const modelBridge: WorkstationModelBridge = {
    snapshot: (accountId) => snapshotFor(accountId),
    importProfiles: async (accountId, incoming) => importProfilesInto(accountId, incoming),
    runProxy: (accountId, hostId, body, emit, signal) =>
      streamAccountModel({ profiles, usage, accountId, hostId, rotation }, { ...body, accountId }, emit, signal),
    listModels: (accountId, input) => modelService.listModels(accountId, input),
    testProfile: (accountId, profileId, groupId, keyId) =>
      modelService.testProfile(accountId, profileId, groupId, keyId),
    publicProfiles: (accountId) => profiles.publicList(accountId),
  };
  const local = new LocalHost(options.home, modelBridge, options.version);

  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  // 调试版：自动创建本地测试账号并挂上仅回环可用的免密登录；发布构建不会加载这个模块。
  // 回归/联调用 TANDEM_DEBUG_ACCOUNT=0 模拟发布语义（只影响 debug 构建）。
  const debugAccountEnabled =
    IS_DEBUG_FLAVOR && process.env.TANDEM_DEBUG_ACCOUNT !== '0';
  const debugReady = debugAccountEnabled
    ? import('../debug/workstationService.js')
        .then((mod) => mod.ensureDebugWorkstation(store, options.home, app, profiles))
        .catch((err: unknown) => {
          console.warn('[workstation] 调试初始化失败:', (err as Error).message);
        })
    : Promise.resolve();
  const executorWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const selfUrl = (): string => {
    const address = app.server.address();
    const port = address && typeof address === 'object' ? address.port : 8481;
    const bound = address && typeof address === 'object' ? address.address : '127.0.0.1';
    const wildcard = bound === '0.0.0.0' || bound === '::' || bound === '::0';
    const host = wildcard ? '127.0.0.1' : bound.includes(':') ? `[${bound}]` : bound;
    return `http://${host}:${port}`;
  };
  const executors = new ExecutorHub({ home: options.home, store, selfUrl, modelBridge });

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
    if (url.startsWith('/h/')) return done(null);
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

  app.get('/healthz', async () => ({
    ok: true,
    hostsOnline: (hostOnline(local.hostId) ? 1 : 0) + extraContexts.size + executors.onlineCount(),
    initialized: store.mode() === 'center',
  }));

  // 执行器二进制（无压缩）；安装脚本用嵌入的 sha256 校验。
  app.get('/executor/:target', async (req, reply) => {
    const { target } = req.params as { target: string };
    const file = EXECUTOR_TARGET.test(target) ? path.join(executorDistDir(), executorFileName(target)) : '';
    if (!file || !existsSync(file)) {
      return reply.code(404).send({ error: `工作站没有 ${target} 平台的执行器` });
    }
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(statSync(file).size));
    reply.header('content-disposition', `attachment; filename="${executorFileName(target)}"`);
    return reply.send(createReadStream(file));
  });

  // ---------- 公开接口 ----------
  const requestOrigin = (req: FastifyRequest): string => {
    const hostHeader = req.headers.host;
    return hostHeader ? `http://${hostHeader}` : addressInfo().urls[0]!;
  };

  app.get('/api/workstation/status', async () => {
    const { urls } = addressInfo();
    return {
      ...store.workstationStatus(urls),
      ...(debugAccountEnabled ? { debug: true } : {}),
    };
  });

  // 一行命令添加主机：脚本默认使用下载它的地址；不嵌入令牌。
  app.get('/install.sh', async (req, reply) => {
    reply.header('content-type', 'text/x-shellscript; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return buildUnixInstallScript({ server: requestOrigin(req), digests: executorDigests() });
  });

  app.get('/install.ps1', async (req, reply) => {
    reply.header('content-type', 'text/plain; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return buildWindowsInstallScript({ server: requestOrigin(req), digests: executorDigests() });
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
      ...(host.ownerId ? { ownerAccountId: host.ownerId } : {}),
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

  // 「添加这台机器」：把运行工作站的这台机器登记为当前账号的主机（仅本机回环可操作）。
  app.post('/api/workstation/hosts/local', async (req, reply) => {
    if (store.mode() !== 'center') return reply.code(404).send({ error: '工作站尚未初始化' });
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      return reply.code(403).send({ error: '只能在工作站这台机器上添加本机主机' });
    }
    try {
      if (!local.context) await local.start(selfUrl());
      return await local.register(store, accountOf(req).account.id, selfUrl());
    } catch (err) {
      return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/workstation/hosts/:id', async (req, reply) => {
    const id = decodeURIComponent((req.params as { id: string }).id);
    store.removeHostByOwner(id, accountOf(req).account.id);
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

  // ---------- 账号级模型账号（Key 加密保存在工作站） ----------
  const snapshotFor = async (accountId: string, refreshBalances = false): Promise<WorkspaceProfilesSnapshot> => {
    const store = profiles.forAccount(accountId);
    return {
      accountId,
      profiles: await balances.attach(accountId, store.list(), profiles.publicList(accountId), refreshBalances),
    };
  };

  app.get('/api/workstation/profiles', async (req) => {
    const query = req.query as Record<string, unknown>;
    return snapshotFor(accountOf(req).account.id, query.refresh === '1' || query.refresh === 'true');
  });

  app.post('/api/workstation/profiles', async (req, reply) => {
    try {
      return profiles.create(accountOf(req).account.id, parseProfileInput(req.body));
    } catch (err) {
      return reply.code((err as { statusCode?: number }).statusCode ?? 400).send({ error: (err as Error).message });
    }
  });

  app.put('/api/workstation/profiles/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const updated = profiles.update(accountOf(req).account.id, id, parseProfileInput(req.body));
      return updated ?? reply.code(404).send({ error: '账号不存在' });
    } catch (err) {
      return reply.code((err as { statusCode?: number }).statusCode ?? 400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/workstation/profiles/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!profiles.remove(accountOf(req).account.id, id)) return reply.code(404).send({ error: '账号不存在' });
    return reply.code(204).send();
  });

  app.post('/api/workstation/profiles/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { groupId?: unknown; keyId?: unknown };
    const result = await modelService.testProfile(
      accountOf(req).account.id,
      id,
      typeof body.groupId === 'string' ? body.groupId : undefined,
      typeof body.keyId === 'string' ? body.keyId : undefined,
    );
    if (!result.ok && result.error === '账号或 Key 不存在') return reply.code(404).send({ error: result.error });
    return result;
  });

  /** 账号级模型账号的历史导入（主机上下文不再经过 HTTP，由 bridge 调用）。 */
  const importProfilesInto = (accountId: string, incoming: WorkspaceProfileImportItem[]): WorkspaceProfileImportResult => {
    const stored: StoredProfile[] = [];
    for (const item of incoming) {
      if (!item || typeof item !== 'object' || !item.name || !item.kind) continue;
      const profile = item as unknown as StoredProfile;
      stored.push({
        ...profile,
        id: typeof profile.id === 'string' && profile.id ? profile.id : randomUUID(),
        apiKey: typeof profile.apiKey === 'string' ? profile.apiKey : '',
        models: Array.isArray(profile.models) ? profile.models : [],
        defaultModel: profile.defaultModel || profile.models?.[0] || '',
        createdAt: profile.createdAt || Date.now(),
      });
    }
    const result = profiles.importStored(accountId, stored);
    return { ...result, profiles: profiles.publicList(accountId) };
  };

  // ---------- 主机转发（/h/<hostId>） ----------
  // 所有主机上下文都在本进程内，只监听回环随机端口；工作站把它们直接转给客户端。
  const extraContexts = new Map<string, HostContext>();
  const contextById = (hostId: string): HostContext | undefined => {
    if (hostId === local.hostId) return local.context;
    return extraContexts.get(hostId) ?? executors.context(hostId);
  };
  const hostOnline = (hostId: string): boolean => {
    if (hostId === local.hostId) return !!local.context;
    if (extraContexts.has(hostId)) return true;
    return executors.isLive(hostId);
  };

  const parseClientUrl = (raw: string): { hostId: string; url: string } | null => {
    const match = /^\/h\/([^/?#]+)(\/[^#]*|\?[^#]*)?$/.exec(raw);
    if (!match || !/^[A-Za-z0-9_-]{8,64}$/.test(match[1]!)) return null;
    let rest = match[2] ?? '/';
    if (rest.startsWith('?')) rest = `/${rest}`;
    return { hostId: match[1]!, url: rest };
  };

  const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

  const proxy = (req: FastifyRequest, reply: import('fastify').FastifyReply): void => {
    reply.hijack();
    const raw = req.raw;
    const res = reply.raw;
    const fail = (status: number, message: string) => {
      const body = JSON.stringify({ error: message });
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };
    const target = parseClientUrl(raw.url ?? '');
    if (!target) return fail(404, 'Not Found');
    const ctx = contextById(target.hostId);
    if (!ctx || !hostOnline(target.hostId)) return fail(502, '主机不在线');
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(raw.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers.host = `127.0.0.1:${ctx.port}`;
    if (typeof raw.headers.host === 'string') headers['x-forwarded-host'] = raw.headers.host;
    headers['x-forwarded-prefix'] = `/h/${target.hostId}`;
    const upstream = http.request(
      { host: '127.0.0.1', port: ctx.port, method: raw.method, path: target.url, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) fail(502, '主机不在线');
      else res.destroy();
    });
    raw.pipe(upstream);
  };
  app.all('/h/:hostId', proxy);
  app.all('/h/:hostId/*', proxy);

  const refuse = (socket: Duplex, status: string): void => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  const proxyWebSocket = (req: IncomingMessage, socket: Duplex, head: Buffer, target: { hostId: string; url: string }): void => {
    const ctx = contextById(target.hostId);
    if (!ctx || !hostOnline(target.hostId)) return refuse(socket, '502 Bad Gateway');
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers.host = `127.0.0.1:${ctx.port}`;
    if (typeof req.headers.host === 'string') headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-prefix'] = `/h/${target.hostId}`;
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade ?? 'websocket';
    const upstream = http.request({ host: '127.0.0.1', port: ctx.port, method: 'GET', path: target.url, headers });
    upstream.on('upgrade', (up, upSocket, upHead) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
    });
    upstream.on('response', (up) => {
      up.resume();
      refuse(socket, `${up.statusCode ?? 502} ${up.statusMessage ?? ''}`.trim());
    });
    upstream.on('error', () => refuse(socket, '502 Bad Gateway'));
    upstream.end();
  };

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const rawUrl = req.url ?? '';
    if (rawUrl.split('?')[0] === EXECUTOR_PATH) {
      executorWss.handleUpgrade(req, socket, head, (ws) => executors.accept(ws));
      return;
    }
    const target = parseClientUrl(rawUrl);
    if (!target) return refuse(socket, '404 Not Found');
    proxyWebSocket(req, socket, head, target);
  });

  // ---------- 静态 Web UI ----------
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
  const hasWeb = existsSync(path.join(webDist, 'index.html'));
  if (hasWeb) {
    void app.register(fastifyStatic, { root: webDist, prefix: '/' });
  }
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '';
    if (!hasWeb || req.method !== 'GET' || url.startsWith('/api') || url.startsWith('/h/')) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return reply.sendFile('index.html');
  });

  return {
    app,
    store,
    localHostId,
    profiles,
    usage,
    modelService,
    balanceService: balances,
    listen: async (port, host) => {
      await debugReady;
      await app.listen({ port, host });
      const self = selfUrl();
      await executors.restore();
      await local.start(self).catch((err: unknown) => {
        console.warn('[workstation] 本机主机上下文启动失败:', (err as Error).message);
      });
      await local.adopt(store, self).catch(() => undefined);
      if (debugAccountEnabled) {
        const mod = await import('../debug/hosts.js').catch(() => undefined);
        await mod
          ?.ensureDebugHosts({
            store,
            selfUrl: self,
            local,
            extraContexts,
            modelBridge,
            home: options.home,
            ...(options.version ? { version: options.version } : {}),
          })
          .catch((err: unknown) => console.warn('[workstation] 调试主机初始化失败:', (err as Error).message));
      }
      const info = addressInfo();
      return info;
    },
    close: async () => {
      for (const ctx of extraContexts.values()) await ctx.close().catch(() => undefined);
      extraContexts.clear();
      profiles.dispose();
      store.close();
      await local.close().catch(() => undefined);
      await executors.close();
      await app.close();
    },
  };
}

export type { WorkstationHostClaimResult };
