// 调试版工作站：自动把本机与演示主机登记到调试账号（都在工作站进程内，不再起独立 Host 服务）。
// 只在调试版加载，发布构建会整体移除。
import path from 'node:path';
import type { AccountsStore } from '../accounts/store.js';
import { loadHostConfig } from '../config.js';
import type { WorkstationModelBridge } from '../workstation/bridge.js';
import { openHostContext, type HostContext } from '../workstation/context.js';
import type { LocalHost } from '../workstation/local.js';

export const DEMO_HOST_SUBDIR = 'demo-host';
export const DEMO_HOST_NAME = '演示主机';

export interface DebugHostsOptions {
  store: AccountsStore;
  selfUrl: string;
  local: LocalHost;
  /** 工作站额外的主机上下文（演示主机）。 */
  extraContexts: Map<string, HostContext>;
  modelBridge: WorkstationModelBridge;
  /** 工作站数据目录。 */
  home: string;
  version?: string;
}

/** 调试账号：首次启动自动添加本机与演示主机，启动演示工作区。 */
export async function ensureDebugHosts(options: DebugHostsOptions): Promise<void> {
  const account = options.store.listAccountSummaries('debug').find((item) => item.username === 'debug' && item.debug);
  if (!account) return;
  if (options.local.context && !options.store.hostRecord(options.local.hostId)) {
    await options.local.register(options.store, account.id, options.selfUrl);
  }
  await options.local.adopt(options.store, options.selfUrl).catch(() => undefined);

  const home = path.join(options.home, DEMO_HOST_SUBDIR);
  const hostId = loadHostConfig(home).hostId;
  const existing = options.extraContexts.get(hostId);
  const ctx =
    existing ??
    (await openHostContext({
      home,
      hostId,
      selfUrl: options.selfUrl,
      modelBridge: options.modelBridge,
    }));
  options.extraContexts.set(hostId, ctx);
  try {
    await ctx.host.demo.create();
  } catch (err) {
    // 演示工作区建不出来不影响主机登记：客户端仍能看到这台主机并手动重试。
    console.warn('[debug] 演示工作区创建失败:', (err as Error).message);
  }
  const workspace = options.store.status().workspace;
  const centerPublicKey = options.store.workstationPublicKey();
  if (!workspace || !centerPublicKey) return;
  ctx.host.accounts.becomeMember({
    url: options.selfUrl,
    workspace,
    centerPublicKey,
    syncToken: options.store.syncSecret() ?? '',
    snapshotVersion: options.store.snapshotVersion(),
    ownerAccountId: account.id,
    hostName: DEMO_HOST_NAME,
  });
  const identity = ctx.host.accounts.hostIdentity();
  if (!identity) return;
  if (!options.store.hostRecord(hostId)) {
    options.store.registerHost(account.id, {
      id: hostId,
      name: DEMO_HOST_NAME,
      urls: [options.selfUrl],
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      platform: process.platform,
      demo: true,
      ...(options.version ? { version: options.version } : {}),
    });
  }
  options.store.markHostOnline(hostId, true);
  await ctx.host.enableWorkstationProfiles().catch(() => undefined);
}
