// 数据目录与账号存储：~/.tandem（可用 TANDEM_HOME 覆盖）。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  Profile,
  ProfileGroup,
  ProfileGroupInput,
  ProfileInput,
  ProviderKind,
} from '@tandem/protocol';
import type { HostConfig, StoredProfile, StoredProfileGroup } from './types.js';

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
        const profile: StoredProfile = {
          ...p,
          apiKey: p.apiKey ?? '',
          models: Array.isArray(p.models) ? p.models : [],
          defaultModel: p.defaultModel ?? p.models?.[0] ?? '',
        };
        // 老数据没有 groups，按无分组账号处理
        const groups = normalizeStoredGroups(p.groups);
        if (groups.length) profile.groups = groups;
        else delete profile.groups;
        this.profiles.set(p.id, profile);
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
    const groups = buildGroups(input.groups);
    if (groups?.length) profile.groups = groups;
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
    // 传了 groups 就整体替换；带 id 且不带 apiKey 的分组保留原 key
    if (input.groups !== undefined) {
      const groups = buildGroups(input.groups, current.groups);
      if (groups?.length) next.groups = groups;
      else delete next.groups;
    }
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
      ...(profile.groups?.length ? { groups: profile.groups.map((g) => toPublicGroup(g)) } : {}),
      createdAt: profile.createdAt,
    };
  }

  /** 配置迁移导入：merge 按 name+kind 合并，replace 全量替换。 */
  importMany(
    incoming: StoredProfile[],
    mode: 'merge' | 'replace',
  ): { added: number; updated: number } {
    let added = 0;
    let updated = 0;
    if (mode === 'replace') {
      this.profiles.clear();
      for (const item of incoming) {
        const id = this.profiles.has(item.id) ? randomUUID() : item.id;
        this.profiles.set(id, { ...item, id });
        added++;
      }
      this.save();
      return { added, updated };
    }
    for (const item of incoming) {
      const matched = this.list().find((p) => p.name === item.name && p.kind === item.kind);
      if (matched) {
        this.profiles.set(matched.id, { ...item, id: matched.id });
        updated++;
      } else {
        const id = this.profiles.has(item.id) ? randomUUID() : item.id;
        this.profiles.set(id, { ...item, id });
        added++;
      }
    }
    this.save();
    return { added, updated };
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

/** 兼容老数据：groups 缺失/异常时忽略。 */
export function normalizeStoredGroups(value: unknown): StoredProfileGroup[] {
  if (!Array.isArray(value)) return [];
  const out: StoredProfileGroup[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const g = raw as Partial<StoredProfileGroup>;
    const name = typeof g.name === 'string' ? g.name.trim() : '';
    if (!name) continue;
    const models = normalizeModels(g.models);
    out.push({
      id: typeof g.id === 'string' && g.id ? g.id : randomUUID(),
      name,
      apiKey: typeof g.apiKey === 'string' ? g.apiKey : '',
      baseUrl: normalizeBaseUrl(g.baseUrl),
      models,
      defaultModel:
        (typeof g.defaultModel === 'string' && g.defaultModel.trim()) || models[0] || '',
    });
  }
  return out;
}

/** 把接口传入的分组转成存储结构；prev 用于按 id 保留未重传的 key/baseUrl。 */
function buildGroups(
  input: ProfileGroupInput[] | undefined,
  prev: StoredProfileGroup[] = [],
): StoredProfileGroup[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const prevById = new Map(prev.map((g) => [g.id, g]));
  const out: StoredProfileGroup[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name ?? '').trim();
    if (!name) continue;
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID();
    const old = prevById.get(id);
    const models = normalizeModels(raw.models);
    out.push({
      id,
      name,
      // 带 id 不带 apiKey 表示保留原 key
      apiKey: typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : old?.apiKey ?? '',
      baseUrl: raw.baseUrl !== undefined ? normalizeBaseUrl(raw.baseUrl) : old?.baseUrl,
      models,
      defaultModel:
        (typeof raw.defaultModel === 'string' && raw.defaultModel.trim()) || old?.defaultModel || models[0] || '',
    });
  }
  return out;
}

function toPublicGroup(group: StoredProfileGroup): ProfileGroup {
  return {
    id: group.id,
    name: group.name,
    apiKeyMasked: maskApiKey(group.apiKey),
    ...(group.baseUrl ? { baseUrl: group.baseUrl } : {}),
    models: [...group.models],
    defaultModel: group.defaultModel,
  };
}

/** 会话运行时使用的有效账号：分组覆盖 key/baseUrl/模型，缺省回落到账号自身。 */
export function effectiveProfile(profile: StoredProfile, groupId?: string): StoredProfile {
  const group = groupId ? profile.groups?.find((g) => g.id === groupId) : undefined;
  if (!group) return profile;
  return {
    ...profile,
    apiKey: group.apiKey || profile.apiKey,
    baseUrl: group.baseUrl ?? profile.baseUrl,
    models: group.models.length ? [...group.models] : [...profile.models],
    defaultModel: group.defaultModel || group.models[0] || profile.defaultModel,
  };
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
