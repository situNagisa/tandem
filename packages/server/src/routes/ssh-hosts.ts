// 远程主机（SSH 一键接入）：本机 Host 作为控制端，部署并维护隧道。
// 仅所有者可用（成员请求在全局守卫中默认 403）。
import type { FastifyInstance } from 'fastify';
import type { SshAuthInput, SshHostInput, SshTarget } from '@tandem/protocol';
import type { RouteDeps } from './common.js';
import { bad, statusOf, str } from './common.js';
import { SshError } from '../ssh/exec.js';

function targetOf(body: unknown): SshTarget {
  const raw = (body ?? {}) as { target?: Partial<SshTarget>; user?: unknown; host?: unknown; port?: unknown };
  const target = raw.target ?? { user: raw.user, host: raw.host, port: raw.port };
  return {
    user: str(target.user),
    host: str(target.host),
    ...(target.port !== undefined && target.port !== '' ? { port: Number(target.port) } : {}),
  };
}

function authOf(raw: unknown): SshAuthInput {
  const body = (raw ?? {}) as Partial<SshAuthInput>;
  const kind = body.kind;
  if (kind !== 'agent' && kind !== 'key' && kind !== 'password') {
    throw new SshError('认证方式无效');
  }
  return {
    kind,
    ...(typeof body.keyPath === 'string' ? { keyPath: body.keyPath.trim() } : {}),
    ...(typeof body.password === 'string' ? { password: body.password } : {}),
  };
}

export function registerSshHostRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { sshHosts } = deps;
  if (!sshHosts) return;

  app.get('/api/ssh-hosts', async () => sshHosts.list());

  app.post('/api/ssh-hosts/scan-key', async (req, reply) => {
    try {
      return await sshHosts.scanKey({ target: targetOf(req.body) });
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.post('/api/ssh-hosts/probe', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { fingerprint?: unknown; auth?: unknown };
      return await sshHosts.probe({
        target: targetOf(body),
        auth: authOf(body.auth),
        fingerprint: str(body.fingerprint),
      });
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.post('/api/ssh-hosts', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const input: SshHostInput = {
        target: targetOf(body),
        auth: authOf(body.auth),
        fingerprint: str(body.fingerprint),
        ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
        ...(body.remotePort !== undefined ? { remotePort: Number(body.remotePort) } : {}),
        ...(body.listenLan === true ? { listenLan: true } : {}),
        ...(typeof body.nodePath === 'string' && body.nodePath.trim() ? { nodePath: body.nodePath.trim() } : {}),
        ...(body.uploadNode === true ? { uploadNode: true } : {}),
        ...(body.service === 'systemd' || body.service === 'nohup' ? { service: body.service } : {}),
      };
      return sshHosts.deploy(input);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.get('/api/ssh-hosts/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = sshHosts.job(id);
    if (!job) return bad(reply, '任务不存在', 404);
    return job;
  });

  app.post('/api/ssh-hosts/:id/restart', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      return sshHosts.restart(id);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.post('/api/ssh-hosts/:id/upgrade', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      return sshHosts.upgrade(id);
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.get('/api/ssh-hosts/:id/logs', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const query = (req.query ?? {}) as { lines?: unknown };
      const lines = Number(query.lines ?? 200);
      return { lines: await sshHosts.logs(id, Number.isFinite(lines) ? lines : 200) };
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.delete('/api/ssh-hosts/:id', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const query = (req.query ?? {}) as { keepData?: unknown };
      return sshHosts.uninstall(id, query.keepData !== '0' && query.keepData !== 'false');
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.post('/api/ssh-hosts/:id/password', async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { password?: unknown };
      await sshHosts.setPassword(id, typeof body.password === 'string' ? body.password : '');
      return { ok: true };
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });
}
