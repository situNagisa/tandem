// 配对（手机扫码连接）。
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './common.js';

export function registerPairRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  const pairLocal = () => {
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
  };
  app.get('/api/pair', async () => pairLocal());
}
