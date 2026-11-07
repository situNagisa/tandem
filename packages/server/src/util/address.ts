// 生成同事可访问的局域网地址；Host 只监听回环时给出提示。
import os from 'node:os';
import type { FastifyInstance } from 'fastify';

export function publicBaseUrl(app: FastifyInstance): { url: string; warning?: string } {
  const address = app.server.address();
  const port = address && typeof address === 'object' && address.port ? address.port : 7878;
  const bound = address && typeof address === 'object' ? address.address : '127.0.0.1';
  const loopback = bound === '127.0.0.1' || bound === '::1' || bound === 'localhost';
  const any = bound === '0.0.0.0' || bound === '::' || bound === '::0';
  const withHost = (host: string) => {
    const formatted = host.includes(':') ? `[${host}]` : host;
    return `http://${formatted}:${port}`;
  };
  if (loopback) {
    return {
      url: withHost('127.0.0.1'),
      warning: 'Host 只监听 127.0.0.1，这个链接只有本机能打开。让 Host 用 --host 0.0.0.0 启动后，同事才能通过局域网访问。',
    };
  }
  if (!any) return { url: withHost(bound) };
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = String(entry.family);
      if ((family === 'IPv4' || family === '4') && !entry.internal) {
        return { url: withHost(entry.address) };
      }
    }
  }
  return {
    url: withHost('127.0.0.1'),
    warning: '没有检测到局域网 IPv4 地址，同事可能无法打开该链接。',
  };
}

export function publicUrl(app: FastifyInstance, pathSuffix: string): { url: string; warning?: string } {
  const base = publicBaseUrl(app);
  const suffix = pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`;
  return { url: `${base.url}${suffix}`, ...(base.warning ? { warning: base.warning } : {}) };
}
