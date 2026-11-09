// 主机 → 工作站：账号级模型账号同步、旧数据迁移、模型代理与模型列表/测试。
// 远程工作站用主机长期私钥签名；个人模式（内嵌工作站）直接进程内调用，不经网络。
import type {
  ListModelsInput,
  Profile,
  WorkspaceModelProxyEvent,
  WorkspaceModelProxyInput,
  WorkspaceProfileImportItem,
  WorkspaceProfileImportResult,
  WorkspaceProfilesSnapshot,
} from '@tandem/protocol';
import type { ListModelsResult } from '../providers/index.js';
import type { StoredProfile } from '../types.js';
import { embeddedWorkstation } from './manager.js';
import { signHostRequest } from './hostAuth.js';

export interface WorkstationProfileClientOptions {
  home: string;
  hostId: string;
  hostName: string;
  baseUrl: string;
  hostKey: string;
}

export type ProxyBody = Omit<WorkspaceModelProxyInput, 'accountId'>;

function legacyToImportItem(profile: StoredProfile): WorkspaceProfileImportItem {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
    models: [...profile.models],
    defaultModel: profile.defaultModel,
    ...(profile.multiplier !== undefined ? { multiplier: profile.multiplier } : {}),
    ...(profile.price ? { price: { ...profile.price } } : {}),
    ...(profile.modelCapabilities ? { modelCapabilities: structuredClone(profile.modelCapabilities) } : {}),
    createdAt: profile.createdAt,
    ...(profile.groups?.length
      ? {
          groups: profile.groups.map((group) => ({
            id: group.id,
            name: group.name,
            ...(group.kind ? { kind: group.kind } : {}),
            ...(group.apiKey ? { apiKey: group.apiKey } : {}),
            ...(group.keys?.length
              ? {
                  apiKeys: group.keys.map((key) => ({
                    id: key.id,
                    ...(key.label ? { label: key.label } : {}),
                    ...(key.apiKey ? { apiKey: key.apiKey } : {}),
                    ...(key.disabled ? { disabled: true } : {}),
                  })),
                }
              : {}),
            ...(group.keyStrategy ? { keyStrategy: group.keyStrategy } : {}),
            ...(group.baseUrl ? { baseUrl: group.baseUrl } : {}),
            models: [...group.models],
            defaultModel: group.defaultModel,
            ...(group.multiplier !== undefined ? { multiplier: group.multiplier } : {}),
            ...(group.modelCapabilities ? { modelCapabilities: structuredClone(group.modelCapabilities) } : {}),
            ...(group.fallbackGroupIds?.length ? { fallbackGroupIds: [...group.fallbackGroupIds] } : {}),
          })),
        }
      : {}),
  };
}

export class WorkstationProfileClient {
  constructor(private readonly options: WorkstationProfileClientOptions) {}

  private get embedded() {
    return embeddedWorkstation(this.options.home);
  }

  private get base(): string {
    return this.options.baseUrl.trim().replace(/\/+$/, '');
  }

  private async signedPost<T>(
    path: string,
    accountId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const text = JSON.stringify(body);
    const headers = signHostRequest(this.options.hostKey, {
      hostId: this.options.hostId,
      accountId,
      method: 'POST',
      path,
      body: Buffer.from(text),
    });
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: text,
      ...(signal ? { signal } : {}),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`工作站返回 ${res.status}：${raw.slice(0, 300)}`);
    return (raw ? JSON.parse(raw) : undefined) as T;
  }

  async snapshot(accountId: string): Promise<WorkspaceProfilesSnapshot> {
    const embedded = this.embedded;
    if (embedded) {
      const store = embedded.profiles.forAccount(accountId);
      return {
        accountId,
        profiles: await embedded.balanceService.attach(
          accountId,
          store.list(),
          embedded.profiles.publicList(accountId),
        ),
      };
    }
    return this.signedPost<WorkspaceProfilesSnapshot>(
      '/api/workstation/host/profiles/snapshot',
      accountId,
      { accountId },
    );
  }

  async importProfiles(
    accountId: string,
    profiles: StoredProfile[],
    hostName = this.options.hostName,
  ): Promise<WorkspaceProfileImportResult> {
    const items = profiles.map(legacyToImportItem);
    const embedded = this.embedded;
    if (embedded) {
      const result = embedded.profiles.importStored(accountId, profiles.map((item) => ({ ...item })));
      return { ...result, profiles: embedded.profiles.publicList(accountId) };
    }
    return this.signedPost<WorkspaceProfileImportResult>(
      '/api/workstation/host/profiles/import',
      accountId,
      { accountId, hostName, profiles: items },
    );
  }

  /** 主机侧流式请求：只带 profileId/分组/模型与消息，不带 Key。 */
  async runProxy(
    accountId: string,
    body: ProxyBody,
    emit: (event: WorkspaceModelProxyEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const embedded = this.embedded;
    if (embedded) {
      await embedded.modelService.stream(
        { ...body, accountId },
        emit,
        signal,
        this.options.hostId,
      );
      return;
    }
    const payload = JSON.stringify({ ...body, accountId });
    const headers = signHostRequest(this.options.hostKey, {
      hostId: this.options.hostId,
      accountId,
      method: 'POST',
      path: '/api/workstation/host/model-proxy',
      body: Buffer.from(payload),
    });
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/workstation/host/model-proxy`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: payload,
        signal,
      });
    } catch (err) {
      console.warn('[tandem] 模型代理请求失败:', this.base, (err as Error).message);
      throw err;
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`工作站返回 ${res.status}：${text.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        emit(JSON.parse(line) as WorkspaceModelProxyEvent);
      }
    }
    const tail = buffer.trim();
    if (tail) emit(JSON.parse(tail) as WorkspaceModelProxyEvent);
  }

  async listModels(accountId: string, input: ListModelsInput): Promise<ListModelsResult> {
    const embedded = this.embedded;
    if (embedded) return embedded.modelService.listModels(accountId, input);
    return this.signedPost<ListModelsResult>('/api/workstation/host/models', accountId, { ...input });
  }

  async testProfile(
    accountId: string,
    profileId: string,
    groupId?: string,
    keyId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const embedded = this.embedded;
    if (embedded) return embedded.modelService.testProfile(accountId, profileId, groupId, keyId);
    return this.signedPost('/api/workstation/host/profile-test', accountId, {
      profileId,
      ...(groupId ? { groupId } : {}),
      ...(keyId ? { keyId } : {}),
    });
  }

  publicProfiles(accountId: string): Profile[] {
    return this.embedded?.profiles.publicList(accountId) ?? [];
  }
}
