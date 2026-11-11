// 工作站进程内的模型账号入口：主机上下文的 agent 直接调用，不再经签名 HTTP 代理。
import type {
  ListModelsInput,
  Profile,
  WorkspaceModelProxyEvent,
  WorkspaceModelProxyInput,
  WorkspaceProfileImportResult,
  WorkspaceProfilesSnapshot,
} from '@tandem/protocol';
import type { ListModelsResult } from '../providers/index.js';
import type { StoredProfile } from '../types.js';

export type ProxyBody = Omit<WorkspaceModelProxyInput, 'accountId'>;

export interface WorkstationModelBridge {
  snapshot(accountId: string): Promise<WorkspaceProfilesSnapshot>;
  importProfiles(accountId: string, profiles: StoredProfile[], hostName: string): Promise<WorkspaceProfileImportResult>;
  /** hostId 用于按主机记账。 */
  runProxy(
    accountId: string,
    hostId: string,
    body: ProxyBody,
    emit: (event: WorkspaceModelProxyEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  listModels(accountId: string, input: ListModelsInput): Promise<ListModelsResult>;
  testProfile(accountId: string, profileId: string, groupId?: string, keyId?: string): Promise<{ ok: boolean; error?: string }>;
  publicProfiles(accountId: string): Profile[];
}
