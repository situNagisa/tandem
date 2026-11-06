// Host 侧端到端加密：Ed25519 身份 + X25519 临时密钥协商 + HKDF-SHA256 + AES-256-GCM。
// 客户端用 @tandem/relay/client（WebCrypto）实现对端；relay 只能看到密文。
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  E2E_HKDF_INFO,
  b64u,
  e2eTranscript,
  parseJson,
  recordNonce,
  unb64u,
  type E2EHello,
  type E2EHelloReply,
} from '@tandem/relay/wire';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface RelayIdentity {
  privateKey: KeyObject;
  publicRaw: Buffer;
  /** 公钥 SHA-256（64 位小写十六进制），配对时展示给用户核对。 */
  fingerprint: string;
}

export function generateHostKey(): string {
  return b64u(randomBytes(32));
}

/** hostKey 是 32 字节 Ed25519 种子（base64url）。 */
export function identityFromHostKey(hostKey: string): RelayIdentity {
  const seed = Buffer.from(unb64u(hostKey));
  if (seed.length !== 32) throw new Error('relay.hostKey 必须是 32 字节的 base64url');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicRaw = Buffer.from(unb64u(jwk.x as string));
  return { privateKey, publicRaw, fingerprint: createHash('sha256').update(publicRaw).digest('hex') };
}

export function signWith(identity: RelayIdentity, message: Uint8Array): Buffer {
  return sign(null, message, identity.privateKey);
}

const MAX_SESSIONS = 256;
const SESSION_TTL_MS = 24 * 3600 * 1000;
const REPLAY_WINDOW = 4096;

export interface E2ESession {
  sid: string;
  kC2S: Buffer;
  kS2C: Buffer;
  lastUsed: number;
  maxCounter: number;
  seen: Set<number>;
}

export class E2EServer {
  private sessions = new Map<string, E2ESession>();

  constructor(
    private readonly identity: RelayIdentity,
    private readonly hostId: string,
  ) {}

  hello(body: Uint8Array): E2EHelloReply {
    const req = parseJson<E2EHello>(body);
    if (req.v !== 1 || typeof req.epk !== 'string') throw new Error('握手参数无效');
    const clientEpk = unb64u(req.epk);
    if (clientEpk.length !== 32) throw new Error('临时公钥长度无效');

    const pair = generateKeyPairSync('x25519');
    const hostEpk = unb64u(pair.publicKey.export({ format: 'jwk' }).x as string);
    const peer = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(clientEpk) }, format: 'jwk' });
    const secret = diffieHellman({ privateKey: pair.privateKey, publicKey: peer });

    const transcript = e2eTranscript(this.hostId, clientEpk, hostEpk);
    const salt = createHash('sha256').update(transcript).digest();
    const keys = Buffer.from(hkdfSync('sha256', secret, salt, E2E_HKDF_INFO, 64));

    this.prune();
    const sid = randomBytes(16).toString('base64url');
    this.sessions.set(sid, {
      sid,
      kC2S: keys.subarray(0, 32),
      kS2C: keys.subarray(32, 64),
      lastUsed: Date.now(),
      maxCounter: 0,
      seen: new Set(),
    });
    return {
      v: 1,
      sid,
      epk: b64u(hostEpk),
      pub: b64u(this.identity.publicRaw),
      sig: b64u(signWith(this.identity, transcript)),
    };
  }

  session(sid: string | null): E2ESession | undefined {
    const session = sid ? this.sessions.get(sid) : undefined;
    if (session) session.lastUsed = Date.now();
    return session;
  }

  /** 请求计数防重放：每个计数只接受一次，窗口外的旧计数拒绝。 */
  acceptCounter(session: E2ESession, n: number): boolean {
    if (!Number.isSafeInteger(n) || n <= 0) return false;
    if (n <= session.maxCounter - REPLAY_WINDOW || session.seen.has(n)) return false;
    session.seen.add(n);
    if (n > session.maxCounter) session.maxCounter = n;
    if (session.seen.size > REPLAY_WINDOW * 2) {
      for (const old of session.seen) if (old <= session.maxCounter - REPLAY_WINDOW) session.seen.delete(old);
    }
    return true;
  }

  private prune(): void {
    const now = Date.now();
    for (const [sid, s] of this.sessions) if (now - s.lastUsed > SESSION_TTL_MS) this.sessions.delete(sid);
    while (this.sessions.size >= MAX_SESSIONS) {
      let oldest: E2ESession | undefined;
      for (const s of this.sessions.values()) if (!oldest || s.lastUsed < oldest.lastUsed) oldest = s;
      if (!oldest) break;
      this.sessions.delete(oldest.sid);
    }
  }
}

export function sealRecord(key: Buffer, sid: string, counter: number, index: number, plain: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, recordNonce(counter, index));
  cipher.setAAD(Buffer.from(sid));
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function openRecord(key: Buffer, sid: string, counter: number, index: number, data: Uint8Array): Buffer {
  if (data.length < 16) throw new Error('密文过短');
  const decipher = createDecipheriv('aes-256-gcm', key, recordNonce(counter, index));
  decipher.setAAD(Buffer.from(sid));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}
