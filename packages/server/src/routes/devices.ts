// 工作站设备：本机设备服务（供其他 Host 用设备级令牌调用）与会话挂载/串口/logcat API。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeviceMountInput } from '@tandem/protocol';
import type { RouteDeps } from './common.js';
import { bad, str } from './common.js';
import { canSend, isOwner, principalOf } from '../team/access.js';

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function clientId(req: FastifyRequest, body?: Record<string, unknown>): string {
  const header = req.headers['x-tandem-device-client'];
  const fromHeader = typeof header === 'string' ? header.trim() : '';
  if (fromHeader && fromHeader !== 'session') return fromHeader;
  const fromBody = typeof body?.client === 'string' ? body.client.trim() : '';
  if (fromBody) return fromBody;
  const principal = principalOf(req);
  return principal.kind === 'owner' ? 'owner' : principal.id;
}

/** 设备服务写操作：所有者、协作者或设备级令牌。 */
function canOperate(req: FastifyRequest): boolean {
  const principal = principalOf(req);
  if (principal.kind === 'owner' || principal.kind === 'device') return true;
  return canSend(principal.role);
}

function readBody(req: FastifyRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

export function registerDeviceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;
  const devices = host.devices;

  // ---------- 本机设备服务 ----------

  app.get('/api/devices', async () => devices.listLocal());

  // 设备级令牌只允许所有者签发/查看/撤销；明文只返回一次。
  app.post('/api/devices/peer-tokens', async (req, reply) => {
    if (!isOwner(req)) return bad(reply, '仅 Host 所有者可以签发设备令牌', 403);
    const body = readBody(req);
    return devices.issuePeerToken(str(body.label));
  });
  app.get('/api/devices/peer-tokens', async (req, reply) => {
    if (!isOwner(req)) return bad(reply, '仅 Host 所有者可以查看设备令牌', 403);
    return devices.listPeerTokens();
  });
  app.delete('/api/devices/peer-tokens/:id', async (req, reply) => {
    if (!isOwner(req)) return bad(reply, '仅 Host 所有者可以撤销设备令牌', 403);
    const params = req.params as { id: string };
    if (!devices.revokePeerToken(params.id)) return bad(reply, '设备令牌不存在', 404);
    return { ok: true };
  });

  app.post('/api/devices/:id/exec', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能操作设备', 403);
    const body = readBody(req);
    const kind = body.kind === 'install' ? 'install' : 'shell';
    try {
      return await devices.execForClient(clientId(req, body), decodeId((req.params as { id: string }).id), kind, {
        ...(typeof body.command === 'string' ? { command: body.command } : {}),
        ...(typeof body.apkPath === 'string' ? { apkPath: body.apkPath } : {}),
        ...(typeof body.timeout === 'number' ? { timeout: body.timeout } : {}),
      });
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/devices/:id/logcat/start', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能操作设备', 403);
    const body = readBody(req);
    try {
      return await devices.startLogcatForClient(
        clientId(req, body),
        decodeId((req.params as { id: string }).id),
        typeof body.filter === 'string' ? body.filter : undefined,
      );
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
  app.get('/api/devices/:id/logcat/:streamId', async (req) => {
    const params = req.params as { id: string; streamId: string };
    const query = req.query as { since?: string };
    void params.id;
    const since = Number(query.since);
    return devices.readDeviceLogcat(params.streamId, Number.isFinite(since) ? since : 0);
  });
  app.post('/api/devices/:id/logcat/:streamId/stop', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能操作设备', 403);
    const params = req.params as { id: string; streamId: string };
    return { ok: devices.stopDeviceLogcat(params.streamId) };
  });

  app.post('/api/devices/:id/serial/open', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能操作设备', 403);
    const body = readBody(req);
    const baud = Number(body.baud);
    if (!Number.isFinite(baud) || baud <= 0 || baud > 4_000_000) return bad(reply, '波特率无效');
    try {
      return await devices.openDeviceSerial(
        clientId(req, body),
        decodeId((req.params as { id: string }).id),
        Math.floor(baud),
        body.shared === true,
      );
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
  app.get('/api/devices/:id/serial/:leaseId', async (req, reply) => {
    const params = req.params as { id: string; leaseId: string };
    const query = req.query as { since?: string; waitMs?: string; filter?: string; maxBytes?: string };
    const since = Number(query.since);
    const waitMs = Math.max(0, Math.min(Number(query.waitMs) || 0, 20_000));
    const deadline = Date.now() + waitMs;
    try {
      for (;;) {
        const result = devices.readByLease(params.leaseId, Number.isFinite(since) ? since : 0, {
          ...(query.filter ? { filter: query.filter } : {}),
          ...(query.maxBytes && Number.isFinite(Number(query.maxBytes))
            ? { maxBytes: Number(query.maxBytes) }
            : {}),
        });
        if (result.data || !result.alive || Date.now() >= deadline) return result;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
  app.post('/api/devices/:id/serial/:leaseId/write', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能操作设备', 403);
    const body = readBody(req);
    const data = typeof body.data === 'string' ? body.data : '';
    if (!data) return bad(reply, '缺少 data');
    try {
      await devices.writeByLease((req.params as { leaseId: string }).leaseId, data);
      return { ok: true };
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });
  app.post('/api/devices/:id/serial/:leaseId/close', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能操作设备', 403);
    await devices.closeByLease((req.params as { leaseId: string }).leaseId);
    return { ok: true };
  });

  // ---------- 会话挂载与使用 ----------

  const sessionOf = (req: FastifyRequest): string | undefined => {
    const params = req.params as { id?: string };
    const sessionId = params.id ?? '';
    return host.getSession(sessionId) ? sessionId : undefined;
  };

  app.get('/api/sessions/:id/devices', async (req, reply) => {
    const sessionId = sessionOf(req);
    if (!sessionId) return bad(reply, '会话不存在', 404);
    return devices.sessionDevices(sessionId);
  });

  app.post('/api/sessions/:id/devices/mount', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能挂载设备', 403);
    const sessionId = sessionOf(req);
    if (!sessionId) return bad(reply, '会话不存在', 404);
    const body = readBody(req) as unknown as DeviceMountInput;
    if (!body.deviceId) return bad(reply, '缺少 deviceId');
    try {
      return await devices.mount(sessionId, body);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.delete('/api/sessions/:id/devices/:mountId', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能卸载设备', 403);
    const sessionId = sessionOf(req);
    if (!sessionId) return bad(reply, '会话不存在', 404);
    const mountId = (req.params as { mountId: string }).mountId;
    if (!devices.unmount(sessionId, mountId)) return bad(reply, '挂载不存在', 404);
    return { ok: true };
  });

  app.post('/api/sessions/:id/devices/:mountId/serial/open', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能操作设备', 403);
    const sessionId = sessionOf(req);
    if (!sessionId) return bad(reply, '会话不存在', 404);
    const body = readBody(req);
    const baud = Number(body.baud);
    if (!Number.isFinite(baud) || baud <= 0 || baud > 4_000_000) return bad(reply, '波特率无效');
    try {
      return await devices.openSessionSerial(
        sessionId,
        (req.params as { mountId: string }).mountId,
        Math.floor(baud),
        body.shared === true,
      );
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/sessions/:id/devices/:mountId/serial', async (req, reply) => {
    const sessionId = sessionOf(req);
    if (!sessionId) return bad(reply, '会话不存在', 404);
    const query = req.query as { since?: string; waitMs?: string; filter?: string; maxBytes?: string; windowMs?: string };
    const since = Number(query.since);
    const waitMs = Math.max(0, Math.min(Number(query.waitMs) || 0, 20_000));
    const deadline = Date.now() + waitMs;
    try {
      for (;;) {
        const result = await devices.readSessionSerial(
          sessionId,
          (req.params as { mountId: string }).mountId,
          Number.isFinite(since) ? since : 0,
          {
            ...(query.windowMs && Number.isFinite(Number(query.windowMs))
              ? { windowMs: Number(query.windowMs) }
              : {}),
            ...(query.filter ? { filter: query.filter } : {}),
            ...(query.maxBytes && Number.isFinite(Number(query.maxBytes))
              ? { maxBytes: Number(query.maxBytes) }
              : {}),
          },
        );
        if (result.data || !result.alive || Date.now() >= deadline) return result;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/sessions/:id/devices/:mountId/serial/write', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能操作设备', 403);
    const sessionId = sessionOf(req);
    if (!sessionId) return bad(reply, '会话不存在', 404);
    const body = readBody(req);
    const data = typeof body.data === 'string' ? body.data : '';
    if (!data) return bad(reply, '缺少 data');
    try {
      await devices.writeSessionSerial(sessionId, (req.params as { mountId: string }).mountId, data);
      return { ok: true };
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/sessions/:id/devices/:mountId/serial/close', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能操作设备', 403);
    const sessionId = sessionOf(req);
    if (!sessionId) return bad(reply, '会话不存在', 404);
    await devices.closeSessionSerial(sessionId, (req.params as { mountId: string }).mountId);
    return { ok: true };
  });

  app.post('/api/sessions/:id/devices/:mountId/logcat/start', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能操作设备', 403);
    const sessionId = sessionOf(req);
    if (!sessionId) return bad(reply, '会话不存在', 404);
    const body = readBody(req);
    try {
      return await devices.startSessionLogcat(
        sessionId,
        (req.params as { mountId: string }).mountId,
        typeof body.filter === 'string' ? body.filter : undefined,
      );
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/sessions/:id/devices/:mountId/logcat', async (req, reply) => {
    const sessionId = sessionOf(req);
    if (!sessionId) return bad(reply, '会话不存在', 404);
    const query = req.query as { streamId?: string; since?: string };
    if (!query.streamId) return bad(reply, '缺少 streamId');
    const since = Number(query.since);
    try {
      return devices.readSessionLogcat(
        sessionId,
        (req.params as { mountId: string }).mountId,
        query.streamId,
        Number.isFinite(since) ? since : 0,
      );
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/sessions/:id/devices/:mountId/logcat/stop', async (req, reply) => {
    if (!canOperate(req)) return bad(reply, '当前角色不能操作设备', 403);
    const sessionId = sessionOf(req);
    if (!sessionId) return bad(reply, '会话不存在', 404);
    const body = readBody(req);
    if (typeof body.streamId !== 'string') return bad(reply, '缺少 streamId');
    await devices.stopSessionLogcat(
      sessionId,
      (req.params as { mountId: string }).mountId,
      body.streamId,
    );
    return { ok: true };
  });
}
