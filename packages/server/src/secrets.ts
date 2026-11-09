// 项目 Secrets：~/.tandem/secrets.json（600）存元信息与 AES-256-GCM 加密后的值。
// 接口只回名称/描述/作用范围/最后使用时间；值只在注入进程环境与打码时于内存中使用。
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  SecretInput,
  SecretMeta,
  SecretScope,
  SecretsOverview,
  SecretsSettings,
} from '@tandem/protocol';

const FILE_VERSION = 1;
const SCOPES: SecretScope[] = ['bash', 'mcp', 'hooks'];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MIN_REDACT_LENGTH = 4;
const SAVE_DEBOUNCE_MS = 800;

interface StoredSecret extends SecretMeta {
  /** v1:iv:tag:ciphertext（base64）；加载后解密到 valuePlain。 */
  value: string;
  valuePlain?: string;
}

interface SecretsFile {
  version: number;
  settings: SecretsSettings;
  secrets: StoredSecret[];
}

function writePrivateFile(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows 上 chmod 可能无效
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // 同上
  }
}

/** 项目键：向上找 .git；worktree 的 .git 文件指回主仓库时归到主仓库根。 */
export function resolveSecretProject(cwd: string): string {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const marker = path.join(dir, '.git');
    if (existsSync(marker)) {
      try {
        if (statSync(marker).isFile()) {
          const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'));
          const gitdir = match ? path.resolve(dir, match[1]!.trim()).replace(/\\/g, '/') : '';
          const index = gitdir.lastIndexOf('/.git/worktrees/');
          if (index > 0) return gitdir.slice(0, index);
        }
      } catch {
        // .git 不可读时按普通目录处理
      }
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(cwd);
}

function sameProject(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return !a && !b;
  return path.resolve(a) === path.resolve(b);
}

function normalizeScopes(input: unknown): SecretScope[] {
  const list = Array.isArray(input) ? input : [];
  const out = SCOPES.filter((scope) => list.includes(scope));
  return out.length ? out : [...SCOPES];
}

function publicMeta(secret: StoredSecret): SecretMeta {
  const { value: _value, valuePlain: _plain, ...meta } = secret;
  return {
    ...meta,
    scopes: [...meta.scopes],
  };
}

/** AES-GCM 密钥：Host 首次使用时生成，与密文分开存放（均 600）。 */
export function loadKey(file: string): Buffer {
  try {
    if (existsSync(file)) {
      const decoded = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
      if (decoded.length === 32) return decoded;
    }
  } catch {
    // 损坏时重建（旧密文将无法解密，按空值处理）
  }
  const key = randomBytes(32);
  writePrivateFile(file, key.toString('base64'));
  return key;
}

export function encryptWithKey(key: Buffer, plain: string): string {
  return encrypt(key, plain);
}

export function decryptWithKey(key: Buffer, value: string): string {
  return decrypt(key, value);
}

/** 与 secrets.json / secrets.key 相同的 0600 原子写入。 */
export function writeSecretFile(file: string, data: string): void {
  writePrivateFile(file, data);
}

function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('tandem-secrets-v1'));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(key: Buffer, value: string): string {
  if (!value.startsWith('v1:')) return value;
  const parts = value.split(':');
  if (parts.length !== 4) throw new Error('密文格式错误');
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const data = Buffer.from(parts[3]!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from('tandem-secrets-v1'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function variantsOf(value: string): string[] {
  const set = new Set<string>();
  if (value.length >= MIN_REDACT_LENGTH) set.add(value);
  try {
    const url = encodeURIComponent(value);
    if (url !== value && url.length >= MIN_REDACT_LENGTH) set.add(url);
  } catch {
    // 非法 UTF-16 时忽略 URL 编码变体
  }
  if (value) {
    const b64 = Buffer.from(value, 'utf8').toString('base64');
    if (b64.length >= MIN_REDACT_LENGTH) {
      set.add(b64);
      set.add(b64.replace(/\+/g, '-').replace(/\//g, '_'));
      set.add(b64.replace(/=+$/, ''));
    }
  }
  const json = JSON.stringify(value).slice(1, -1);
  if (json !== value && json.length >= MIN_REDACT_LENGTH) set.add(json);
  return [...set].filter((item) => item.length >= MIN_REDACT_LENGTH);
}

const GENERIC_RULES: Array<{ re: RegExp; token: string }> = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, token: '[secret:private-key]' },
  { re: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/g, token: '[secret:generic]' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, token: '[secret:generic]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, token: '[secret:generic]' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, token: '[secret:generic]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, token: '[secret:generic]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, token: '[secret:generic]' },
  { re: /\bASIA[0-9A-Z]{16}\b/g, token: '[secret:generic]' },
];

export function redactSecretValues(text: string, values: Array<{ name: string; value: string }>, genericMask: boolean): string {
  if (!text) return text;
  let out = text;
  const variants: Array<{ text: string; token: string }> = [];
  for (const item of values) {
    const token = `[secret:${item.name}]`;
    for (const variant of variantsOf(item.value)) variants.push({ text: variant, token });
  }
  // 长值优先，避免短值先替换后把长值的剩余部分漏出
  variants.sort((a, b) => b.text.length - a.text.length);
  let last = '';
  for (const item of variants) {
    if (item.text === last) continue;
    last = item.text;
    out = out.split(item.text).join(item.token);
  }
  if (genericMask) {
    for (const rule of GENERIC_RULES) out = out.replace(rule.re, rule.token);
  }
  return out;
}

export class SecretsStore {
  private file: string;
  private key: Buffer;
  private data: SecretsFile;
  private saveTimer?: NodeJS.Timeout;
  private redactorCache = new Map<string, { version: number; fn: (text: string) => string }>();
  private version = 0;
  private loadedNeedsRewrite = false;

  constructor(private readonly home: string) {
    this.file = path.join(home, 'secrets.json');
    this.key = loadKey(path.join(home, 'secrets.key'));
    this.data = this.load();
    if (this.loadedNeedsRewrite) this.saveNow();
  }

  private load(): SecretsFile {
    let raw: Partial<SecretsFile> | undefined;
    if (existsSync(this.file)) {
      try {
        raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SecretsFile>;
      } catch (err) {
        console.warn('[tandem] 无法解析 secrets.json，将重建:', (err as Error).message);
      }
    }
    const secrets: StoredSecret[] = [];
    let needsRewrite = false;
    for (const item of Array.isArray(raw?.secrets) ? raw.secrets : []) {
      if (!item || typeof item !== 'object') continue;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!NAME_RE.test(name)) continue;
      let encrypted = typeof item.value === 'string' ? item.value : '';
      let plain = '';
      try {
        plain = decrypt(this.key, encrypted);
      } catch {
        console.warn(`[tandem] secret ${name} 解密失败，已跳过`);
        continue;
      }
      if (!encrypted.startsWith('v1:')) {
        encrypted = encrypt(this.key, plain);
        needsRewrite = true;
      }
      secrets.push({
        id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
        name,
        ...(typeof item.description === 'string' && item.description.trim()
          ? { description: item.description.trim() }
          : {}),
        scopes: normalizeScopes(item.scopes),
        ...(typeof item.project === 'string' && item.project.trim()
          ? { project: path.resolve(item.project) }
          : {}),
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
        ...(typeof item.lastUsedAt === 'number' ? { lastUsedAt: item.lastUsedAt } : {}),
        value: encrypted,
        valuePlain: plain,
      });
    }
    const data: SecretsFile = {
      version: FILE_VERSION,
      settings: { genericMask: raw?.settings?.genericMask !== false },
      secrets,
    };
    this.loadedNeedsRewrite = needsRewrite;
    return data;
  }

  private saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const serializable: SecretsFile = {
      ...this.data,
      secrets: this.data.secrets.map(({ valuePlain: _plain, ...rest }) => rest),
    };
    writePrivateFile(this.file, JSON.stringify(serializable, null, 2));
  }

  private scheduleSave(): void {
    this.version += 1;
    this.redactorCache.clear();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  dispose(): void {
    this.saveNow();
  }

  get settings(): SecretsSettings {
    return { ...this.data.settings };
  }

  updateSettings(input: Partial<SecretsSettings>): SecretsSettings {
    if (typeof input.genericMask === 'boolean') this.data.settings.genericMask = input.genericMask;
    this.scheduleSave();
    this.saveNow();
    return this.settings;
  }

  /** 所有项目 + 全局的公开元信息。 */
  overview(knownProjects: string[] = []): SecretsOverview {
    const projects = new Map<string, SecretMeta[]>();
    const globals: SecretMeta[] = [];
    for (const secret of this.data.secrets) {
      const meta = publicMeta(secret);
      if (!secret.project) globals.push(meta);
      else {
        const list = projects.get(path.resolve(secret.project)) ?? [];
        list.push(meta);
        projects.set(path.resolve(secret.project), list);
      }
    }
    const known = new Set<string>(knownProjects.map((item) => path.resolve(item)));
    for (const project of projects.keys()) known.add(project);
    const sort = (a: SecretMeta, b: SecretMeta) => a.name.localeCompare(b.name);
    return {
      global: globals.sort(sort),
      projects: [...projects.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([project, secrets]) => ({ project, secrets: secrets.sort(sort) })),
      knownProjects: [...known].filter(Boolean).sort((a, b) => a.localeCompare(b)),
      settings: this.settings,
    };
  }

  list(): SecretMeta[] {
    return this.data.secrets.map(publicMeta);
  }

  get(id: string): SecretMeta | undefined {
    const found = this.data.secrets.find((item) => item.id === id);
    return found ? publicMeta(found) : undefined;
  }

  create(input: SecretInput): SecretMeta {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!NAME_RE.test(name)) {
      throw Object.assign(new Error('名称只能包含字母、数字和下划线，且不能以数字开头'), { statusCode: 400 });
    }
    const value = typeof input.value === 'string' ? input.value : '';
    if (!value) throw Object.assign(new Error('值不能为空'), { statusCode: 400 });
    const project = input.project ? resolveSecretProject(input.project) : undefined;
    if (this.data.secrets.some((item) => item.name === name && sameProject(item.project, project))) {
      throw Object.assign(new Error(`该${project ? '项目' : '全局范围'}已存在名为 ${name} 的 secret`), {
        statusCode: 400,
      });
    }
    const now = Date.now();
    const secret: StoredSecret = {
      id: randomUUID(),
      name,
      ...(typeof input.description === 'string' && input.description.trim()
        ? { description: input.description.trim() }
        : {}),
      scopes: normalizeScopes(input.scopes),
      ...(project ? { project } : {}),
      createdAt: now,
      updatedAt: now,
      value: encrypt(this.key, value),
      valuePlain: value,
    };
    this.data.secrets.push(secret);
    this.scheduleSave();
    this.saveNow();
    return publicMeta(secret);
  }

  update(id: string, input: SecretInput): SecretMeta {
    const secret = this.data.secrets.find((item) => item.id === id);
    if (!secret) throw Object.assign(new Error('secret 不存在'), { statusCode: 404 });
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : secret.name;
    if (!NAME_RE.test(name)) {
      throw Object.assign(new Error('名称只能包含字母、数字和下划线，且不能以数字开头'), { statusCode: 400 });
    }
    const project = input.project !== undefined
      ? input.project
        ? resolveSecretProject(input.project)
        : undefined
      : secret.project;
    if (
      this.data.secrets.some(
        (item) => item.id !== id && item.name === name && sameProject(item.project, project),
      )
    ) {
      throw Object.assign(new Error(`该${project ? '项目' : '全局范围'}已存在名为 ${name} 的 secret`), {
        statusCode: 400,
      });
    }
    secret.name = name;
    if (typeof input.description === 'string') {
      const description = input.description.trim();
      if (description) secret.description = description;
      else delete secret.description;
    }
    secret.scopes = normalizeScopes(input.scopes);
    if (project) secret.project = project;
    else delete secret.project;
    if (typeof input.value === 'string' && input.value !== '') {
      secret.value = encrypt(this.key, input.value);
      secret.valuePlain = input.value;
    }
    secret.updatedAt = Date.now();
    this.scheduleSave();
    this.saveNow();
    return publicMeta(secret);
  }

  remove(id: string): boolean {
    const index = this.data.secrets.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.data.secrets.splice(index, 1);
    this.scheduleSave();
    this.saveNow();
    return true;
  }

  /** 全局 + 项目，同名时项目覆盖全局。 */
  effective(project?: string): StoredSecret[] {
    const projectKey = project ? resolveSecretProject(project) : undefined;
    const map = new Map<string, StoredSecret>();
    for (const secret of this.data.secrets) {
      if (secret.project) continue;
      map.set(secret.name, secret);
    }
    if (projectKey) {
      for (const secret of this.data.secrets) {
        if (secret.project && sameProject(secret.project, projectKey)) map.set(secret.name, secret);
      }
    }
    return [...map.values()];
  }

  countFor(project?: string): number {
    if (this.data.secrets.length === 0) return 0;
    return this.effective(project).length;
  }

  /** 按作用范围组装注入环境；同时刷新 lastUsedAt。 */
  envFor(project: string | undefined, scope: SecretScope): Record<string, string> {
    const out: Record<string, string> = {};
    if (this.data.secrets.length === 0) return out;
    const used: StoredSecret[] = [];
    for (const secret of this.effective(project)) {
      if (!secret.scopes.includes(scope)) continue;
      out[secret.name] = secret.valuePlain ?? '';
      used.push(secret);
    }
    if (used.length) {
      const now = Date.now();
      for (const secret of used) secret.lastUsedAt = now;
      this.scheduleSave();
    }
    return out;
  }

  /** 系统提示里只列名称/描述/作用范围，绝不带值。 */
  promptSection(project?: string): string {
    if (this.data.secrets.length === 0) return '';
    const entries = this.effective(project);
    if (!entries.length) return '';
    const scopeLabel: Record<SecretScope, string> = { bash: 'Bash', mcp: 'MCP', hooks: 'Hooks' };
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((secret) => {
        const scopes = secret.scopes.map((scope) => scopeLabel[scope]).join('/');
        const desc = secret.description ? `：${secret.description}` : '';
        return `- ${secret.name}${desc}（${scopes}）`;
      });
    return [
      '# 项目环境变量（Secrets）',
      '以下变量的值已注入对应进程环境，模型看不到值：',
      ...lines,
      '在 Bash 中直接引用 $NAME（Windows cmd 用 %NAME%），不要 echo/env/写入文件；对话、日志和工具输出中的值会自动打码。',
    ].join('\n');
  }

  /** 会话级打码函数：按当前项目快照匹配值及其 base64/URL 编码变体。 */
  redactorFor(project?: string): (text: string) => string {
    if (this.data.secrets.length === 0) return (text) => text;
    const key = project ? resolveSecretProject(project) : '';
    const cached = this.redactorCache.get(key);
    if (cached && cached.version === this.version) return cached.fn;
    const values = this.effective(project).map((secret) => ({
      name: secret.name,
      value: secret.valuePlain ?? '',
    }));
    const generic = this.data.settings.genericMask;
    const fn = (text: string) => redactSecretValues(text, values, generic);
    this.redactorCache.set(key, { version: this.version, fn });
    return fn;
  }

  /** 供启动时把明文密文重写一次。 */
  flush(): void {
    this.saveNow();
  }
}
