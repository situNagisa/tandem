// 账号中心 / 工作区：账号、角色范围、Ed25519 令牌、一次性加入码、吊销快照。
// 中心与加入方共用一份存储；加入方只保存中心公钥与快照，不持有中心私钥。
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  verify as cryptoVerify,
  sign as cryptoSign,
} from 'node:crypto';
import path from 'node:path';
import type {
  AccountLoginInput,
  AccountLoginResult,
  AccountMe,
  AccountTokens,
  TeamRole,
  WorkspaceAccount,
  WorkspaceAccountInput,
  WorkspaceAccountUpdateInput,
  WorkspaceHostInfo,
  WorkspaceInfo,
  WorkspaceJoinInput,
  WorkspaceJoinResult,
  WorkspaceOverview,
  WorkspaceRole,
  WorkspaceScope,
  WorkspaceSnapshot,
  WorkspaceStatus,
} from '@tandem/protocol';
import { readJson, writePrivateFile } from '../config.js';

export const ACCESS_TTL_MS = 30 * 60 * 1000;
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const JOIN_CODE_TTL_MS = 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 10_000;

const ROLES: WorkspaceRole[] = ['owner', 'admin', 'collaborator', 'approver', 'observer'];
const SCOPES: WorkspaceScope[] = ['all', 'hosts', 'projects'];

interface PasswordHash {
  salt: string;
  hash: string;
}
interface StoredAccount extends Omit<WorkspaceAccount, 'totpEnabled' | 'deviceKeyCount' | 'totpSecret' | 'totpUrl'> {
  password?: PasswordHash;
  totpSecret?: string;
  deviceKeys: string[];
}
interface StoredJoinCode {
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}
interface CenterFile {
  mode: 'center';
  version: 1;
  workspace: WorkspaceInfo;
  privateKey: string;
  publicKey: string;
  accounts: StoredAccount[];
  joinCodes: StoredJoinCode[];
  hosts: WorkspaceHostInfo[];
  revoked: Record<string, number>;
  invalidBefore: Record<string, number>;
  usedRefresh: Record<string, number>;
  syncToken: string;
  snapshotVersion: number;
  audit: { id: string; at: number; actor: string; action: string; detail?: string }[];
}
interface MemberFile {
  mode: 'member';
  version: 1;
  workspace: WorkspaceInfo;
  centerUrl: string;
  centerPublicKey: string;
  syncToken: string;
  hosts: WorkspaceHostInfo[];
  revoked: Record<string, number>;
  invalidBefore: Record<string, number>;
  snapshotVersion: number;
  joinedAt: number;
  lastSyncAt?: number;
  lastSyncError?: string;
}

interface TokenClaims {
  v: 1;
  typ: 'access' | 'refresh';
  ws: string;
  sub: string;
  username: string;
  name: string;
  role: WorkspaceRole;
  scope: WorkspaceScope;
  hostIds: string[];
  dirs: Record<string, string[]>;
  iat: number;
  exp: number;
  jti: string;
}

export interface AccountPrincipal {
  accountId: string;
  username: string;
  name: string;
  accountRole: WorkspaceRole;
  /** 映射到现有 Host 角色，供 team/access 的白名单与 WS 复用。 */
  role: TeamRole;
  projectDirs: string[];
  allProjects: boolean;
}

export interface AccountStoreOptions {
  home: string;
  hostId: string;
  hostName: string;
  version?: string;
  platform?: string;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}
function unb64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function signPayload(payload: string, privateKeyPem: string): string {
  return b64url(cryptoSign(null, Buffer.from(payload), createPrivateKey(privateKeyPem)));
}
function verifyPayload(payload: string, signature: string, publicKeyB64: string): boolean {
  try {
    const key = createPublicKey({ key: unb64url(publicKeyB64), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(payload), key, unb64url(signature));
  } catch {
    return false;
  }
}
function hashPassword(password: string): PasswordHash {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
function verifyPassword(password: string, stored?: PasswordHash): boolean {
  if (!stored) return false;
  try {
    const hash = scryptSync(password, Buffer.from(stored.salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
    const expected = Buffer.from(stored.hash, 'hex');
    return expected.length === hash.length && timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

// ---- TOTP（RFC 6238，HMAC-SHA1） ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  const code = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}
function verifyTotp(secretB32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code.trim())) return false;
  const secret = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 30_000);
  for (let i = -1; i <= 1; i += 1) {
    if (hotp(secret, step + i) === code.trim()) return true;
  }
  return false;
}

function normalizeHostIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim()))];
}
function normalizeDirsByHost(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [hostId, dirs] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(dirs)) continue;
    const list = [...new Set(dirs.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => path.resolve(v.trim())))];
    if (list.length) out[hostId] = list;
  }
  return out;
}
function normalizeRole(value: unknown, fallback: WorkspaceRole = 'observer'): WorkspaceRole {
  return ROLES.includes(value as WorkspaceRole) ? (value as WorkspaceRole) : fallback;
}
function normalizeScope(value: unknown, fallback: WorkspaceScope = 'all'): WorkspaceScope {
  return SCOPES.includes(value as WorkspaceScope) ? (value as WorkspaceScope) : fallback;
}
function mapRole(role: WorkspaceRole): TeamRole {
  if (role === 'owner' || role === 'admin') return 'owner';
  return role;
}

export class AccountsStore {
  private file: string;
  private state: CenterFile | MemberFile | undefined;
  private timer?: NodeJS.Timeout;
  private opts: AccountStoreOptions;

  constructor(opts: AccountStoreOptions) {
    this.opts = opts;
    this.file = path.join(opts.home, 'accounts.json');
    const raw = readJson<CenterFile | MemberFile>(this.file);
    if (raw && (raw.mode === 'center' || raw.mode === 'member')) {
      this.state = raw;
      if (raw.mode === 'center') {
        raw.accounts ??= [];
        raw.joinCodes ??= [];
        raw.hosts ??= [];
        raw.revoked ??= {};
        raw.invalidBefore ??= {};
        raw.usedRefresh ??= {};
        raw.audit ??= [];
        raw.snapshotVersion ??= 1;
      } else {
        raw.hosts ??= [];
        raw.revoked ??= {};
        raw.invalidBefore ??= {};
      }
    }
  }

  /** 成员 Host 定时拉取中心快照；中心模式无需轮询。 */
  start(): void {
    if (this.state?.mode !== 'member' || this.timer) return;
    void this.syncFromCenter();
    this.timer = setInterval(() => void this.syncFromCenter(), SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private save(): void {
    if (!this.state) return;
    writePrivateFile(this.file, JSON.stringify(this.state, null, 2));
  }

  mode(): 'none' | 'center' | 'member' {
    return this.state?.mode ?? 'none';
  }

  status(): WorkspaceStatus {
    if (!this.state) return { mode: 'none' };
    if (this.state.mode === 'center') {
      return { mode: 'center', workspace: this.state.workspace };
    }
    return {
      mode: 'member',
      workspace: this.state.workspace,
      center: { url: this.state.centerUrl, publicKey: this.state.centerPublicKey },
      lastSyncAt: this.state.lastSyncAt,
    };
  }

  private requireCenter(): CenterFile {
    if (this.state?.mode !== 'center') throw Object.assign(new Error('本机还不是账号中心'), { statusCode: 400 });
    return this.state;
  }

  private audit(actor: string, action: string, detail?: string): void {
    if (this.state?.mode !== 'center') return;
    this.state.audit.push({ id: randomUUID(), at: Date.now(), actor, action, ...(detail ? { detail } : {}) });
    this.state.audit = this.state.audit.slice(-500);
  }

  private publicAccount(account: StoredAccount, opts: { totpSecret?: boolean } = {}): WorkspaceAccount {
    const { password: _password, totpSecret, deviceKeys, ...rest } = account;
    return {
      ...rest,
      hostIds: [...rest.hostIds],
      projectDirsByHost: { ...rest.projectDirsByHost },
      totpEnabled: !!totpSecret,
      deviceKeyCount: deviceKeys.length,
      ...(opts.totpSecret && totpSecret
        ? {
            totpSecret,
            totpUrl: `otpauth://totp/Tandem:${encodeURIComponent(account.username)}?secret=${totpSecret}&issuer=Tandem`,
          }
        : {}),
    };
  }

  /** 更新本机（中心）在 Host 列表里的地址。 */
  ensureSelfHost(urls: string[]): WorkspaceHostInfo | undefined {
    if (this.state?.mode !== 'center') return undefined;
    const state = this.state;
    const clean = [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))];
    let host = state.hosts.find((h) => h.id === this.opts.hostId);
    if (!host) {
      host = {
        id: this.opts.hostId,
        name: this.opts.hostName,
        urls: clean,
        addedAt: Date.now(),
        ...(this.opts.version ? { version: this.opts.version } : {}),
        ...(this.opts.platform ? { platform: this.opts.platform } : {}),
      };
      state.hosts.push(host);
    } else if (clean.length) {
      host.urls = clean;
    }
    this.save();
    return host;
  }

  setup(name: string, username: string, password: string, urls: string[], hostName?: string): { workspace: WorkspaceInfo; host: WorkspaceHostInfo; account: WorkspaceAccount } {
    if (this.state) throw Object.assign(new Error('本机已经加入或创建了工作区'), { statusCode: 409 });
    if (!name.trim()) throw Object.assign(new Error('请填写工作区名称'), { statusCode: 400 });
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username.trim())) throw Object.assign(new Error('用户名需为 3–32 位字母、数字、下划线、点或短横线'), { statusCode: 400 });
    if (password.length < 8) throw Object.assign(new Error('密码至少 8 位'), { statusCode: 400 });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const workspace: WorkspaceInfo = { id: randomUUID(), name: name.trim(), createdAt: Date.now(), centerHostId: this.opts.hostId };
    const account: StoredAccount = {
      id: randomUUID(),
      username: username.trim(),
      name: '所有者',
      role: 'owner',
      scope: 'all',
      hostIds: [],
      projectDirsByHost: {},
      password: hashPassword(password),
      deviceKeys: [],
      createdAt: Date.now(),
    };
    const host: WorkspaceHostInfo = {
      id: this.opts.hostId,
      name: hostName ?? this.opts.hostName,
      urls: [...new Set(urls.filter((u) => /^https?:\/\//i.test(u)))],
      addedAt: Date.now(),
      ...(this.opts.version ? { version: this.opts.version } : {}),
      ...(this.opts.platform ? { platform: this.opts.platform } : {}),
    };
    this.state = {
      mode: 'center',
      version: 1,
      workspace,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      accounts: [account],
      joinCodes: [],
      hosts: [host],
      revoked: {},
      invalidBefore: {},
      usedRefresh: {},
      syncToken: randomBytes(24).toString('hex'),
      snapshotVersion: 1,
      audit: [],
    };
    this.audit('system', 'workspace.create', workspace.name);
    this.save();
    return { workspace, host, account: this.publicAccount(account) };
  }

  // ---------- 令牌 ----------
  private signAccess(account: StoredAccount, now = Date.now()): AccountTokens {
    const state = this.requireCenter();
    const claims = (typ: 'access' | 'refresh', ttl: number, jti: string): TokenClaims => ({
      v: 1,
      typ,
      ws: state.workspace.id,
      sub: account.id,
      username: account.username,
      name: account.name,
      role: account.role,
      scope: account.scope,
      hostIds: account.hostIds,
      dirs: account.projectDirsByHost,
      iat: now,
      exp: now + ttl,
      jti,
    });
    const make = (typ: 'access' | 'refresh', ttl: number) => {
      const header = b64url(JSON.stringify({ alg: 'Ed25519', typ: 'acw' }));
      const payload = b64url(JSON.stringify(claims(typ, ttl, randomUUID())));
      const body = `${header}.${payload}`;
      return `acw_${body}.${signPayload(body, state.privateKey)}`;
    };
    return {
      accessToken: make('access', ACCESS_TTL_MS),
      refreshToken: make('refresh', REFRESH_TTL_MS),
      accessExpiresAt: now + ACCESS_TTL_MS,
      refreshExpiresAt: now + REFRESH_TTL_MS,
    };
  }

  /** 本地验签（中心用自己公钥，加入方用中心公钥）。 */
  private verifyToken(token: string): TokenClaims | undefined {
    if (!token.startsWith('acw_')) return undefined;
    const raw = token.slice(4);
    const parts = raw.split('.');
    if (parts.length !== 3) return undefined;
    const [header, payload, sig] = parts as [string, string, string];
    const state = this.state;
    if (!state) return undefined;
    const pub = state.mode === 'center' ? state.publicKey : state.centerPublicKey;
    if (!verifyPayload(`${header}.${payload}`, sig, pub)) return undefined;
    let claims: TokenClaims;
    try {
      claims = JSON.parse(unb64url(payload).toString('utf8')) as TokenClaims;
    } catch {
      return undefined;
    }
    if (!claims || claims.v !== 1 || (claims.typ !== 'access' && claims.typ !== 'refresh')) return undefined;
    if (claims.ws !== state.workspace.id) return undefined;
    if (claims.exp <= Date.now()) return undefined;
    const revoked = state.revoked[claims.sub];
    if (revoked) return undefined;
    const invalid = state.invalidBefore[claims.sub];
    if (invalid && claims.iat < invalid) return undefined;
    return claims;
  }

  /** 把令牌解析为当前 Host 上的身份；无权限返回 undefined。 */
  authenticate(token: string): AccountPrincipal | undefined {
    const claims = this.verifyToken(token);
    if (!claims) return undefined;
    if (this.state?.mode === 'center') {
      const account = this.state.accounts.find((a) => a.id === claims.sub);
      if (!account || account.disabled) return undefined;
    }
    const hostId = this.opts.hostId;
    let allowed = claims.role === 'owner';
    if (!allowed) {
      if (claims.scope === 'all') allowed = true;
      else allowed = claims.hostIds.includes(hostId);
    }
    if (!allowed) return undefined;
    const projectDirs = claims.role === 'owner' || claims.role === 'admin' ? [] : [...(claims.dirs[hostId] ?? [])];
    return {
      accountId: claims.sub,
      username: claims.username,
      name: claims.name,
      accountRole: claims.role,
      role: mapRole(claims.role),
      projectDirs,
      allProjects: claims.scope !== 'projects' || claims.role === 'owner' || claims.role === 'admin',
    };
  }

  isRevoked(accountId: string): boolean {
    return !!this.state?.revoked[accountId];
  }

  accountInfo(accountId: string): WorkspaceAccount | undefined {
    if (this.state?.mode !== 'center') return undefined;
    const account = this.state.accounts.find((a) => a.id === accountId);
    return account ? this.publicAccount(account) : undefined;
  }

  /** 当前令牌对应的账号详情（用于 /api/accounts/me）。 */
  me(token: string): AccountMe | undefined {
    const principal = this.authenticate(token);
    if (!principal || !this.state) return undefined;
    const account = this.state.mode === 'center'
      ? this.state.accounts.find((a) => a.id === principal.accountId)
      : undefined;
    if (!account) return undefined;
    return {
      account: this.publicAccount(account),
      workspace: this.state.workspace,
      hostId: this.opts.hostId,
      role: principal.role,
      projectDirs: principal.projectDirs,
    };
  }

  private accountForLogin(username: string): StoredAccount | undefined {
    const state = this.requireCenter();
    return state.accounts.find((a) => a.username.toLowerCase() === username.trim().toLowerCase());
  }

  login(input: AccountLoginInput): AccountLoginResult {
    const state = this.requireCenter();
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    const account = this.accountForLogin(username);
    if (!account || account.disabled) {
      this.audit(username || '(空)', 'login.fail', '账号不存在或已禁用');
      this.save();
      throw Object.assign(new Error('用户名或密码错误'), { statusCode: 401 });
    }
    let ok = false;
    if (input.devicePublicKey && input.deviceSignature) {
      const ts = Number(input.deviceTimestamp ?? 0);
      if (Math.abs(Date.now() - ts) < 5 * 60 * 1000 && account.deviceKeys.includes(input.devicePublicKey)) {
        const msg = `tandem-login|${account.username}|${ts}`;
        try {
          const key = createPublicKey({ key: unb64url(input.devicePublicKey), format: 'der', type: 'spki' });
          ok = cryptoVerify(null, Buffer.from(msg), key, unb64url(input.deviceSignature));
        } catch {
          ok = false;
        }
      }
    } else {
      ok = verifyPassword(input.password ?? '', account.password);
      if (ok && account.totpSecret && !verifyTotp(account.totpSecret, input.totp ?? '')) {
        this.audit(account.username, 'login.fail', 'TOTP 校验失败');
        this.save();
        throw Object.assign(new Error('动态验证码不正确'), { statusCode: 401 });
      }
    }
    if (!ok) {
      this.audit(account.username, 'login.fail', '密码错误');
      this.save();
      throw Object.assign(new Error('用户名或密码错误'), { statusCode: 401 });
    }
    account.lastLoginAt = Date.now();
    this.audit(account.username, 'login.ok');
    this.save();
    return {
      ...this.signAccess(account),
      account: this.publicAccount(account),
      workspace: state.workspace,
      hosts: this.hostsForAccount(account),
    };
  }

  /** 账号令牌可访问的 Host 列表。 */
  hostsFor(token: string): WorkspaceHostInfo[] {
    const claims = this.verifyToken(token);
    if (!claims || !this.state) return [];
    if (this.state.mode === 'member') {
      if (claims.role === 'owner' || claims.role === 'admin' || claims.scope === 'all') return [...this.state.hosts];
      return this.state.hosts.filter((h) => claims.hostIds.includes(h.id));
    }
    const account = this.state.accounts.find((a) => a.id === claims.sub);
    return account ? this.hostsForAccount(account) : [];
  }

  /** 工作区快照共享口令：只给加入方 Host，避免同网段任意客户端枚举全部机器。 */
  syncSecret(): string | undefined {
    return this.state?.mode === 'center' ? this.state.syncToken : this.state?.syncToken;
  }

  private hostsForAccount(account: StoredAccount): WorkspaceHostInfo[] {
    const state = this.requireCenter();
    if (account.role === 'owner' || account.scope === 'all') return [...state.hosts];
    return state.hosts.filter((h) => account.hostIds.includes(h.id));
  }

  refresh(refreshToken: string): AccountTokens {
    const state = this.requireCenter();
    const claims = this.verifyToken(refreshToken);
    if (!claims || claims.typ !== 'refresh') throw Object.assign(new Error('刷新令牌无效或已过期'), { statusCode: 401 });
    if (state.usedRefresh[claims.jti]) throw Object.assign(new Error('刷新令牌已使用'), { statusCode: 401 });
    const account = state.accounts.find((a) => a.id === claims.sub);
    if (!account || account.disabled || state.revoked[account.id]) {
      throw Object.assign(new Error('账号已被吊销'), { statusCode: 401 });
    }
    state.usedRefresh[claims.jti] = claims.exp;
    const now = Date.now();
    for (const [jti, exp] of Object.entries(state.usedRefresh)) {
      if (exp < now) delete state.usedRefresh[jti];
    }
    this.save();
    return this.signAccess(account);
  }

  logout(refreshToken: string): void {
    if (this.state?.mode !== 'center') return;
    const claims = this.verifyToken(refreshToken);
    if (claims) {
      this.state.usedRefresh[claims.jti] = claims.exp;
      this.save();
    }
  }

  // ---------- 账号管理 ----------
  listAccounts(): WorkspaceAccount[] {
    const state = this.requireCenter();
    return state.accounts
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((a) => this.publicAccount(a));
  }

  createAccount(input: WorkspaceAccountInput, actor = 'owner'): WorkspaceAccount {
    const state = this.requireCenter();
    const username = (input.username ?? '').trim();
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw Object.assign(new Error('用户名需为 3–32 位字母、数字、下划线、点或短横线'), { statusCode: 400 });
    if (state.accounts.some((a) => a.username.toLowerCase() === username.toLowerCase())) {
      throw Object.assign(new Error('用户名已存在'), { statusCode: 409 });
    }
    const role = normalizeRole(input.role);
    if (role === 'owner') throw Object.assign(new Error('工作区只能有一个所有者（v1）'), { statusCode: 400 });
    const password = input.password ?? '';
    if (password && password.length < 8) throw Object.assign(new Error('密码至少 8 位'), { statusCode: 400 });
    const totpSecret = input.totp ? base32Encode(randomBytes(20)) : undefined;
    const account: StoredAccount = {
      id: randomUUID(),
      username,
      name: (input.name ?? '').trim() || username,
      role,
      scope: normalizeScope(input.scope),
      hostIds: normalizeHostIds(input.hostIds),
      projectDirsByHost: normalizeDirsByHost(input.projectDirsByHost),
      ...(password ? { password: hashPassword(password) } : {}),
      ...(totpSecret ? { totpSecret } : {}),
      deviceKeys: [],
      createdAt: Date.now(),
    };
    state.accounts.push(account);
    state.snapshotVersion += 1;
    this.audit(actor, 'account.create', `${username} · ${role}`);
    this.save();
    void this.pushSnapshot();
    return this.publicAccount(account, { totpSecret: true });
  }

  updateAccount(id: string, input: WorkspaceAccountUpdateInput, actor = 'owner'): WorkspaceAccount {
    const state = this.requireCenter();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
    if (typeof input.name === 'string') account.name = input.name.trim() || account.name;
    if (input.password) {
      if (input.password.length < 8) throw Object.assign(new Error('密码至少 8 位'), { statusCode: 400 });
      account.password = hashPassword(input.password);
      state.usedRefresh = {};
    }
    if (input.role !== undefined) {
      const role = normalizeRole(input.role, account.role);
      if (role === 'owner' && account.role !== 'owner') throw Object.assign(new Error('工作区只能有一个所有者（v1）'), { statusCode: 400 });
      account.role = role;
    }
    if (input.scope !== undefined) account.scope = normalizeScope(input.scope, account.scope);
    if (input.hostIds !== undefined) account.hostIds = normalizeHostIds(input.hostIds);
    if (input.projectDirsByHost !== undefined) account.projectDirsByHost = normalizeDirsByHost(input.projectDirsByHost);
    if (input.disabled !== undefined) {
      account.disabled = input.disabled;
      if (input.disabled) {
        state.revoked[account.id] = Date.now();
      } else {
        delete state.revoked[account.id];
        state.invalidBefore[account.id] = Date.now();
      }
      state.usedRefresh = {};
    }
    state.snapshotVersion += 1;
    this.audit(actor, 'account.update', account.username);
    this.save();
    void this.pushSnapshot();
    return this.publicAccount(account);
  }

  revokeAccount(id: string, actor = 'owner'): void {
    const state = this.requireCenter();
    const account = state.accounts.find((a) => a.id === id);
    if (!account) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
    if (account.role === 'owner') {
      const owners = state.accounts.filter((a) => a.role === 'owner' && !a.disabled && !state.revoked[a.id]);
      if (owners.length <= 1) throw Object.assign(new Error('不能吊销唯一的所有者账号'), { statusCode: 400 });
    }
    account.disabled = true;
    state.revoked[account.id] = Date.now();
    state.usedRefresh = {};
    state.snapshotVersion += 1;
    this.audit(actor, 'account.revoke', account.username);
    this.save();
    void this.pushSnapshot();
  }

  registerDeviceKey(accountId: string, publicKey: string): void {
    const state = this.requireCenter();
    const account = state.accounts.find((a) => a.id === accountId);
    if (!account) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
    if (!account.deviceKeys.includes(publicKey)) account.deviceKeys.push(publicKey);
    this.save();
  }

  // ---------- 加入码 / 工作区 ----------
  createJoinCode(actor = 'owner'): { code: string; expiresAt: number } {
    const state = this.requireCenter();
    const now = Date.now();
    state.joinCodes = state.joinCodes.filter((c) => !c.usedAt && c.expiresAt > now).slice(-20);
    const code = `acj_${randomBytes(18).toString('base64url')}`;
    const expiresAt = now + JOIN_CODE_TTL_MS;
    state.joinCodes.push({ codeHash: sha256(code), createdAt: now, expiresAt });
    this.audit(actor, 'join-code.create');
    this.save();
    return { code, expiresAt };
  }

  /** 中心侧：验证加入码，登记 Host，签名快照返回。 */
  acceptJoin(input: WorkspaceJoinInput): WorkspaceJoinResult {
    const state = this.requireCenter();
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    const host = input.host;
    if (!host || typeof host.id !== 'string' || !host.id.trim()) throw Object.assign(new Error('Host 信息无效'), { statusCode: 400 });
    const entry = state.joinCodes.find((c) => c.codeHash === sha256(code));
    if (!entry || entry.usedAt || entry.expiresAt < Date.now()) {
      throw Object.assign(new Error('加入码无效、已使用或已过期'), { statusCode: 401 });
    }
    entry.usedAt = Date.now();
    const urls = Array.isArray(host.urls) ? [...new Set(host.urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)))] : [];
    const info: WorkspaceHostInfo = {
      id: host.id.trim(),
      name: (host.name ?? '').trim() || host.id.trim(),
      urls,
      addedAt: Date.now(),
      lastSeenAt: Date.now(),
      ...(host.version ? { version: host.version } : {}),
      ...(host.platform ? { platform: host.platform } : {}),
    };
    const existing = state.hosts.findIndex((h) => h.id === info.id);
    if (existing >= 0) state.hosts[existing] = { ...state.hosts[existing]!, ...info, addedAt: state.hosts[existing]!.addedAt };
    else state.hosts.push(info);
    state.snapshotVersion += 1;
    this.audit(host.name ?? host.id, 'host.join', urls[0]);
    this.save();
    void this.pushSnapshot();
    return {
      workspace: state.workspace,
      center: { hostId: this.opts.hostId, publicKey: state.publicKey },
      host: info,
      snapshotVersion: state.snapshotVersion,
      syncToken: state.syncToken,
    };
  }

  removeHost(hostId: string, actor = 'owner'): void {
    const state = this.requireCenter();
    if (hostId === this.opts.hostId) throw Object.assign(new Error('不能移除账号中心本身'), { statusCode: 400 });
    state.hosts = state.hosts.filter((h) => h.id !== hostId);
    state.snapshotVersion += 1;
    this.audit(actor, 'host.remove', hostId);
    this.save();
    void this.pushSnapshot();
  }

  overview(): WorkspaceOverview {
    const state = this.requireCenter();
    this.ensureSelfHost([]);
    return {
      workspace: state.workspace,
      hosts: [...state.hosts],
      accounts: this.listAccounts(),
      revoked: { ...state.revoked },
    };
  }

  memberOverview(): WorkspaceOverview | undefined {
    if (this.state?.mode !== 'member') return undefined;
    return {
      workspace: this.state.workspace,
      hosts: [...this.state.hosts],
      accounts: [],
      revoked: { ...this.state.revoked },
      centerUrl: this.state.centerUrl,
    };
  }

  snapshot(): WorkspaceSnapshot {
    const state = this.requireCenter();
    return {
      version: state.snapshotVersion,
      workspace: state.workspace,
      hosts: [...state.hosts],
      revoked: { ...state.revoked },
      invalidBefore: { ...state.invalidBefore },
      issuedAt: Date.now(),
    };
  }

  signedSnapshot(): { snapshot: WorkspaceSnapshot; signature: string } {
    const state = this.requireCenter();
    const snapshot = this.snapshot();
    return { snapshot, signature: signPayload(JSON.stringify(snapshot), state.privateKey) };
  }

  /** 加入方：本机加入中心。 */
  async joinWorkspace(centerUrl: string, code: string, host: Omit<WorkspaceHostInfo, 'addedAt'>): Promise<WorkspaceJoinResult> {
    if (this.state) throw Object.assign(new Error('本机已经加入或创建了工作区'), { statusCode: 409 });
    const base = centerUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw Object.assign(new Error('请填写账号中心地址（http://…）'), { statusCode: 400 });
    let res: Response;
    try {
      res = await fetch(`${base}/api/accounts/workspace/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, host }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw Object.assign(new Error(`无法连接账号中心：${(err as Error).message}`), { statusCode: 502 });
    }
    const data = (await res.json().catch(() => ({}))) as Partial<WorkspaceJoinResult> & { error?: string };
    if (!res.ok) throw Object.assign(new Error(data.error ?? `账号中心返回 ${res.status}`), { statusCode: 502 });
    if (!data.workspace || !data.center?.publicKey) throw Object.assign(new Error('账号中心响应缺少工作区信息'), { statusCode: 502 });
    this.state = {
      mode: 'member',
      version: 1,
      workspace: data.workspace,
      centerUrl: base,
      centerPublicKey: data.center.publicKey,
      syncToken: data.syncToken ?? '',
      hosts: [],
      revoked: {},
      invalidBefore: {},
      snapshotVersion: data.snapshotVersion ?? 1,
      joinedAt: Date.now(),
    };
    this.save();
    this.start();
    await this.syncFromCenter();
    return data as WorkspaceJoinResult;
  }

  leaveWorkspace(): void {
    if (this.state?.mode !== 'member') throw Object.assign(new Error('本机不是加入方 Host'), { statusCode: 400 });
    this.close();
    this.state = undefined;
    this.save();
  }

  /** 中心推给加入方 Host 的快照（公开接口，但必须中心签名）。 */
  applySignedSnapshot(body: unknown): boolean {
    if (this.state?.mode !== 'member') return false;
    const b = body as { snapshot?: WorkspaceSnapshot; signature?: string } | undefined;
    if (!b || !b.snapshot || typeof b.signature !== 'string') return false;
    const snapshot = b.snapshot;
    if (snapshot.workspace?.id !== this.state.workspace.id) return false;
    // 快照版本只增不减：拒绝重放旧快照把已吊销账号“复活”。
    if (typeof snapshot.version !== 'number' || snapshot.version < this.state.snapshotVersion) return false;
    if (!verifyPayload(JSON.stringify(snapshot), b.signature, this.state.centerPublicKey)) return false;
    this.applySnapshot(snapshot);
    return true;
  }

  private applySnapshot(snapshot: WorkspaceSnapshot): void {
    if (this.state?.mode !== 'member') return;
    this.state.revoked = { ...(snapshot.revoked ?? {}) };
    this.state.invalidBefore = { ...(snapshot.invalidBefore ?? {}) };
    this.state.hosts = [...(snapshot.hosts ?? [])];
    this.state.snapshotVersion = snapshot.version;
    this.state.lastSyncAt = Date.now();
    this.state.lastSyncError = undefined;
    this.save();
    this.onRevoked?.(this.state.revoked);
  }

  async syncFromCenter(): Promise<void> {
    if (this.state?.mode !== 'member') return;
    const state = this.state;
    try {
      const res = await fetch(`${state.centerUrl}/api/accounts/workspace/snapshot`, {
        headers: state.syncToken ? { 'x-tandem-workspace-token': state.syncToken } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { snapshot?: WorkspaceSnapshot; signature?: string };
      if (!body.snapshot || !body.signature) throw new Error('快照格式无效');
      if (body.snapshot.workspace?.id !== state.workspace.id) throw new Error('工作区不匹配');
      if (typeof body.snapshot.version !== 'number' || body.snapshot.version < state.snapshotVersion) throw new Error('快照版本过旧');
      if (!verifyPayload(JSON.stringify(body.snapshot), body.signature, state.centerPublicKey)) throw new Error('快照签名无效');
      this.applySnapshot(body.snapshot);
    } catch (err) {
      state.lastSyncError = (err as Error).message;
      this.save();
    }
  }

  /** Host 注册：吊销生效后断开该账号的长连接。 */
  onRevoked?: (revoked: Record<string, number>) => void;

  private async pushSnapshot(): Promise<void> {
    const state = this.state;
    if (state?.mode !== 'center') return;
    let body: string;
    try {
      const signed = this.signedSnapshot();
      body = JSON.stringify({ snapshot: signed.snapshot, signature: signed.signature });
    } catch {
      return;
    }
    await Promise.all(
      state.hosts
        .filter((h) => h.id !== this.opts.hostId)
        .flatMap((h) => h.urls.slice(0, 1))
        .map(async (url) => {
          try {
            await fetch(`${url.replace(/\/+$/, '')}/api/accounts/workspace/sync`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-tandem-workspace-token': state.syncToken },
              body,
              signal: AbortSignal.timeout(3000),
            });
          } catch {
            // 离线 Host 靠轮询补齐
          }
        }),
    );
  }
}
