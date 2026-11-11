// 运行工作站的这台机器：工作站进程内的本地主机上下文（LocalHostEnv），与执行器主机同等对待。
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceHostInfo } from '@tandem/protocol';
import type { AccountsStore } from '../accounts/store.js';
import { loadHostConfig } from '../config.js';
import type { WorkstationModelBridge } from './bridge.js';
import { openHostContext, type HostContext } from './context.js';

export const LOCAL_HOST_SUBDIR = 'local-host';

/** 本机主机上下文：数据在 <工作站数据目录>/local-host/，首次由账号显式添加（调试版自动添加）。 */
export class LocalHost {
  private contextValue?: HostContext;
  readonly hostId: string;

  constructor(
    private readonly workstationHome: string,
    private readonly modelBridge: WorkstationModelBridge,
    private readonly version?: string,
  ) {
    const localHome = path.join(workstationHome, LOCAL_HOST_SUBDIR);
    this.hostId = loadHostConfig(localHome).hostId;
  }

  get home(): string {
    return path.join(this.workstationHome, LOCAL_HOST_SUBDIR);
  }

  get context(): HostContext | undefined {
    return this.contextValue;
  }

  async start(selfUrl: string): Promise<HostContext> {
    if (this.contextValue) return this.contextValue;
    this.contextValue = await openHostContext({
      home: this.home,
      hostId: this.hostId,
      selfUrl,
      modelBridge: this.modelBridge,
    });
    return this.contextValue;
  }

  private center(store: AccountsStore, ownerAccountId: string | undefined) {
    const workspace = store.status().workspace;
    const centerPublicKey = store.workstationPublicKey();
    const syncToken = store.syncSecret();
    if (!workspace || !centerPublicKey) throw Object.assign(new Error('工作站尚未初始化'), { statusCode: 400 });
    return {
      workspace,
      centerPublicKey,
      syncToken: syncToken ?? '',
      snapshotVersion: store.snapshotVersion(),
      ...(ownerAccountId ? { ownerAccountId } : {}),
      hostName: os.hostname(),
    };
  }

  /** 工作站启动时调用：已添加过就恢复成员身份并同步账号模型账号。 */
  async adopt(store: AccountsStore, selfUrl: string): Promise<void> {
    const record = store.hostRecord(this.hostId);
    if (!record || !this.contextValue) return;
    this.contextValue.host.accounts.becomeMember({
      url: selfUrl,
      ...this.center(store, record.ownerId),
    });
    store.markHostOnline(this.hostId, true);
    await this.contextValue.host.enableWorkstationProfiles();
  }

  /** 把本机登记到某个账号；已属于其他账号时拒绝。 */
  async register(store: AccountsStore, accountId: string, selfUrl: string): Promise<WorkspaceHostInfo> {
    const context = this.contextValue;
    if (!context) throw Object.assign(new Error('本机主机上下文未启动'), { statusCode: 503 });
    const existing = store.hostRecord(this.hostId);
    if (existing) {
      if (existing.ownerId && existing.ownerId !== accountId) {
        throw Object.assign(new Error('这台机器已属于其他账号'), { statusCode: 409 });
      }
      await this.adopt(store, selfUrl);
      return store.hostRecord(this.hostId)!;
    }
    context.host.accounts.becomeMember({
      url: selfUrl,
      ...this.center(store, accountId),
    });
    const identity = context.host.accounts.hostIdentity();
    if (!identity) throw Object.assign(new Error('本机主机身份不可用'), { statusCode: 500 });
    const info = store.registerHost(accountId, {
      id: this.hostId,
      name: os.hostname(),
      urls: [selfUrl],
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      platform: process.platform,
      ...(this.version ? { version: this.version } : {}),
    });
    store.markHostOnline(this.hostId, true);
    await context.host.enableWorkstationProfiles();
    return info;
  }

  async close(): Promise<void> {
    const context = this.contextValue;
    this.contextValue = undefined;
    await context?.close();
  }
}
