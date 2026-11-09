// 调试版演示主机：在 <host.home>/demo-host 起第二个进程内 Host，创建演示工作区，
// 并以调试账号身份登记到本机工作站（demo:true）。只在调试版加载，发布构建会整体移除。
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Host } from '../host.js';
import { loadHostConfig } from '../config.js';
import { createApp } from '../server.js';

export const DEMO_HOST_SUBDIR = 'demo-host';
export const DEMO_HOST_NAME = '演示主机';

interface TunnelDeps {
  start: () => void;
  stop: () => void;
}

export interface DemoHostOptions {
  /** 本机内嵌工作站地址，演示主机向它登记并建立出站隧道。 */
  workstationUrl: string;
  /** 调试账号访问令牌；演示主机已登记时不需要（不再重复登记）。 */
  accessToken?: string;
}

export interface DemoHostHandle {
  /** 关闭演示主机：应用、隧道、演示静态服务与 Host 状态一起释放。 */
  close: () => Promise<void>;
}

/**
 * 启动演示主机。首次登记后该目录里留下 member 状态，重启时只重建进程并恢复隧道。
 * 失败抛错，由调用方决定是否只告警。
 */
export async function startDebugDemoHost(home: string, options: DemoHostOptions): Promise<DemoHostHandle> {
  const dir = path.join(home, DEMO_HOST_SUBDIR);
  const config = loadHostConfig(dir);
  const demoHost = new Host(config, dir);
  let tunnel: TunnelDeps | undefined;
  // demoHost 标记：这个 Host 上不再安装调试工作站引导，避免递归再起一个演示主机。
  // onWorkstationDeps 把隧道句柄交出来：登记完成后才能连上工作站。
  const app: FastifyInstance = await createApp(demoHost, {
    demoHost: true,
    onWorkstationDeps: (deps) => {
      tunnel = deps;
    },
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await app.close().catch(() => undefined);
    (demoHost.demo as { dispose?: () => void }).dispose?.();
    demoHost.store.flush();
    await demoHost.shutdown().catch(() => undefined);
  };

  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    try {
      await demoHost.demo.create();
    } catch (err) {
      // 演示工作区建不出来不影响主机登记：客户端仍能看到这台主机并手动重试。
      console.warn('[debug] 演示工作区创建失败:', (err as Error).message);
    }
    if (demoHost.accounts.mode() !== 'member') {
      if (!options.accessToken) throw new Error('缺少调试账号令牌，无法登记演示主机');
      await demoHost.accounts.registerAsHost(
        options.workstationUrl,
        {
          id: config.hostId,
          name: DEMO_HOST_NAME,
          urls: [base],
          ...(demoHost.version ? { version: demoHost.version } : {}),
          platform: process.platform,
          demo: true,
        },
        { accessToken: options.accessToken },
      );
    }
    tunnel?.start();
    return { close };
  } catch (err) {
    await close();
    throw err;
  }
}
