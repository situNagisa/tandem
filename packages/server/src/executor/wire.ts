// tandem-exec 线协议 v1 的工作站侧原语：帧、握手 transcript、记录加密。规格见 docs/features/executor.md。
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

export const T = {
  HELLO: 0x01,
  WELCOME: 0x02,
  AUTH: 0x03,
  AUTH_OK: 0x04,
  REQ: 0x10,
  DATA: 0x11,
  OUT: 0x12,
  ERR: 0x13,
  END: 0x14,
  CANCEL: 0x15,
  FLOW: 0x16,
  PING: 0x17,
  PONG: 0x18,
} as const;

export const WINDOW = 1024 * 1024;
export const FRAME_MAX = 64 * 1024;
export const FLOW_THRESHOLD = 256 * 1024;
export const MAX_CONCURRENT_STREAMS = 32;
export const WS_PATH = '/executor/ws';
export const OPS = [
  'exec.shell',
  'exec.argv',
  'fs.stat',
  'fs.list',
  'fs.read',
  'fs.write',
  'fs.mkdir',
  'fs.rename',
  'fs.remove',
  'fs.walk',
  'sys.info',
] as const;

export interface KeyPair {
  priv: KeyObject;
  pub: Buffer;
}

const SPKI_PREFIX = {
  x25519: Buffer.from('302a300506032b656e032100', 'hex'),
  ed25519: Buffer.from('302a300506032b6570032100', 'hex'),
} as const;

export function genKeyPair(kind: 'x25519' | 'ed25519'): KeyPair {
  const { privateKey, publicKey } = kind === 'x25519' ? generateKeyPairSync('x25519') : generateKeyPairSync('ed25519');
  return { priv: privateKey, pub: rawPublic(publicKey) };
}

export function rawPublic(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}

export function publicKeyFrom(raw: Buffer, kind: 'x25519' | 'ed25519'): KeyObject {
  if (raw.length !== 32) throw new Error(`公钥长度错误：${raw.length}`);
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX[kind], raw]), format: 'der', type: 'spki' });
}

export function b64(buf: Buffer): string {
  return buf.toString('base64');
}

export function unb64(s: string): Buffer {
  return Buffer.from(s, 'base64');
}

export function transcript(hostId: string, epkExecB64: string, epkWsB64: string): Buffer {
  return Buffer.from(`tandem-exec-v1|${hostId}|${epkExecB64}|${epkWsB64}`, 'utf8');
}

export function signTranscript(priv: KeyObject, tr: Buffer): string {
  return sign(null, tr, priv).toString('base64');
}

export function verifyTranscript(pubRaw: Buffer, tr: Buffer, sigB64: string): boolean {
  try {
    return verify(null, tr, publicKeyFrom(pubRaw, 'ed25519'), unb64(sigB64));
  } catch {
    return false;
  }
}

export function deriveKeys(shared: Buffer, tr: Buffer): { up: Buffer; down: Buffer } {
  return {
    up: Buffer.from(hkdfSync('sha256', shared, tr, 'tandem-exec-v1 exec->ws', 32)),
    down: Buffer.from(hkdfSync('sha256', shared, tr, 'tandem-exec-v1 ws->exec', 32)),
  };
}

export function fingerprint(pubRaw: Buffer): string {
  return createHash('sha256').update(pubRaw).digest('hex').slice(0, 16);
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

export function frame(type: number, streamId: number, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(streamId, 1);
  return Buffer.concat([head, body]);
}

export interface Frame {
  type: number;
  streamId: number;
  payload: Buffer;
}

export function parseFrame(buf: Buffer): Frame {
  if (buf.length < 5) throw new Error(`帧过短：${buf.length}`);
  return { type: buf[0], streamId: buf.readUInt32BE(1), payload: buf.subarray(5) };
}

// 每个方向一个 AEAD 状态：nonce = [方向 u32 BE][计数器 u64 BE]，计数器隐式递增，无 AAD。
export class Aead {
  private counter = 0n;

  constructor(
    private readonly key: Buffer,
    private readonly dir: number,
  ) {}

  private nonce(): Buffer {
    const n = Buffer.alloc(12);
    n.writeUInt32BE(this.dir, 0);
    n.writeBigUInt64BE(this.counter, 4);
    return n;
  }

  seal(plain: Buffer): Buffer {
    const c = createCipheriv('aes-256-gcm', this.key, this.nonce());
    const body = Buffer.concat([c.update(plain), c.final()]);
    const out = Buffer.concat([body, c.getAuthTag()]);
    this.counter++;
    return out;
  }

  open(msg: Buffer): Buffer {
    if (msg.length < 16) throw new Error(`密文过短：${msg.length}`);
    const d = createDecipheriv('aes-256-gcm', this.key, this.nonce());
    d.setAuthTag(msg.subarray(msg.length - 16));
    const plain = Buffer.concat([d.update(msg.subarray(0, msg.length - 16)), d.final()]);
    this.counter++;
    return plain;
  }
}
