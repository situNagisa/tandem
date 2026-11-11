// 工作站进程内的主机上下文：普通 Host + Fastify 应用，只监听回环随机端口，由工作站经 /h/<hostId> 转发。
// 本机（LocalHostEnv）与执行器主机（RemoteHostEnv）用同一份 Host 代码，只是环境与数据目录不同。
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Host } from '../host.js';
import { createApp } from '../server.js';
import type { WorkstationModelBridge } from './bridge.js';

export interface HostContext {
  hostId: string;
  host: Host;
  app: FastifyInstance;
  port: number;
  close: () => Promise<void>;
}

export interface OpenHostContextOptions {
  /** 该主机上下文的数据目录。 */
  home: string;
  hostId: string;
  /** 工作站自身地址（主机上下文向它登记/同步）。 */
  selfUrl: string;
  /** 执行器主机：只经 env 访问远端，不启动本机扫描。 */
  remote?: boolean;
  modelBridge: WorkstationModelBridge;
}

export async function openHostContext(options: OpenHostContextOptions): Promise<HostContext> {
  const { Host } = await import('../host.js');
  fs.mkdirSync(options.home, { recursive: true });
  const configFile = path.join(options.home, 'config.json');
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, JSON.stringify({ hostId: options.hostId }), { mode: 0o600 });
  }
  const host = new Host(undefined, options.home, {
    ...(options.remote ? { remote: true } : {}),
    modelBridge: options.modelBridge,
  });
  host.accounts.retargetWorkstation(options.selfUrl);
  const app = await createApp(host);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  // 与独立 Host 启动一致：续跑中断的会话（或按设置暂停），并恢复待审批请求。
  void host
    .recoverAfterRestart()
    .catch((err: unknown) => {
      console.warn(`[tandem] 重启恢复失败:`, (err as Error).message);
    })
    .finally(() => host.boards.start());
  const close = async (): Promise<void> => {
    await app.close().catch(() => undefined);
    (host.demo as { dispose?: () => void }).dispose?.();
    host.store.flush();
    await host.shutdown().catch(() => undefined);
  };
  return { hostId: options.hostId, host, app, port, close };
}
