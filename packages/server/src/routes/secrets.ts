// 项目 Secrets：只暴露元信息；值只在 Host 内存中用于注入与打码。
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import type { SecretInput, SecretScope, SecretsSettings } from '@tandem/protocol';
import { resolveSecretProject } from '../secrets.js';
import { expandHome } from '../util/path.js';
import { bad, str, type RouteDeps } from './common.js';

const SCOPES: SecretScope[] = ['bash', 'mcp', 'hooks'];

function knownProjects(deps: RouteDeps, cwd?: string): string[] {
  const set = new Set<string>();
  if (cwd) set.add(resolveSecretProject(cwd));
  for (const rec of deps.host.listSessions()) {
    set.add(rec.env?.repoRoot ? path.resolve(rec.env.repoRoot) : resolveSecretProject(rec.cwd));
  }
  return [...set];
}

function parseInput(deps: RouteDeps, body: Record<string, unknown>): SecretInput {
  const name = str(body.name);
  if (!name) throw Object.assign(new Error('名称不能为空'), { statusCode: 400 });
  const value = typeof body.value === 'string' ? body.value : undefined;
  const description = typeof body.description === 'string' ? body.description : undefined;
  const rawScopes = Array.isArray(body.scopes) ? body.scopes : [];
  const scopes = SCOPES.filter((scope) => rawScopes.includes(scope));
  if (scopes.length === 0) {
    throw Object.assign(new Error('请至少选择一个作用范围（bash / mcp / hooks）'), { statusCode: 400 });
  }
  const projectRaw = str(body.project);
  return {
    name,
    ...(value !== undefined ? { value } : {}),
    ...(description !== undefined ? { description } : {}),
    scopes,
    ...(projectRaw ? { project: expandHome(projectRaw) } : {}),
  };
}

export function registerSecretRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/secrets', async (req) => {
    const query = req.query as { cwd?: string };
    const cwd = str(query.cwd) ? resolveSecretProject(expandHome(str(query.cwd))) : undefined;
    return host.secrets.overview(knownProjects(deps, cwd));
  });

  app.post('/api/secrets', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      return host.secrets.create(parseInput(deps, body));
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      return bad(reply, (err as Error).message, status);
    }
  });

  app.patch('/api/secrets/:id', async (req, reply) => {
    const id = str((req.params as { id?: string }).id);
    if (!id) return bad(reply, '缺少 id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const input = parseInput(deps, body);
      return host.secrets.update(id, input);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      return bad(reply, (err as Error).message, status);
    }
  });

  app.delete('/api/secrets/:id', async (req, reply) => {
    const id = str((req.params as { id?: string }).id);
    if (!id) return bad(reply, '缺少 id');
    if (!host.secrets.remove(id)) return bad(reply, 'secret 不存在', 404);
    return { ok: true };
  });

  app.put('/api/secrets/settings', async (req) => {
    const body = (req.body ?? {}) as Partial<SecretsSettings>;
    return host.secrets.updateSettings(body);
  });
}
