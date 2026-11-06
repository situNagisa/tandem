// 端到端加密客户端（浏览器 / Node 通用，基于 WebCrypto）。
// 用法：const ch = new E2EChannel({ baseUrl: 'https://relay/h/<hostId>', fingerprint })；
// 之后用 ch.fetch('/api/host', { headers: { Authorization: `Bearer ${token}` } }) 代替 fetch，
// 用 ch.openWebSocket(`/ws?token=${token}`) 代替 new WebSocket。relay 只能看到密文与长度。
import {
  E2E_HELLO,
  E2E_HTTP,
  E2E_MAX_RECORD,
  E2E_WS,
  R,
  WS_BINARY,
  WS_TEXT,
  b64u,
  e2eTranscript,
  E2E_HKDF_INFO,
  hex,
  normalizeFingerprint,
  packEnvelope,
  parseJson,
  recordNonce,
  unb64u,
  type E2EHelloReply,
  type E2EResHead,
} from './wire.js';

export class E2EError extends Error {}

export interface E2EOptions {
  /** `https://relay.example.com/h/<hostId>` */
  baseUrl: string;
  /** 配对时从 Host 拿到的公钥指纹（/api/pair 的 relay.fingerprint 或 CLI 展示）。 */
  fingerprint: string;
}

interface Session {
  sid: string;
  aad: Uint8Array;
  kC2S: CryptoKey;
  kS2C: CryptoKey;
  counter: number;
}

type Bytes = Uint8Array<ArrayBuffer>;
const bytes = (u: Uint8Array): Bytes => u as Bytes;
const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

async function seal(key: CryptoKey, aad: Uint8Array, counter: number, index: number, plain: Uint8Array): Promise<Uint8Array> {
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: bytes(recordNonce(counter, index)), additionalData: bytes(aad) }, key, bytes(plain));
  return new Uint8Array(ct);
}

async function open(key: CryptoKey, aad: Uint8Array, counter: number, index: number, data: Uint8Array): Promise<Uint8Array> {
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: bytes(recordNonce(counter, index)), additionalData: bytes(aad) }, key, bytes(data));
    return new Uint8Array(plain);
  } catch {
    throw new E2EError('解密失败：数据被篡改、丢失或重放');
  }
}

/** 把响应体字节流切成 [u32 长度][密文] 记录。 */
class RecordReader {
  private buf: Uint8Array = new Uint8Array(0);

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(): Promise<Uint8Array | null> {
    for (;;) {
      if (this.buf.length >= 4) {
        const len = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength).getUint32(0);
        if (len > E2E_MAX_RECORD) throw new E2EError('密文记录过大');
        if (this.buf.length >= 4 + len) {
          const record = this.buf.slice(4, 4 + len);
          this.buf = this.buf.subarray(4 + len);
          return record;
        }
      }
      const { value, done } = await this.reader.read();
      if (done) {
        if (this.buf.length > 0) throw new E2EError('响应被截断');
        return null;
      }
      const merged = new Uint8Array(this.buf.length + value.length);
      merged.set(this.buf, 0);
      merged.set(value, this.buf.length);
      this.buf = merged;
    }
  }

  cancel(): void {
    void this.reader.cancel().catch(() => undefined);
  }
}

export class E2EChannel {
  private session: Session | null = null;
  private handshaking: Promise<Session> | null = null;
  private readonly baseUrl: string;
  private readonly hostId: string;
  private readonly fingerprint: string;

  constructor(options: E2EOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.hostId = new URL(this.baseUrl).pathname.split('/').filter(Boolean).pop() ?? '';
    this.fingerprint = normalizeFingerprint(options.fingerprint);
    if (this.fingerprint.length !== 64) throw new E2EError('指纹格式无效：应为 SHA-256 的 64 位十六进制');
  }

  /** 丢弃当前会话（Host 重启或连接失败后），下次请求时重新握手。 */
  invalidate(): void {
    this.session = null;
  }

  private ensureSession(): Promise<Session> {
    if (this.session) return Promise.resolve(this.session);
    this.handshaking ??= this.handshake()
      .then((s) => (this.session = s))
      .finally(() => (this.handshaking = null));
    return this.handshaking;
  }

  private async handshake(): Promise<Session> {
    const pair = (await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
    const clientEpk = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
    const res = await fetch(`${this.baseUrl}${E2E_HELLO}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ v: 1, epk: b64u(clientEpk) }),
    });
    if (!res.ok) throw new E2EError(`加密握手失败：HTTP ${res.status}`);
    const reply = (await res.json()) as E2EHelloReply;

    const pub = unb64u(reply.pub);
    const fp = hex(new Uint8Array(await subtle().digest('SHA-256', bytes(pub))));
    if (fp !== this.fingerprint) {
      throw new E2EError('Host 公钥指纹与配对时不一致，可能被中继或中间人冒充，已拒绝连接');
    }
    const hostEpk = unb64u(reply.epk);
    const transcript = e2eTranscript(this.hostId, clientEpk, hostEpk);
    const verifyKey = await subtle().importKey('raw', bytes(pub), { name: 'Ed25519' }, false, ['verify']);
    if (!(await subtle().verify({ name: 'Ed25519' }, verifyKey, bytes(unb64u(reply.sig)), bytes(transcript)))) {
      throw new E2EError('Host 握手签名无效');
    }

    const peer = await subtle().importKey('raw', bytes(hostEpk), { name: 'X25519' }, true, []);
    const secret = await subtle().deriveBits({ name: 'X25519', public: peer }, pair.privateKey, 256);
    const salt = await subtle().digest('SHA-256', bytes(transcript));
    const hkdf = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    const keys = new Uint8Array(
      await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(E2E_HKDF_INFO) }, hkdf, 512),
    );
    const aes = (raw: Uint8Array) => subtle().importKey('raw', bytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return {
      sid: reply.sid,
      aad: enc.encode(reply.sid),
      kC2S: await aes(keys.subarray(0, 32)),
      kS2C: await aes(keys.subarray(32, 64)),
      counter: 0,
    };
  }

  /** 与 fetch 同形：path 是 Host 上的路径（`/api/...`，含查询串），请求头里的 token 随请求一起被加密。 */
  async fetch(
    path: string,
    init: { method?: string; headers?: HeadersInit; body?: string | Uint8Array | null; signal?: AbortSignal } = {},
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.ensureSession();
      const n = ++session.counter;
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => (headers[key] = value));
      const body = typeof init.body === 'string' ? enc.encode(init.body) : (init.body ?? undefined);
      const sealed = await seal(
        session.kC2S,
        session.aad,
        n,
        0,
        packEnvelope({ method: init.method ?? 'GET', path, headers }, body),
      );
      const res = await fetch(`${this.baseUrl}${E2E_HTTP}?sid=${session.sid}&n=${n}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: bytes(sealed),
        signal: init.signal,
      });
      if (res.status === 410 && attempt === 0) {
        // Host 重启或会话过期：请求尚未执行，重新握手后重试
        if (this.session === session) this.session = null;
        continue;
      }
      if (!res.ok || !res.body) throw new E2EError(`加密请求失败：HTTP ${res.status}`);
      return this.openResponse(session, n, res.body);
    }
  }

  private async openResponse(session: Session, n: number, body: ReadableStream<Uint8Array>): Promise<Response> {
    const reader = new RecordReader(body.getReader());
    let index = 0;
    const first = await reader.next();
    if (!first) throw new E2EError('响应为空');
    const plain = await open(session.kS2C, session.aad, n, index++, first);
    if (plain[0] !== R.HEAD) throw new E2EError('响应格式无效');
    const head = parseJson<E2EResHead>(plain.subarray(1));

    let ended = false;
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const record = await reader.next();
          if (!record) throw new E2EError('响应被截断');
          const p = await open(session.kS2C, session.aad, n, index++, record);
          if (p[0] === R.END) {
            ended = true;
            controller.close();
          } else if (p[0] === R.DATA) {
            controller.enqueue(p.subarray(1));
          } else {
            throw new E2EError('响应格式无效');
          }
        } catch (err) {
          controller.error(err);
        }
      },
      cancel: () => {
        if (!ended) reader.cancel();
      },
    });
    const headers = new Headers();
    for (const [k, v] of head.headers) {
      try {
        headers.append(k, v);
      } catch {
        // 浏览器禁止的头部直接忽略
      }
    }
    const nullBody = [101, 204, 205, 304].includes(head.status);
    if (nullBody) reader.cancel();
    return new Response(nullBody ? null : stream, { status: head.status, headers });
  }

  /** 与 WebSocket 同形（onopen / onmessage / onclose / onerror / send / close / readyState）。 */
  openWebSocket(path: string): E2EWebSocket {
    return new E2EWebSocket(this, path);
  }

  /** @internal */
  async _openSocket(path: string): Promise<{ session: Session; n: number; url: string }> {
    const session = await this.ensureSession();
    const n = ++session.counter;
    const sealed = await seal(session.kC2S, session.aad, n, 0, packEnvelope({ path }));
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    return { session, n, url: `${wsBase}${E2E_WS}?sid=${session.sid}&n=${n}&o=${b64u(sealed)}` };
  }
}

interface SocketEvent {
  data?: string | ArrayBuffer;
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

export class E2EWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = 0;
  onopen: ((ev: SocketEvent) => void) | null = null;
  onmessage: ((ev: SocketEvent) => void) | null = null;
  onclose: ((ev: SocketEvent) => void) | null = null;
  onerror: ((ev: SocketEvent) => void) | null = null;

  private ws: WebSocket | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private c2sIndex = 1;
  private s2cIndex = 0;
  private closed = false;

  constructor(
    private readonly channel: E2EChannel,
    path: string,
  ) {
    void this.connect(path);
  }

  private async connect(path: string): Promise<void> {
    try {
      const { session, n, url } = await this.channel._openSocket(path);
      if (this.closed) return;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.readyState = 1;
        this.onopen?.({});
      };
      ws.onmessage = (ev) => {
        const raw = new Uint8Array(ev.data as ArrayBuffer);
        this.recvChain = this.recvChain.then(async () => {
          try {
            const plain = await open(session.kS2C, session.aad, n, this.s2cIndex++, raw);
            const payload = plain.subarray(1);
            this.onmessage?.({
              data: plain[0] === WS_BINARY ? (payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer) : new TextDecoder().decode(payload),
            });
          } catch {
            this.fail(1008, '解密失败');
          }
        });
      };
      ws.onerror = () => {
        // 握手被拒（如 410 会话失效）时无法读取状态码，保守地下次重新握手
        if (this.readyState === 0) this.channel.invalidate();
        this.onerror?.({});
      };
      ws.onclose = (ev) => {
        this.readyState = 3;
        this.onclose?.({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      };
      this.sessionRef = { session, n };
    } catch {
      this.fail(1006, '加密握手失败');
    }
  }

  private sessionRef: { session: Session; n: number } | null = null;

  private fail(code: number, reason: string): void {
    this.ws?.close(code === 1006 ? 1000 : code, reason);
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.onerror?.({});
      this.onclose?.({ code, reason, wasClean: false });
    }
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 1 || !this.sessionRef) throw new E2EError('WebSocket 未连接');
    const { session, n } = this.sessionRef;
    const index = this.c2sIndex++;
    const isBinary = typeof data !== 'string';
    const payload = typeof data === 'string' ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    const plain = new Uint8Array(1 + payload.length);
    plain[0] = isBinary ? WS_BINARY : WS_TEXT;
    plain.set(payload, 1);
    this.sendChain = this.sendChain.then(async () => {
      try {
        this.ws?.send(bytes(await seal(session.kC2S, session.aad, n, index, plain)));
      } catch {
        this.fail(1011, '加密失败');
      }
    });
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    if (this.ws) {
      this.readyState = 2;
      this.ws.close(code, reason);
    } else {
      this.readyState = 3;
    }
  }
}
