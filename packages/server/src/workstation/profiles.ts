// 账号级模型账号：Key 加密保存在工作站（AES-256-GCM，密钥单独 0600 文件）。
// 主机只同步元数据与掩码；工作站在模型代理里用真实 Key 调上游。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Profile, ProfileInput } from '@tandem/protocol';
import { ProfileStore, normalizeStoredGroups } from '../config.js';
import { decryptWithKey, encryptWithKey, loadKey, writeSecretFile } from '../secrets.js';
import type { StoredProfile } from '../types.js';

interface AccountsFile {
  version: number;
  accounts: Record<string, { profiles: StoredProfile[] }>;
}

const FILE_VERSION = 1;

function emptyData(): AccountsFile {
  return { version: FILE_VERSION, accounts: {} };
}

/**
 * 每个工作站账号一份 ProfileStore（纯内存视图），整体加密落盘到 workstation/profiles.json，
 * 密钥在 workstation/profiles.key（0600，与密文分开）。
 */
export class AccountProfileStore {
  private readonly file: string;
  private readonly key: Buffer;
  private readonly stores = new Map<string, ProfileStore>();
  private data: AccountsFile;

  constructor(private readonly home: string) {
    this.file = path.join(home, 'profiles.json');
    this.key = loadKey(path.join(home, 'profiles.key'));
    this.data = this.load();
  }

  private load(): AccountsFile {
    if (!existsSync(this.file)) return emptyData();
    try {
      const raw = decryptWithKey(this.key, readFileSync(this.file, 'utf8').trim());
      const parsed = JSON.parse(raw) as Partial<AccountsFile>;
      const accounts: AccountsFile['accounts'] = {};
      for (const [accountId, entry] of Object.entries(parsed.accounts ?? {})) {
        const profiles = Array.isArray(entry?.profiles) ? entry.profiles : [];
        accounts[accountId] = { profiles: profiles.filter((p) => p && typeof p.id === 'string') };
      }
      return { version: FILE_VERSION, accounts };
    } catch (err) {
      console.warn('[workstation] 无法解密账号模型账号文件，按空处理:', (err as Error).message);
      return emptyData();
    }
  }

  private persist(): void {
    const plain = JSON.stringify(this.data);
    writeSecretFile(this.file, encryptWithKey(this.key, plain));
  }

  /** 该账号的 ProfileStore；写操作通过 persistence 回调写回加密文件。 */
  forAccount(accountId: string): ProfileStore {
    const existing = this.stores.get(accountId);
    if (existing) return existing;
    if (!this.data.accounts[accountId]) this.data.accounts[accountId] = { profiles: [] };
    const store = new ProfileStore({
      load: () => ({ profiles: this.data.accounts[accountId]?.profiles ?? [] }),
      save: (profiles) => {
        this.data.accounts[accountId] = { profiles };
        this.persist();
      },
    });
    this.stores.set(accountId, store);
    return store;
  }

  list(accountId: string): StoredProfile[] {
    return this.forAccount(accountId).list();
  }

  get(accountId: string, profileId: string): StoredProfile | undefined {
    return this.forAccount(accountId).get(profileId);
  }

  publicList(accountId: string): Profile[] {
    const store = this.forAccount(accountId);
    return store.list().map((profile) => this.publicOf(accountId, store, profile));
  }

  publicOf(accountId: string, store: ProfileStore, profile: StoredProfile): Profile {
    return { ...store.toPublic(profile), accountId, source: 'account' };
  }

  create(accountId: string, input: ProfileInput): Profile {
    const store = this.forAccount(accountId);
    return this.publicOf(accountId, store, store.create(input));
  }

  update(accountId: string, profileId: string, input: ProfileInput): Profile | undefined {
    const store = this.forAccount(accountId);
    const updated = store.update(profileId, input);
    return updated ? this.publicOf(accountId, store, updated) : undefined;
  }

  remove(accountId: string, profileId: string): boolean {
    return this.forAccount(accountId).delete(profileId);
  }

  /**
   * 一次性迁移：把主机本地 profiles 搬进账号。同名同协议以工作站已有为准，丢弃主机的；
   * 不做改名/合并/备份（用户要求：目前单人测试，简单直接）。
   */
  importStored(accountId: string, incoming: StoredProfile[]): { imported: number; renamed: number } {
    const store = this.forAccount(accountId);
    let imported = 0;
    for (const item of incoming) {
      if (!item || typeof item.id !== 'string') continue;
      if (store.get(item.id)) continue;
      if (store.list().some((p) => p.name === item.name && p.kind === item.kind)) continue;
      const profile: StoredProfile = {
        ...item,
        apiKey: item.apiKey ?? '',
        models: Array.isArray(item.models) ? item.models : [],
        defaultModel: item.defaultModel || item.models?.[0] || '',
        createdAt: item.createdAt || Date.now(),
        groups: normalizeStoredGroups(item.groups),
        proxied: false,
      };
      if (!profile.groups?.length) delete profile.groups;
      store.upsertStored(profile);
      imported++;
    }
    return { imported, renamed: 0 };
  }

  /** 旧「按主机」profiles.json 的兼容导入（保留主机上的字段结构）。 */
  static fromLegacy(profile: StoredProfile): StoredProfile {
    return { ...profile, proxied: false };
  }

  dispose(): void {
    this.persist();
  }

  get homeDir(): string {
    return this.home;
  }
}
