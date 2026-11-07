// 配置迁移（导出 / 导入）。
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { ConfigBundle, ConfigExportInput, ConfigImportInput } from '@tandem/protocol';
import { exportBundle, importBundle, type MemoryBundleEntry } from '../migrate.js';
import { bodyOfMemory } from '../memory.js';
import { bad, statusOf, type RouteDeps } from './common.js';

export function registerConfigRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.post('/api/config/export', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<ConfigExportInput>;
    try {
      const { global, projects } = host.memory.list();
      const memories: MemoryBundleEntry[] = [];
      const push = (file: typeof global) => {
        const text = bodyOfMemory(file.text).trim();
        if (!text) return;
        memories.push({
          scope: file.scope,
          ...(file.project ? { project: file.project } : {}),
          name: file.name,
          text,
        });
      };
      push(global);
      for (const file of projects) push(file);
      return exportBundle(
        host.profiles.list(),
        os.hostname(),
        {
          passphrase: typeof body.passphrase === 'string' ? body.passphrase : '',
          ...(body.clientSettings !== undefined ? { clientSettings: body.clientSettings } : {}),
        },
        memories,
      );
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });

  app.post('/api/config/import', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<ConfigImportInput>;
    try {
      return importBundle(
        host.profiles,
        {
          passphrase: typeof body.passphrase === 'string' ? body.passphrase : '',
          bundle: body.bundle as ConfigBundle,
          mode: body.mode as ConfigImportInput['mode'],
        },
        host.memory,
      );
    } catch (err) {
      return bad(reply, (err as Error).message, statusOf(err));
    }
  });
}
