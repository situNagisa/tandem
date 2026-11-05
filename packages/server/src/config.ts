// 数据目录与账号存储：~/.tandem（可用 TANDEM_HOME 覆盖）。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Profile, ProfileInput, ProviderKind } from '@tandem/protocol';
import type { HostConfig, StoredProfile } from './types.js';

export function tandemHome(): string {
  const fromEnv = process.env.TANDEM_HOME?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.tandem');
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 以 600 权限写文件：先写临时文件再原子替换。 */
function writePrivateFile(file: string, data: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 可能无效，忽略
  }
}

export function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    console.warn(`[tandem] 无法解析 ${file}，将重建:`, (err as Error).message);
    return undefined;
  }
}

/** 读取或初始化 host 配置（hostId + token）。 */
export function loadHostConfig(home = tandemHome()): HostConfig {
  ensureDir(home);
  ensureDir(path.join(home, 'sessions'));
  const file = path.join(home, 'config.json');
  const existing = readJson<Partial<HostConfig>>(file);
  const config: HostConfig = {
    hostId: typeof existing?.hostId === 'string' && existing.hostId ? existing.hostId : randomUUID(),
    token: typeof existing?.token === 'string' && existing.token ? existing.token : randomBytes(24).toString('hex'),
  };
  if (existing?.hostId !== config.hostId || existing?.token !== config.token) {
    writePrivateFile(file, JSON.stringify(config, null, 2));
  }
  return config;
}

export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

const KINDS: ProviderKind[] = ['anthropic', 'openai', 'openai-compatible', 'gemini'];

export class ProfileStore {
  private file: string;
  private profiles = new Map<string, StoredProfile>();

  constructor(home = tandemHome()) {
    this.file = path.join(home, 'profiles.json');
    const data = readJson<{ profiles?: StoredProfile[] }>(this.file);
    for (const p of data?.profiles ?? []) {
      if (p && typeof p.id === 'string' && KINDS.includes(p.kind)) {
        this.profiles.set(p.id, {
          ...p,
          apiKey: p.apiKey ?? '',
          models: Array.isArray(p.models) ? p.models : [],
          defaultModel: p.defaultModel ?? p.models?.[0] ?? '',
        });
      }
    }
  }

  list(): StoredProfile[] {
    return [...this.profiles.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): StoredProfile | undefined {
    return this.profiles.get(id);
  }

  create(input: ProfileInput): StoredProfile {
    const now = Date.now();
    const profile: StoredProfile = {
      id: randomUUID(),
      name: String(input.name ?? '').trim() || '未命名账号',
      kind: KINDS.includes(input.kind) ? input.kind : 'openai-compatible',
      baseUrl: normalizeBaseUrl(input.baseUrl),
      apiKey: String(input.apiKey ?? ''),
      models: normalizeModels(input.models),
      defaultModel: input.defaultModel || normalizeModels(input.models)[0] || '',
      createdAt: now,
    };
    this.profiles.set(profile.id, profile);
    this.save();
    return profile;
  }

  update(id: string, input: ProfileInput): StoredProfile | undefined {
    const current = this.profiles.get(id);
    if (!current) return undefined;
    const models = normalizeModels(input.models ?? current.models);
    const next: StoredProfile = {
      ...current,
      name: input.name !== undefined ? String(input.name).trim() || current.name : current.name,
      kind: input.kind && KINDS.includes(input.kind) ? input.kind : current.kind,
      baseUrl: input.baseUrl !== undefined ? normalizeBaseUrl(input.baseUrl) : current.baseUrl,
      models,
      defaultModel: input.defaultModel || current.defaultModel || models[0] || '',
      // 不传或传空字符串表示保持原 key
      apiKey: input.apiKey ? String(input.apiKey) : current.apiKey,
    };
    this.profiles.set(id, next);
    this.save();
    return next;
  }

  delete(id: string): boolean {
    const ok = this.profiles.delete(id);
    if (ok) this.save();
    return ok;
  }

  /** 转换成协议里的 Profile（apiKey 只给掩码）。 */
  toPublic(profile: StoredProfile): Profile {
    return {
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      apiKeyMasked: maskApiKey(profile.apiKey),
      models: [...profile.models],
      defaultModel: profile.defaultModel,
      createdAt: profile.createdAt,
    };
  }

  private save(): void {
    writePrivateFile(this.file, JSON.stringify({ profiles: this.list() }, null, 2));
  }
}

function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return [...new Set(models.map((m) => String(m).trim()).filter(Boolean))];
}

function normalizeBaseUrl(url: unknown): string | undefined {
  const value = typeof url === 'string' ? url.trim() : '';
  return value || undefined;
}

export function providerDefaultBaseUrl(kind: ProviderKind): string {
  switch (kind) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta/openai';
    case 'openai-compatible':
    default:
      return '';
  }
}

/** 拼接端点，避免 baseUrl 已带版本号时重复。 */
export function joinEndpoint(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const tail = suffix.startsWith('/') ? suffix : `/${suffix}`;
  if (base.endsWith(tail)) return base;
  // base 以 /v1 结尾而 suffix 以 /v1 开头
  const first = tail.split('/').filter(Boolean)[0];
  if (first && base.endsWith(`/${first}`)) {
    return base + tail.slice(first.length + 1);
  }
  return base + tail;
}

export { writePrivateFile };
