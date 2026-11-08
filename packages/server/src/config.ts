// 数据目录与账号存储：~/.tandem（可用 TANDEM_HOME 覆盖）。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  ContextSettings,
  KeyStrategy,
  ModelCapabilities,
  Profile,
  ProfileGroup,
  ProfileGroupInput,
  ProfileInput,
  ProfileKey,
  ProviderKind,
  ReasoningEffort,
} from '@tandem/protocol';
import type {
  HostConfig,
  RelayConfig,
  StoredProfile,
  StoredProfileGroup,
  StoredProfileKey,
} from './types.js';
import { normalizeContextSettings } from './context-settings.js';
import { normalizeRoutingSettings } from './routing-settings.js';

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

function isRelayConfig(value: unknown): value is RelayConfig {
  return !!value && typeof value === 'object' && typeof (value as RelayConfig).url === 'string' && !!(value as RelayConfig).url;
}

/** 单独更新 config.json 里的 relay 字段（保留其余内容）。 */
export function saveRelayConfig(home: string, relay: RelayConfig): void {
  const file = path.join(home, 'config.json');
  const existing = readJson<Record<string, unknown>>(file) ?? {};
  writePrivateFile(file, JSON.stringify({ ...existing, relay }, null, 2));
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
    idleTimeoutSec:
      typeof existing?.idleTimeoutSec === 'number' && Number.isFinite(existing.idleTimeoutSec) && existing.idleTimeoutSec > 0
        ? existing.idleTimeoutSec
        : 180,
    resumeOnRestart: existing?.resumeOnRestart === 'pause' ? 'pause' : 'auto',
    defaultDelegation:
      existing?.defaultDelegation === 'orchestrate' ||
      existing?.defaultDelegation === 'more' ||
      existing?.defaultDelegation === 'none'
        ? existing.defaultDelegation
        : 'less',
    ...(existing?.voice && typeof existing.voice === 'object' ? { voice: existing.voice } : {}),
    context: normalizeContextSettings(existing?.context),
    ...(existing?.aiReview && typeof existing.aiReview === 'object'
      ? { aiReview: existing.aiReview }
      : {}),
    ...(existing?.handoff && typeof existing.handoff === 'object'
      ? { handoff: existing.handoff }
      : {}),
    ...(normalizeRoutingSettings(existing?.modelRouting)
      ? { modelRouting: normalizeRoutingSettings(existing?.modelRouting)! }
      : {}),
    ...(typeof existing?.updateShareDir === 'string' && existing.updateShareDir.trim()
      ? { updateShareDir: existing.updateShareDir.trim() }
      : {}),
    ...(existing?.devices && typeof existing.devices === 'object' ? { devices: existing.devices } : {}),
    ...(isRelayConfig(existing?.relay) ? { relay: existing.relay } : {}),
  };
  if (
    existing?.hostId !== config.hostId ||
    existing?.token !== config.token ||
    existing?.idleTimeoutSec !== config.idleTimeoutSec ||
    existing?.resumeOnRestart !== config.resumeOnRestart ||
    existing?.defaultDelegation !== config.defaultDelegation ||
    JSON.stringify(existing?.context ?? null) !== JSON.stringify(config.context)
  ) {
    writePrivateFile(file, JSON.stringify(config, null, 2));
  }
  return config;
}

/** 只更新 Host 行为设置，保留 token/relay 等其余字段。 */
export function saveHostSettings(
  home: string,
  settings: {
    resumeOnRestart: 'auto' | 'pause';
    defaultDelegation?: import('@tandem/protocol').DelegationStrategy;
    voice?: import('@tandem/protocol').VoiceSettings;
    context?: ContextSettings;
    aiReview?: import('@tandem/protocol').AiReviewSettings;
    handoff?: import('@tandem/protocol').HandoffSettings;
    modelRouting?: import('@tandem/protocol').ModelRoutingSettings | null;
    updateShareDir?: string;
    devices?: import('@tandem/protocol').DeviceSettings;
  },
): void {
  const file = path.join(home, 'config.json');
  const existing = readJson<Record<string, unknown>>(file) ?? {};
  const merged: Record<string, unknown> = { ...existing, ...settings };
  if (settings.modelRouting === null) delete merged.modelRouting;
  if (!settings.updateShareDir) delete merged.updateShareDir;
  writePrivateFile(file, JSON.stringify(merged, null, 2));
}

export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

const KINDS: ProviderKind[] = ['anthropic', 'openai', 'openai-compatible', 'gemini', 'tandem-gateway'];
/** 持久化层允许 demo（内置演示账号），但设置页/API 不允许用户自建。 */
const STORED_KINDS: ProviderKind[] = [...KINDS, 'demo'];

export class ProfileStore {
  private file: string;
  private profiles = new Map<string, StoredProfile>();

  constructor(home = tandemHome()) {
    this.file = path.join(home, 'profiles.json');
    const data = readJson<{ profiles?: StoredProfile[] }>(this.file);
    for (const p of data?.profiles ?? []) {
      if (p && typeof p.id === 'string' && STORED_KINDS.includes(p.kind)) {
        const profile: StoredProfile = {
          ...p,
          apiKey: p.apiKey ?? '',
          models: Array.isArray(p.models) ? p.models : [],
          defaultModel: p.defaultModel ?? p.models?.[0] ?? '',
        };
        // 老数据没有 groups，按无分组账号处理；分组里的单 apiKey 迁移为 keys[0]
        const groups = normalizeStoredGroups(p.groups);
        if (groups.length) profile.groups = groups;
        else delete profile.groups;
        const price = normalizePrice(p.price);
        if (price) profile.price = price;
        else delete profile.price;
        const caps = normalizeModelCapabilities(p.modelCapabilities);
        if (caps) profile.modelCapabilities = caps;
        else delete profile.modelCapabilities;
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
      kind: STORED_KINDS.includes(input.kind) ? input.kind : 'openai-compatible',
      baseUrl: normalizeBaseUrl(input.baseUrl),
      apiKey: String(input.apiKey ?? ''),
      models: normalizeModels(input.models),
      defaultModel: input.defaultModel || normalizeModels(input.models)[0] || '',
      createdAt: now,
    };
    const multiplier = normalizeMultiplier((input as { multiplier?: unknown }).multiplier);
    if (multiplier !== undefined) profile.multiplier = multiplier;
    const price = normalizePrice((input as { price?: unknown }).price);
    if (price) profile.price = price;
    const caps = normalizeModelCapabilities(input.modelCapabilities);
    if (caps) profile.modelCapabilities = caps;
    const groups = buildGroups(input.groups, [], String(input.apiKey ?? ''));
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
      kind: input.kind && STORED_KINDS.includes(input.kind) ? input.kind : current.kind,
      baseUrl: input.baseUrl !== undefined ? normalizeBaseUrl(input.baseUrl) : current.baseUrl,
      models,
      defaultModel: input.defaultModel || current.defaultModel || models[0] || '',
      // 不传或传空字符串表示保持原 key
      apiKey: input.apiKey ? String(input.apiKey) : current.apiKey,
    };
    // multiplier 是协议 Profile 的倍率字段：不传保持原值，null 表示恢复默认 1。
    if (input.multiplier !== undefined) {
      const multiplier = normalizeMultiplier(input.multiplier);
      if (multiplier !== undefined) next.multiplier = multiplier;
      else delete next.multiplier;
    }
    // price 是协议 Profile 的只读展示字段：更新时允许作为扩展字段传入，null 表示清除
    const rawPrice = (input as { price?: unknown }).price;
    if (rawPrice !== undefined) {
      const price = normalizePrice(rawPrice);
      if (price) next.price = price;
      else delete next.price;
    }
    if (input.modelCapabilities !== undefined) {
      const caps = normalizeModelCapabilities(input.modelCapabilities);
      if (caps) next.modelCapabilities = caps;
      else delete next.modelCapabilities;
    }
    // 传了 groups 就整体替换；带 id 且不带 apiKey 的分组保留原 key
    if (input.groups !== undefined) {
      const groups = buildGroups(input.groups, current.groups, current.apiKey);
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

  /** 记录分组 Key 的运行状态（停用/冷却/最近错误）；keyId 为空时忽略。 */
  updateKeyState(
    profileId: string,
    groupId: string | undefined,
    keyId: string | undefined,
    patch: Partial<Omit<StoredProfileKey, 'id' | 'apiKey'>>,
  ): StoredProfileKey | undefined {
    if (!keyId || !groupId) return undefined;
    const profile = this.profiles.get(profileId);
    const group = profile?.groups?.find((g) => g.id === groupId);
    const key = group?.keys?.find((k) => k.id === keyId);
    if (!profile || !group || !key) return undefined;
    Object.assign(key, patch);
    if (group.keys?.[0] === key) group.apiKey = key.apiKey;
    this.save();
    return key;
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
      ...(profile.multiplier !== undefined ? { multiplier: profile.multiplier } : {}),
      ...(profile.price ? { price: { ...profile.price } } : {}),
      ...(profile.modelCapabilities
        ? { modelCapabilities: structuredClone(profile.modelCapabilities) }
        : {}),
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

/** 账号单价覆盖：{ 模型名: { input, output } }，每百万 token 美元。 */
/** 价格倍率：0 以上有限数；缺省/非法返回 undefined。 */
export function normalizeMultiplier(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000) return undefined;
  return Math.round(n * 1e6) / 1e6;
}

export function normalizePrice(
  value: unknown,
): Record<string, { input: number; output: number }> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, { input: number; output: number }> = {};
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = model.trim();
    if (!name || !raw || typeof raw !== 'object') continue;
    const price = raw as { input?: unknown; output?: unknown };
    const input = Number(price.input);
    const output = Number(price.output);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    out[name] = { input, output };
  }
  return Object.keys(out).length ? out : undefined;
}

const EFFORT_VALUES: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max'];

/** 账号/分组上的模型能力覆盖：{ 模型名: { efforts, contextWindow } }。 */
export function normalizeModelCapabilities(
  value: unknown,
): Record<string, ModelCapabilities> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, ModelCapabilities> = {};
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = model.trim();
    if (!name || !raw || typeof raw !== 'object') continue;
    const caps = raw as { efforts?: unknown; contextWindow?: unknown };
    const item: ModelCapabilities = {};
    if (Array.isArray(caps.efforts)) {
      item.efforts = [
        ...new Set(
          caps.efforts.filter((e): e is ReasoningEffort =>
            EFFORT_VALUES.includes(e as ReasoningEffort),
          ),
        ),
      ];
    }
    const window = Number(caps.contextWindow);
    if (Number.isFinite(window) && window > 0) item.contextWindow = window;
    if (item.efforts !== undefined || item.contextWindow !== undefined) out[name] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeBaseUrl(url: unknown): string | undefined {
  const value = typeof url === 'string' ? url.trim() : '';
  return value || undefined;
}

/** 备用分组链：去重、去空、去掉自己（同账号分组 id）。 */
function normalizeFallbackIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out.length ? out : undefined;
}

function normalizeKeyStrategy(value: unknown): KeyStrategy | undefined {
  return value === 'round_robin' || value === 'failover' ? value : undefined;
}

/** 兼容老数据：单个 apiKey 迁移为 keys[0]（id 用分组 id 派生，保证多次加载稳定）。 */
function normalizeStoredKeys(
  value: unknown,
  legacyApiKey: string,
  groupId: string,
): StoredProfileKey[] {
  const out: StoredProfileKey[] = [];
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue;
      const k = raw as Partial<StoredProfileKey>;
      const apiKey = typeof k.apiKey === 'string' ? k.apiKey : '';
      if (!apiKey) continue;
      out.push({
        id: typeof k.id === 'string' && k.id ? k.id : randomUUID(),
        ...(typeof k.label === 'string' && k.label.trim() ? { label: k.label.trim() } : {}),
        apiKey,
        ...(k.disabled ? { disabled: true } : {}),
        ...(typeof k.cooldownUntil === 'number' && k.cooldownUntil > 0
          ? { cooldownUntil: k.cooldownUntil }
          : {}),
        ...(typeof k.failures === 'number' && k.failures > 0 ? { failures: k.failures } : {}),
        ...(typeof k.lastError === 'string' && k.lastError ? { lastError: k.lastError } : {}),
        ...(typeof k.lastErrorAt === 'number' && k.lastErrorAt > 0
          ? { lastErrorAt: k.lastErrorAt }
          : {}),
      });
    }
  }
  if (out.length === 0 && legacyApiKey) {
    out.push({ id: `${groupId}-k1`, apiKey: legacyApiKey });
  }
  return out;
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
    const caps = normalizeModelCapabilities(g.modelCapabilities);
    const id = typeof g.id === 'string' && g.id ? g.id : randomUUID();
    const apiKey = typeof g.apiKey === 'string' ? g.apiKey : '';
    const keys = normalizeStoredKeys(g.keys, apiKey, id);
    out.push({
      id,
      name,
      ...(KINDS.includes(g.kind as ProviderKind) ? { kind: g.kind as ProviderKind } : {}),
      apiKey: keys[0]?.apiKey ?? '',
      keys,
      ...(normalizeKeyStrategy(g.keyStrategy) ? { keyStrategy: normalizeKeyStrategy(g.keyStrategy) } : {}),
      baseUrl: normalizeBaseUrl(g.baseUrl),
      models,
      defaultModel:
        (typeof g.defaultModel === 'string' && g.defaultModel.trim()) || models[0] || '',
      ...(caps ? { modelCapabilities: caps } : {}),
      ...(normalizeFallbackIds(g.fallbackGroupIds)?.length
        ? { fallbackGroupIds: normalizeFallbackIds(g.fallbackGroupIds) }
        : {}),
    });
  }
  return out;
}

/**
 * 接口传入的 apiKeys 整体替换分组 Key 列表：带 id 且不带 apiKey 表示保留原 key；
 * 新条目必须带 apiKey（不重复存明文）。未传 apiKeys 时沿用旧的单 apiKey 语义。
 */
function buildKeys(
  raw: ProfileGroupInput,
  old: StoredProfileGroup | undefined,
  fallbackKey: string,
): StoredProfileKey[] {
  const oldById = new Map((old?.keys ?? []).map((k) => [k.id, k]));
  if (Array.isArray(raw.apiKeys)) {
    const out: StoredProfileKey[] = [];
    const seen = new Set<string>();
    for (const item of raw.apiKeys) {
      if (!item || typeof item !== 'object') continue;
      const itemId = typeof item.id === 'string' ? item.id.trim() : '';
      const prev = itemId ? oldById.get(itemId) : undefined;
      const apiKey = typeof item.apiKey === 'string' && item.apiKey ? item.apiKey : prev?.apiKey;
      if (!apiKey) continue;
      const id = prev?.id ?? (itemId && !seen.has(itemId) ? itemId : randomUUID());
      if (seen.has(id)) continue;
      seen.add(id);
      const label = typeof item.label === 'string' ? item.label.trim() : prev?.label;
      // 重新填写 key / 显式 disabled=false 视为用户修复并重新启用该 Key
      const reset =
        !prev ||
        (typeof item.apiKey === 'string' && !!item.apiKey) ||
        (item as { disabled?: unknown }).disabled === false;
      const manuallyDisabled = (item as { disabled?: unknown }).disabled === true;
      out.push({
        ...(prev ?? {}),
        id,
        ...(label ? { label } : {}),
        apiKey,
        ...(reset
          ? {
              disabled: undefined,
              cooldownUntil: undefined,
              failures: undefined,
              lastError: undefined,
              lastErrorAt: undefined,
            }
          : {}),
        ...(manuallyDisabled ? { disabled: true } : {}),
      });
    }
    return out.map(cleanStoredKey);
  }
  // 旧字段 apiKey：替换为单 Key
  if (typeof raw.apiKey === 'string' && raw.apiKey) {
    const id = old?.keys?.[0]?.id ?? randomUUID();
    return [{ id, apiKey: raw.apiKey }];
  }
  // 未传任何 Key：保留原列表；老分组/新分组兜底用账号 key
  if (old?.keys?.length) return old.keys;
  const fallback = old?.apiKey || fallbackKey;
  return fallback ? [{ id: old?.id ? `${old.id}-k1` : randomUUID(), apiKey: fallback }] : [];
}

/** 去掉值为 undefined 的可选字段，保证 JSON 干净（清状态时不残留旧值）。 */
function cleanStoredKey(key: StoredProfileKey): StoredProfileKey {
  const out: StoredProfileKey = { id: key.id, apiKey: key.apiKey };
  if (key.label) out.label = key.label;
  if (key.disabled) out.disabled = true;
  if (typeof key.cooldownUntil === 'number' && key.cooldownUntil > 0) out.cooldownUntil = key.cooldownUntil;
  if (typeof key.failures === 'number' && key.failures > 0) out.failures = key.failures;
  if (key.lastError) out.lastError = key.lastError;
  if (typeof key.lastErrorAt === 'number' && key.lastErrorAt > 0) out.lastErrorAt = key.lastErrorAt;
  if (key.quota) out.quota = { ...key.quota };
  if (typeof key.rateLimitHits === 'number' && key.rateLimitHits > 0) out.rateLimitHits = key.rateLimitHits;
  return out;
}

/** 把接口传入的分组转成存储结构；prev 用于按 id 保留未重传的 key/baseUrl。 */
function buildGroups(
  input: ProfileGroupInput[] | undefined,
  prev: StoredProfileGroup[] = [],
  fallbackKey = '',
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
    const kind = raw.kind && KINDS.includes(raw.kind) ? raw.kind : old?.kind;
    const caps =
      raw.modelCapabilities !== undefined
        ? normalizeModelCapabilities(raw.modelCapabilities)
        : old?.modelCapabilities;
    const keys = buildKeys(raw, old, fallbackKey);
    const keyStrategy = normalizeKeyStrategy(raw.keyStrategy) ?? old?.keyStrategy;
    const fallbackGroupIds = normalizeFallbackIds(raw.fallbackGroupIds) ?? old?.fallbackGroupIds;
    const multiplier =
      raw.multiplier !== undefined ? normalizeMultiplier(raw.multiplier) : old?.multiplier;
    out.push({
      id,
      name,
      ...(kind ? { kind } : {}),
      // apiKey 是 keys[0] 的镜像（兼容旧代码/旧客户端）
      apiKey: keys[0]?.apiKey ?? '',
      keys,
      ...(keyStrategy ? { keyStrategy } : {}),
      baseUrl: raw.baseUrl !== undefined ? normalizeBaseUrl(raw.baseUrl) : old?.baseUrl,
      models,
      defaultModel:
        (typeof raw.defaultModel === 'string' && raw.defaultModel.trim()) || old?.defaultModel || models[0] || '',
      ...(multiplier !== undefined ? { multiplier } : {}),
      ...(caps ? { modelCapabilities: caps } : {}),
      ...(fallbackGroupIds?.length ? { fallbackGroupIds } : {}),
    });
  }
  return out;
}

function toPublicKey(key: StoredProfileKey): ProfileKey {
  return {
    id: key.id,
    ...(key.label ? { label: key.label } : {}),
    apiKeyMasked: maskApiKey(key.apiKey),
    ...(key.disabled ? { disabled: true } : {}),
    ...(key.cooldownUntil ? { cooldownUntil: key.cooldownUntil } : {}),
    ...(key.lastError ? { lastError: key.lastError } : {}),
    ...(key.quota ? { quota: { ...key.quota } } : {}),
    ...(key.rateLimitHits ? { rateLimitHits: key.rateLimitHits } : {}),
  };
}

function toPublicGroup(group: StoredProfileGroup): ProfileGroup {
  const keys = group.keys ?? [];
  return {
    id: group.id,
    name: group.name,
    ...(group.kind ? { kind: group.kind } : {}),
    apiKeyMasked: maskApiKey(keys[0]?.apiKey ?? group.apiKey),
    keys: keys.map((key) => toPublicKey(key)),
    ...(group.keyStrategy ? { keyStrategy: group.keyStrategy } : {}),
    ...(group.baseUrl ? { baseUrl: group.baseUrl } : {}),
    models: [...group.models],
    defaultModel: group.defaultModel,
    ...(group.multiplier !== undefined ? { multiplier: group.multiplier } : {}),
    ...(group.fallbackGroupIds?.length ? { fallbackGroupIds: [...group.fallbackGroupIds] } : {}),
    ...(group.modelCapabilities
      ? { modelCapabilities: structuredClone(group.modelCapabilities) }
      : {}),
  };
}

/**
 * 分组协议与账号不同、且分组没有单独填 Base URL 时，从账号 URL 推断该协议的 API 根路径：
 * 去掉账号 URL 上已有的完整端点（如 /v1/messages、/chat/completions），
 * 无路径的域名按协议补上常见版本段（OpenAI 系 /v1，Gemini /v1beta/openai）。
 * 用户在分组里显式填写的 Base URL 保持原样。
 */
export function inferProtocolBaseUrl(baseUrl: string | undefined, kind: ProviderKind): string | undefined {
  if (!baseUrl) return undefined;
  let base = baseUrl.trim().replace(/\/+$/, '');
  base = base
    .replace(/\/(?:v1\/)?messages$/i, '')
    .replace(/\/(?:v1\/)?chat\/completions$/i, '')
    .replace(/\/models$/i, '');
  if (!base) return undefined;
  if (kind === 'anthropic') return base;
  try {
    const pathname = new URL(base).pathname.replace(/\/+$/, '');
    if (!pathname || pathname === '/') {
      return `${base}/${kind === 'gemini' ? 'v1beta/openai' : 'v1'}`;
    }
    if (kind === 'gemini' && pathname === '/v1beta') return `${base}/openai`;
  } catch {
    // 非法 URL 交给 provider 报错
  }
  return base;
}

/** 会话运行时使用的有效账号：分组覆盖协议/key/baseUrl/模型，缺省回落到账号自身。 */
export function effectiveProfile(profile: StoredProfile, groupId?: string): StoredProfile {
  const group = groupId ? profile.groups?.find((g) => g.id === groupId) : undefined;
  if (!group) return profile;
  const kind = group.kind ?? profile.kind;
  return {
    ...profile,
    kind,
    apiKey: group.apiKey || profile.apiKey,
    baseUrl:
      group.baseUrl ??
      (kind !== profile.kind ? inferProtocolBaseUrl(profile.baseUrl, kind) : profile.baseUrl),
    models: group.models.length ? [...group.models] : [...profile.models],
    defaultModel: group.defaultModel || group.models[0] || profile.defaultModel,
    ...(group.multiplier !== undefined ? { groupMultiplier: group.multiplier } : {}),
    ...(profile.modelCapabilities || group.modelCapabilities
      ? {
          modelCapabilities: {
            ...profile.modelCapabilities,
            ...group.modelCapabilities,
          },
        }
      : {}),
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
    case 'tandem-gateway':
      return '';
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
