// 调试版桌面：Host 启动时自动拉起本机工作站、登录测试账号并登记本机主机。
// 只在调试版、且在桌面进程（或显式设置 TANDEM_DEBUG_ACCOUNT=1 的联调）中启用。
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AccountLoginResult } from '@tandem/protocol';
import type { Host } from '../host.js';
import { readJson } from '../config.js';
import { embeddedDataDir, startEmbeddedWorkstation } from '../workstation/manager.js';

interface DebugWorkstationDeps {
  start: () => void;
}

interface CenterMeta {
  mode?: string;
  publicKey?: string;
  workspace?: { id?: string };
}

function enabled(): boolean {
  return !!process.versions.electron || process.env.TANDEM_DEBUG_ACCOUNT === '1';
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

/** 在 createApp 阶段安装启动钩子；失败只告警，不影响正常使用。 */
export function installDebugWorkstationBootstrap(
  app: FastifyInstance,
  host: Host,
  workstation: DebugWorkstationDeps,
): void {
  if (!enabled()) return;
  const mode = host.accounts.mode();
  if (mode === 'center') return;

  if (mode === 'member') {
    // 已加入本机内嵌工作站：重启后把工作站重新拉起来，客户端才能自动登录。
    const join = host.accounts.workstationJoin();
    if (!join || !isLoopbackUrl(join.url)) return;
    const meta = readJson<CenterMeta>(path.join(embeddedDataDir(host.home), 'accounts.json'));
    if (meta?.mode !== 'center' || meta.workspace?.id !== join.workspace.id || meta.publicKey !== join.publicKey) return;
    const preferredPort = Number(new URL(join.url).port || 8481);
    app.addHook('onListen', async () => {
      try {
        await startEmbeddedWorkstation(host.home, '127.0.0.1', host.version, preferredPort);
        workstation.start();
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
      const res = await fetch(`${base}/api/debug/auto-login`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const login = (await res.json()) as AccountLoginResult;
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
      console.log('[debug] 已登录调试账号，本机主机已自动添加');
    } catch (err) {
      console.warn('[debug] 自动登录调试账号失败:', (err as Error).message);
    }
  });
}
