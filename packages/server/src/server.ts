// Fastify 服务：REST + WebSocket + 静态托管 + token 鉴权 + CORS。
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type {
  ClientMsg,
  ConfigBundle,
  ConfigExportInput,
  ConfigImportInput,
  CreateSessionInput,
  ExternalSource,
  FsEntry,
  ListModelsInput,
  PermissionDecision,
  ProfileGroupInput,
  ProfileInput,
  ProviderKind,
  RewindInput,
  UpdateSessionInput,
} from '@tandem/protocol';
import type { Host } from './host.js';
import { commitChanges, getChanges, getFileDiff, revertChanges } from './changes.js';
import type { WsClient } from './events.js';
import { testProfile } from './providers/index.js';
import { exportBundle, importBundle } from './migrate.js';
import { walkFiles } from './util/fs-walk.js';
import { expandHome, toPosix } from './util/path.js';
import { truncateEnd } from './util/text.js';

const PROVIDER_KINDS: ProviderKind[] = ['anthropic', 'openai', 'openai-compatible', 'gemini'];

function bad(reply: FastifyReply, message: string, code = 400): FastifyReply {
  return reply.code(code).send({ error: message });
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isExternalSource(value: string): value is ExternalSource {
  return value === 'claude-code' || value === 'codex';
}

/** 迁移错误默认按 400 返回，避免把口令错误当服务器故障。 */
function statusOf(err: unknown): number {
  const status = (err as { statusCode?: number }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : 400;
}

function parseProfileInput(body: unknown): ProfileInput {
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
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
    models,
    defaultModel,
    groups: parseGroupInputs(raw.groups),
    ...(raw.price && typeof raw.price === 'object'
      ? { price: raw.price as NonNullable<ProfileInput['price']> }
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
      return {
        ...(str(item.id) ? { id: str(item.id) } : {}),
        name: str(item.name),
        ...(typeof item.apiKey === 'string' && item.apiKey ? { apiKey: item.apiKey } : {}),
        ...(str(item.baseUrl) ? { baseUrl: str(item.baseUrl) } : {}),
        models,
        defaultModel: str(item.defaultModel) || models[0] || '',
      };
    })
    .filter((group) => !!group.name);
}

/** @文件补全的模糊匹配打分；不匹配返回 null。 */
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) {
    // 越靠前、越短越优先
    return 1000 - direct * 3 - t.length * 0.1;
  }
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += prev === ti - 1 ? 8 : 2;
      prev = ti;
      qi++;
    }
  }
  return qi === q.length ? score - t.length * 0.1 : null;
}

export async function createApp(host: Host): Promise<FastifyInstance> {
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
    if (!urlPath.startsWith('/api') && urlPath !== '/ws') return;

    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : undefined;
    const query = req.query as Record<string, unknown> | undefined;
    const token = bearer || (typeof query?.token === 'string' ? query.token : undefined);
    if (token !== host.config.token) {
      return reply.code(401).send({ error: '未授权：token 无效' });
    }
  });

  app.setErrorHandler((rawErr: unknown, _req, reply) => {
    const err = rawErr as { statusCode?: number; message?: string };
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) console.error('[tandem] 请求处理失败:', rawErr);
    reply.code(status).send({ error: err.message ?? '服务器内部错误' });
  });

  // ---------- Host ----------
  app.get('/api/host', async () => host.info());

  // ---------- 账号 ----------
  app.get('/api/profiles', async () => host.profiles.list().map((p) => host.profiles.toPublic(p)));

  app.post('/api/profiles', async (req, reply) => {
    try {
      const input = parseProfileInput(req.body);
      return host.profiles.toPublic(host.profiles.create(input));
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.put('/api/profiles/:id', async (req, reply) => {
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
    const { id } = req.params as { id: string };
    if (!host.profiles.delete(id)) return bad(reply, '账号不存在', 404);
    return reply.code(204).send();
  });

  app.post('/api/profiles/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { groupId?: unknown };
    const groupId = str(body.groupId) || undefined;
    const base = host.profiles.get(id);
    if (!base) return bad(reply, '账号不存在', 404);
    if (groupId && !base.groups?.some((g) => g.id === groupId)) return bad(reply, '分组不存在');
    // 测试分组时用分组的 key/baseUrl
    const profile = host.profileFor(id, groupId)!;
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

  // ---------- 模型列表 ----------
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

  // ---------- 会话 ----------
  app.get('/api/sessions', async () => host.listSessions().map((s) => host.toSummary(s)));

  app.post('/api/sessions', async (req, reply) => {
    try {
      const input = (req.body ?? {}) as Partial<CreateSessionInput>;
      const rec = await host.createSession(input);
      // 创建时检测 cwd 的 git 仓库/分支，供侧栏归类
      await host.refreshEnv(rec.id);
      return reply.code(201).send(host.toSummary(rec));
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    return host.toSession(rec);
  });

  app.patch('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const patch = (req.body ?? {}) as Partial<UpdateSessionInput>;
      const rec = host.updateSession(id, patch);
      if (!rec) return bad(reply, '会话不存在', 404);
      return host.toSummary(rec);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.delete('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { force?: string };
    const force = query.force === '1' || query.force === 'true';
    try {
      if (!(await host.deleteSession(id, force))) return bad(reply, '会话不存在', 404);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
    return reply.code(204).send();
  });

  // worktree 会话合回基准分支
  app.post('/api/sessions/:id/worktree/merge', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!host.getSession(id)) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as { strategy?: unknown };
    const strategy = body.strategy === 'squash' ? 'squash' : body.strategy === 'merge' || body.strategy === undefined ? 'merge' : '';
    if (!strategy) return bad(reply, 'strategy 必须是 merge 或 squash');
    try {
      return await host.mergeSessionWorktree(id, strategy);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.post('/api/sessions/:id/fork', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.forkSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    return host.toSummary(rec);
  });

  // ---------- 检查点 ----------
  app.get('/api/sessions/:id/checkpoints', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!host.getSession(id)) return bad(reply, '会话不存在', 404);
    return host.listCheckpoints(id);
  });

  app.post('/api/sessions/:id/rewind', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!host.getSession(id)) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as Partial<RewindInput>;
    try {
      return host.rewind(id, {
        checkpointId: typeof body.checkpointId === 'string' ? body.checkpointId : '',
        restoreFiles: body.restoreFiles === true,
        restoreConversation: body.restoreConversation === true,
      });
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  // ---------- 改动审阅（git 工作区） ----------
  app.get('/api/sessions/:id/changes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    return getChanges(rec.cwd);
  });

  app.get('/api/sessions/:id/changes/diff', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const query = req.query as { path?: string };
    const filePath = str(query.path);
    if (!filePath) return bad(reply, 'path 不能为空');
    try {
      return await getFileDiff(rec.cwd, filePath);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/sessions/:id/changes/revert', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as { paths?: unknown };
    if (!Array.isArray(body.paths)) return bad(reply, 'paths 必须是数组');
    try {
      return await revertChanges(rec.cwd, body.paths.filter((p): p is string => typeof p === 'string'));
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/sessions/:id/changes/commit', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = host.getSession(id);
    if (!rec) return bad(reply, '会话不存在', 404);
    const body = (req.body ?? {}) as { message?: unknown; paths?: unknown };
    return commitChanges(rec.cwd, body.message, body.paths);
  });

  // ---------- 权限规则（Host 级） ----------
  app.get('/api/permissions', async () => host.permissionRules.list());

  app.put('/api/permissions', async (req, reply) => {
    try {
      return host.permissionRules.set(req.body);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  // ---------- MCP ----------
  app.get('/api/mcp', async (req) => {
    const query = req.query as { cwd?: string; retry?: string };
    const cwd = str(query.cwd) ? path.resolve(expandHome(str(query.cwd))) : undefined;
    const retry = str(query.retry) === '1';
    // GET 默认只补齐尚未连接的服务器，不重试失败项；只有显式刷新才强制重连。
    if (retry) void host.mcp.prepare(cwd, true);
    else if (cwd) void host.mcp.prepare(cwd, false, false);
    return { servers: host.mcp.servers(cwd), status: host.mcp.status(cwd) };
  });

  app.put('/api/mcp', async (req, reply) => {
    try {
      const servers = await host.mcp.save(req.body);
      return { servers, status: host.mcp.status() };
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  // ---------- 用量统计 ----------
  app.get('/api/usage', async (req) => {
    const query = req.query as { from?: string; to?: string };
    return host.usage.list(str(query.from) || undefined, str(query.to) || undefined);
  });

  // ---------- 配对（手机扫码连接） ----------
  app.get('/api/pair', async () => {
    const address = app.server.address();
    const port =
      address && typeof address === 'object' && address.port
        ? address.port
        : 7878;
    const bound = address && typeof address === 'object' ? address.address : '127.0.0.1';
    const lan = bound === '0.0.0.0' || bound === '::' || bound === '::0';
    if (!lan) {
      return {
        urls: [`http://127.0.0.1:${port}`],
        token: host.config.token,
        loopback: true,
        hint: 'Host 仅监听本机地址；用 --host 0.0.0.0 启动后可生成局域网 / Tailscale 配对地址。',
      };
    }
    const urls: string[] = [];
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        const family = String(entry.family);
        const isV4 = family === 'IPv4' || family === '4';
        if (!isV4 || entry.internal) continue;
        urls.push(`http://${entry.address}:${port}`);
      }
    }
    if (urls.length === 0) urls.push(`http://127.0.0.1:${port}`);
    return { urls, token: host.config.token };
  });

  // ---------- 外部会话（只读，不写原软件文件） ----------
  app.get('/api/external-sessions', async (req, reply) => {
    const query = req.query as { source?: string };
    const source = str(query.source);
    if (source && !isExternalSource(source)) return bad(reply, 'source 无效');
    return host.external.list(source ? (source as ExternalSource) : undefined);
  });

  app.get('/api/external-sessions/:source/:id', async (req, reply) => {
    const { source, id } = req.params as { source: string; id: string };
    if (!isExternalSource(source)) return bad(reply, 'source 无效');
    const session = host.external.preview(source, id);
    if (!session) return bad(reply, '外部会话不存在', 404);
    return session;
  });

  app.post('/api/external-sessions/:source/:id/import', async (req, reply) => {
    const { source, id } = req.params as { source: string; id: string };
    if (!isExternalSource(source)) return bad(reply, 'source 无效');
    try {
      const rec = await host.external.importSession(source, id, (req.body ?? {}) as Record<string, unknown>);
      if (!rec) return bad(reply, '外部会话不存在', 404);
      await host.refreshEnv(rec.id);
      return reply.code(201).send(host.toSummary(rec));
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  // ---------- 配置迁移 ----------
  app.post('/api/config/export', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<ConfigExportInput>;
    try {
      return exportBundle(host.profiles.list(), os.hostname(), {
        passphrase: typeof body.passphrase === 'string' ? body.passphrase : '',
        ...(body.clientSettings !== undefined ? { clientSettings: body.clientSettings } : {}),
      });
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.post('/api/config/import', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<ConfigImportInput>;
    try {
      return importBundle(host.profiles, {
        passphrase: typeof body.passphrase === 'string' ? body.passphrase : '',
        bundle: body.bundle as ConfigBundle,
        mode: body.mode as ConfigImportInput['mode'],
      });
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  // ---------- 文件系统 ----------
  app.get('/api/fs/list', async (req, reply) => {
    const query = req.query as { path?: string };
    const raw = str(query.path) || os.homedir();
    const dir = path.resolve(expandHome(raw));
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      return bad(reply, `目录不存在: ${dir}`);
    }
    if (!stat.isDirectory()) return bad(reply, `不是目录: ${dir}`);

    const entries: FsEntry[] = [];
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return bad(reply, `无法读取目录: ${(err as Error).message}`);
    }
    for (const entry of dirents) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) continue;
      entries.push({ name: entry.name, path: full, isDir: true });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  });

  app.get('/api/fs/complete', async (req, reply) => {
    const query = req.query as { cwd?: string; q?: string };
    const cwdRaw = str(query.cwd) || process.cwd();
    const cwd = path.resolve(expandHome(cwdRaw));
    const q = str(query.q);
    if (!q) return [] as string[];
    try {
      if (!statSync(cwd).isDirectory()) return bad(reply, `不是目录: ${cwd}`);
    } catch {
      return bad(reply, `目录不存在: ${cwd}`);
    }

    const files = walkFiles(cwd, { maxEntries: 20_000 });
    const scored: Array<{ rel: string; score: number }> = [];
    for (const file of files) {
      const rel = toPosix(path.relative(cwd, file));
      if (rel.startsWith('..')) continue;
      const score = fuzzyScore(q, rel);
      if (score !== null) scored.push({ rel, score });
    }
    scored.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
    return scored.slice(0, 50).map((item) => item.rel);
  });

  // ---------- 斜杠命令 ----------
  app.get('/api/commands', async (req) => {
    const query = req.query as { cwd?: string };
    const cwd = str(query.cwd) ? path.resolve(expandHome(str(query.cwd))) : process.cwd();
    return host.listCommands(cwd);
  });

  // ---------- WebSocket ----------
  app.get('/ws', { websocket: true }, (socket, _req) => {
    const client = socket as unknown as WsClient;
    host.hub.add(client);
    host.hub.send(client, { type: 'hello', host: host.info() });

    const sendError = (message: string) => host.hub.send(client, { type: 'error', message });

    socket.on('message', (data: Buffer) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString()) as ClientMsg;
      } catch {
        sendError('无法解析 WebSocket 消息');
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
        sendError('消息格式无效');
        return;
      }
      switch (msg.type) {
        case 'subscribe': {
          const snapshot = host.snapshot(msg.sessionId);
          if (!snapshot) {
            sendError('会话不存在');
            return;
          }
          host.hub.subscribe(client, msg.sessionId);
          const sinceSeq =
            typeof msg.sinceSeq === 'number' && Number.isFinite(msg.sinceSeq)
              ? msg.sinceSeq
              : undefined;
          if (sinceSeq !== undefined) {
            const events = host.hub.replay(msg.sessionId, sinceSeq);
            if (events) {
              // 缓冲覆盖：按序补发，客户端不必再要快照
              for (const event of events) host.hub.send(client, event);
              break;
            }
            // 缓冲不覆盖（Host 重启 / 已回退）：退回全量快照
          }
          host.hub.send(client, {
            type: 'session_snapshot',
            session: snapshot.session,
            pendingPermissions: snapshot.pendingPermissions,
            seq: host.hub.currentSeq(msg.sessionId),
          });
          break;
        }
        case 'unsubscribe':
          host.hub.unsubscribe(client, msg.sessionId);
          break;
        case 'send':
          void host.send(msg.sessionId, msg.content).catch((err: Error) => sendError(err.message));
          break;
        case 'interrupt':
          host.interrupt(msg.sessionId);
          break;
        case 'permission':
          host.resolvePermission(msg.requestId, msg.decision as PermissionDecision);
          break;
        case 'ping':
          host.hub.send(client, { type: 'pong' });
          break;
        default:
          sendError('未知消息类型');
          break;
      }
    });

    socket.on('close', () => host.hub.remove(client));
    socket.on('error', () => host.hub.remove(client));
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
