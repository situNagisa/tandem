// 调试版 Host：启动时自动拉起本机工作站、登录测试账号、登记本机主机，并创建演示主机。
// 调试 flavor 下默认开启，TANDEM_DEBUG_ACCOUNT=0 关闭（模拟发布语义）。
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AccountLoginResult } from '@tandem/protocol';
import type { Host } from '../host.js';
import { readJson } from '../config.js';
import { IS_DEBUG_FLAVOR } from '../flavor.js';
import { embeddedDataDir, startEmbeddedWorkstation } from '../workstation/manager.js';
import { startDebugDemoHost, type DemoHostHandle } from './demoHost.js';
import { isLoopbackAddress } from './workstationService.js';

interface DebugWorkstationDeps {
  start: () => void;
}

interface CenterMeta {
  mode?: string;
  publicKey?: string;
  workspace?: { id?: string };
}

/**
 * 调试 flavor 的所有 Host（CLI、桌面 Electron 内置 Host、浏览器调试构建连接的 Host）默认启用；
 * 只有 TANDEM_DEBUG_ACCOUNT=0 关闭（回归/联调模拟发布语义）。
 */
export function debugAutoLoginEnabled(): boolean {
  if (!IS_DEBUG_FLAVOR) return false;
  return process.env.TANDEM_DEBUG_ACCOUNT !== '0';
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function localHostUrls(app: FastifyInstance): string[] {
  const address = app.server.address();
  const port = address && typeof address === 'object' ? address.port : 7878;
  const bound = address && typeof address === 'object' ? address.address : '127.0.0.1';
  const lan = bound === '0.0.0.0' || bound === '::' || bound === '::0';
  const urls = new Set<string>([`http://127.0.0.1:${port}`]);
  if (lan) {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        const family = String(entry.family);
        if ((family === 'IPv4' || family === '4') && !entry.internal) urls.add(`http://${entry.address}:${port}`);
      }
    }
  }
  return [...urls];
}

/** 登录调试账号（仅回环可用的免密接口）。 */
async function debugLogin(base: string): Promise<AccountLoginResult> {
  const res = await fetch(`${base}/api/debug/auto-login`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AccountLoginResult;
}

/** 在 createApp 阶段安装启动钩子；失败只告警，不影响正常使用。 */
export function installDebugWorkstationBootstrap(
  app: FastifyInstance,
  host: Host,
  workstation: DebugWorkstationDeps,
): void {
  if (!debugAutoLoginEnabled()) return;
  const mode = host.accounts.mode();
  if (mode === 'center') return;

  // 浏览器直接打开 Host 首页（终端里打印的地址去掉 ?token=）时自动补上调试凭据，
  // 否则前端拿不到本机凭据，既连不上内嵌工作站又会反复请求 401。
  // 只在「本机可达」时补：Host 只监听回环，或请求来自回环（桌面/本机浏览器）。
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET') return;
    const rawUrl = req.raw.url ?? '';
    const pathname = rawUrl.split('?')[0] ?? '';
    if (pathname !== '/' && pathname !== '/index.html') return;
    if (new URL(rawUrl, 'http://localhost').searchParams.has('token')) return;
    const accept = req.headers.accept ?? '';
    if (!accept.includes('text/html')) return;
    const address = app.server.address();
    const bound = address && typeof address === 'object' ? address.address : '';
    const boundLoopback = bound === '127.0.0.1' || bound === '::1' || bound === '0:0:0:0:0:0:0:1';
    if (!boundLoopback && !isLoopbackAddress(req.socket.remoteAddress)) return;
    return reply.redirect(`/?token=${encodeURIComponent(host.config.token)}`);
  });

  // 演示主机在后台启动，不阻塞 Host 监听；关闭 Host 时一并释放。
  let demoHost: DemoHostHandle | undefined;
  let closing = false;
  app.addHook('onClose', async () => {
    closing = true;
    await demoHost?.close();
    demoHost = undefined;
  });
  const launchDemoHost = (base: string, accessToken: string | undefined): void => {
    void startDebugDemoHost(host.home, {
      workstationUrl: base,
      ...(accessToken ? { accessToken } : {}),
    })
      .then(async (handle) => {
        if (closing) return handle.close();
        demoHost = handle;
        console.log('[debug] 演示主机已就绪，已登记到调试账号');
        return undefined;
      })
      .catch((err: unknown) => console.warn('[debug] 演示主机启动失败:', (err as Error).message));
  };

  if (mode === 'member') {
    // 已加入本机内嵌工作站：重启后把工作站重新拉起来，客户端才能自动登录。
    const join = host.accounts.workstationJoin();
    if (!join || !isLoopbackUrl(join.url)) return;
    const meta = readJson<CenterMeta>(path.join(embeddedDataDir(host.home), 'accounts.json'));
    if (meta?.mode !== 'center' || meta.workspace?.id !== join.workspace.id || meta.publicKey !== join.publicKey) return;
    const preferredPort = Number(new URL(join.url).port || 8481);
    app.addHook('onListen', async () => {
      try {
        const info = await startEmbeddedWorkstation(host.home, '127.0.0.1', host.version, preferredPort);
        workstation.start();
        void host.enableWorkstationProfiles();
        const base = `http://127.0.0.1:${info.port}`;
        // 演示主机通常已登记，只需重建并恢复隧道；令牌只在它尚未登记时用到。
        const login = await debugLogin(base).catch(() => undefined);
        launchDemoHost(base, login?.accessToken);
      } catch (err) {
        console.warn('[debug] 本机工作站重新启动失败:', (err as Error).message);
      }
    });
    return;
  }

  app.addHook('onListen', async () => {
    try {
      const info = await startEmbeddedWorkstation(host.home, '127.0.0.1', host.version);
      const base = `http://127.0.0.1:${info.port}`;
      const login = await debugLogin(base);
      await host.accounts.registerAsHost(
        base,
        {
          id: host.config.hostId,
          name: os.hostname(),
          urls: localHostUrls(app),
          ...(host.version ? { version: host.version } : {}),
          platform: process.platform,
        },
        { accessToken: login.accessToken },
      );
      workstation.start();
      void host.enableWorkstationProfiles();
      launchDemoHost(base, login.accessToken);
      console.log('[debug] 已登录调试账号，本机主机已自动添加');
    } catch (err) {
      console.warn('[debug] 自动登录调试账号失败:', (err as Error).message);
    }
  });
}
