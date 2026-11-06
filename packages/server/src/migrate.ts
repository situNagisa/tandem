// 配置迁移：口令 scrypt 派生密钥 + AES-256-GCM 加密账号（含明文 key）与客户端设置。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type {
  ConfigBundle,
  ConfigExportInput,
  ConfigImportInput,
  ConfigImportResult,
  ProviderKind,
} from '@tandem/protocol';
import { normalizeStoredGroups, type ProfileStore } from './config.js';
import type { StoredProfile } from './types.js';

const KINDS: ProviderKind[] = ['anthropic', 'openai', 'openai-compatible', 'gemini'];
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

interface BundlePayload {
  profiles: StoredProfile[];
  clientSettings?: unknown;
}

export class BundleError extends Error {
  readonly statusCode = 400;
}

function fail(message: string): never {
  throw new BundleError(message);
}

/** 导出配置包：账号明文 key 与分组只存在于加密载荷里。 */
export function exportBundle(
  profiles: StoredProfile[],
  hostName: string,
  input: ConfigExportInput,
): ConfigBundle {
  const passphrase = String(input?.passphrase ?? '');
  if (!passphrase) fail('口令不能为空');
  const payload: BundlePayload = {
    profiles,
    ...(input.clientSettings !== undefined ? { clientSettings: input.clientSettings } : {}),
  };
  const salt = randomBytes(16);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(passphrase, salt, KEY_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    version: 1,
    encrypted: body.toString('base64'),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    createdAt: Date.now(),
    hostName,
  };
}

/** 解密配置包；口令错误与格式错误分开提示。 */
export function decryptBundle(bundle: ConfigBundle, passphrase: string): BundlePayload {
  if (!bundle || bundle.version !== 1) fail('配置包格式无效');
  if (typeof bundle.encrypted !== 'string' || typeof bundle.salt !== 'string' || typeof bundle.iv !== 'string') {
    fail('配置包格式无效');
  }
  const salt = Buffer.from(bundle.salt, 'base64');
  const iv = Buffer.from(bundle.iv, 'base64');
  const body = Buffer.from(bundle.encrypted, 'base64');
  if (iv.length !== IV_LEN || body.length <= TAG_LEN || salt.length === 0) fail('配置包格式无效');

  let plain: string;
  try {
    const key = scryptSync(passphrase, salt, KEY_LEN);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(body.subarray(body.length - TAG_LEN));
    plain = Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_LEN)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM 校验失败通常就是口令不对
    fail('口令错误');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    fail('配置包内容无效');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as BundlePayload).profiles)) {
    fail('配置包内容无效');
  }
  return parsed as BundlePayload;
}

/** 校验并规范化导入的账号，跳过无法识别的条目。 */
function normalizeImportedProfile(raw: unknown): StoredProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Partial<StoredProfile>;
  if (typeof p.id !== 'string' || !p.id) return undefined;
  if (typeof p.name !== 'string' || !p.name.trim()) return undefined;
  if (!KINDS.includes(p.kind as ProviderKind)) return undefined;
  const models = Array.isArray(p.models)
    ? [...new Set(p.models.map((m) => String(m).trim()).filter(Boolean))]
    : [];
  const profile: StoredProfile = {
    id: p.id,
    name: p.name.trim(),
    kind: p.kind as ProviderKind,
    baseUrl: typeof p.baseUrl === 'string' && p.baseUrl.trim() ? p.baseUrl.trim() : undefined,
    apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
    models,
    defaultModel:
      (typeof p.defaultModel === 'string' && p.defaultModel.trim()) || models[0] || '',
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
  };
  const groups = normalizeStoredGroups(p.groups);
  if (groups.length) profile.groups = groups;
  return profile;
}

/** 导入配置：校验口令后按 merge/replace 合并账号，并返回客户端设置。 */
export function importBundle(store: ProfileStore, input: ConfigImportInput): ConfigImportResult {
  const passphrase = String(input?.passphrase ?? '');
  if (!passphrase) fail('口令不能为空');
  if (input.mode !== 'merge' && input.mode !== 'replace') fail('mode 只能是 merge 或 replace');

  const payload = decryptBundle(input.bundle, passphrase);
  const profiles = payload.profiles
    .map(normalizeImportedProfile)
    .filter((p): p is StoredProfile => !!p);
  const { added, updated } = store.importMany(profiles, input.mode);
  return {
    profilesAdded: added,
    profilesUpdated: updated,
    ...(payload.clientSettings !== undefined ? { clientSettings: payload.clientSettings } : {}),
  };
}
