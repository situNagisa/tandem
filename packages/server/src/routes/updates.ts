// 桌面端更新文件托管：只在 Host 设置了 updateShareDir 时把该目录公开到 /updates/。
// 不需要 token（安装包与 latest.yml 本身不含敏感信息），但只允许目录内文件。
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './common.js';
import { expandHome } from '../util/path.js';

const TYPES: Record<string, string> = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.msi': 'application/octet-stream',
  '.zip': 'application/zip',
  '.dmg': 'application/octet-stream',
  '.appimage': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.apk': 'application/vnd.android.package-archive',
  '.aab': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
};

export function registerUpdateRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/updates/*',
    handler: async (req, reply) => {
      const dir = deps.host.config.updateShareDir?.trim();
      if (!dir) return reply.code(404).send({ error: '未启用更新文件托管' });
      const root = path.resolve(expandHome(dir));
      const rel = decodeURIComponent(String((req.params as { '*': string })['*'] ?? ''));
      const file = path.resolve(root, rel);
      if (file !== root && !file.startsWith(root + path.sep)) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      let stat;
      try {
        stat = statSync(file);
      } catch {
        return reply.code(404).send({ error: 'Not Found' });
      }
      if (!stat.isFile()) return reply.code(404).send({ error: 'Not Found' });
      const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      reply.header('Content-Type', type).header('Accept-Ranges', 'bytes').header('Cache-Control', 'no-cache');
      if (req.method === 'HEAD') {
        return reply.header('Content-Length', stat.size).send();
      }
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
      if (range) {
        const suffix = !range[1] && range[2] ? Number(range[2]) : 0;
        const start = suffix ? Math.max(0, stat.size - suffix) : Number(range[1] || 0);
        const end = range[2] && !suffix ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        if (!Number.isFinite(start) || start > end || start >= stat.size) {
          return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
        }
        return reply
          .code(206)
          .header('Content-Length', end - start + 1)
          .header('Content-Range', `bytes ${start}-${end}/${stat.size}`)
          .send(createReadStream(file, { start, end }));
      }
      return reply.header('Content-Length', stat.size).send(createReadStream(file));
    },
  });
}
