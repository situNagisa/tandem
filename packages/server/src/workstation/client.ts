// 主机上下文 → 工作站账号级模型账号：全部在同一进程内直接调用（不签名、不转发）。
import type {
  ListModelsInput,
  Profile,
  WorkspaceModelProxyEvent,
  WorkspaceProfileImportResult,
  WorkspaceProfilesSnapshot,
} from '@tandem/protocol';
import type { ListModelsResult } from '../providers/index.js';
import type { StoredProfile } from '../types.js';
import type { ProxyBody, WorkstationModelBridge } from './bridge.js';

export interface WorkstationProfileClientOptions {
  hostId: string;
  hostName: string;
  bridge: WorkstationModelBridge;
}

/** 主机上下文使用账号级模型账号的入口；Key 只存在于工作站。 */
export class WorkstationProfileClient {
  constructor(private readonly options: WorkstationProfileClientOptions) {}

  async snapshot(accountId: string): Promise<WorkspaceProfilesSnapshot> {
    return this.options.bridge.snapshot(accountId);
  }

  async importProfiles(
    accountId: string,
    profiles: StoredProfile[],
    hostName = this.options.hostName,
  ): Promise<WorkspaceProfileImportResult> {
    return this.options.bridge.importProfiles(accountId, profiles, hostName);
  }

  /** 只带 profileId/分组/模型与消息，不带 Key。 */
  async runProxy(
    accountId: string,
    body: ProxyBody,
    emit: (event: WorkspaceModelProxyEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    await this.options.bridge.runProxy(accountId, this.options.hostId, body, emit, signal);
  }

  async listModels(accountId: string, input: ListModelsInput): Promise<ListModelsResult> {
    return this.options.bridge.listModels(accountId, input);
  }

  async testProfile(
    accountId: string,
    profileId: string,
    groupId?: string,
    keyId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.options.bridge.testProfile(accountId, profileId, groupId, keyId);
  }

  publicProfiles(accountId: string): Profile[] {
    return this.options.bridge.publicProfiles(accountId);
  }
}
