// Host 侧出站隧道：主动向工作站建立 WebSocket，把工作站多路复用过来的 HTTP / WS 请求转给本机 Fastify。
// 本机请求走回环地址，沿用现有的 token 鉴权；工作站不持有也不校验用户 token。
import http from 'node:http';
import WebSocket, { type RawData } from 'ws';
import {
  E2E_CHUNK,
  E2E_HELLO,
  E2E_HTTP,
  E2E_MAX_RECORD,
  E2E_PREFIX,
  E2E_WS,
  F,
  R,
  RES_WINDOW,
  TUNNEL_PATH,
  TUNNEL_VERSION,
  WS_BINARY,
  WS_TEXT,
  b64u,
  decodeFrame,
  encodeFrame,
  jsonBytes,
  parseJson,
  readU32,
  registrationMessage,
  u32Bytes,
  unb64u,
  unpackEnvelope,
  wsMsgPayload,
  type E2EHttpHead,
  type E2EResHead,
  type E2EWsHead,
  type Frame,
  type TunnelChallenge,
  type TunnelHello,
} from './wire.js';
import { E2EServer, identityFromHostKey, openRecord, sealRecord, signWith, type E2ESession, type RelayIdentity } from './e2e.js';

interface WorkstationTunnelConfig { url: string; hostKey: string; requireE2E?: boolean }

const MAX_FRAME = 40 * 1024 * 1024;
const HEARTBEAT_MS = 20_000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

type Headers = [string, string][];

interface HostStream {
  onFrame(frame: Frame): void;
  /** 隧道断开或工作站要求取消。 */
  abort(): void;
}

/** 响应方向的发送端：RES_DATA 受工作站的 ACK 流控，超出窗口时暂停本机响应。 */
interface Sink {
  head(status: number, headers: Headers): void;
  /** 返回 false 表示应暂停来源，等 onResume。 */
  write(data: Uint8Array): boolean;
  end(): void;
  fail(message: string): void;
  onResume: (() => void) | null;
}

function hasHeader(headers: Headers, name: string): string | undefined {
  return headers.find(([k]) => k.toLowerCase() === name)?.[1];
}

/** 明文响应发送端：RES_DATA 受工作站的 ACK 流控，超出窗口时暂停本机响应。 */
class Out implements Sink {
  onResume: (() => void) | null = null;
  private inflight = 0;
  private paused = false;

  constructor(
    private readonly tx: (type: number, payload?: Uint8Array) => void,
    private readonly done: () => void,
  ) {}

  head(status: number, headers: Headers): void {
    this.tx(F.RES_HEAD, jsonBytes({ status, headers }));
  }

  write(data: Uint8Array): boolean {
    this.tx(F.RES_DATA, data);
    this.inflight += data.length;
    if (this.inflight >= RES_WINDOW) this.paused = true;
    return !this.paused;
  }

  end(): void {
    this.tx(F.RES_END);
    this.done();
  }

  fail(message: string): void {
    this.tx(F.ABORT, jsonBytes({ message }));
    this.done();
  }

  ack(n: number): void {
    this.inflight = Math.max(0, this.inflight - n);
    if (this.paused && this.inflight < RES_WINDOW) {
      this.paused = false;
      this.onResume?.();
    }
  }
}

/** 加密响应：本机响应拆成 [u32 长度][AES-GCM 记录] 序列，外层 HTTP 只暴露 200 + 密文。 */
class SealedOut implements Sink {
  private index = 0;

  constructor(
    private readonly out: Out,
    private readonly session: E2ESession,
    private readonly n: number,
    private readonly cors: Headers,
  ) {}

  get onResume(): (() => void) | null {
    return this.out.onResume;
  }

  set onResume(fn: (() => void) | null) {
    this.out.onResume = fn;
  }

  private seal(type: number, data?: Uint8Array): Buffer {
    const plain = Buffer.concat([Buffer.from([type]), data ?? Buffer.alloc(0)]);
    const ct = sealRecord(this.session.kS2C, this.session.sid, this.n, this.index++, plain);
    return Buffer.concat([Buffer.from(u32Bytes(ct.length)), ct]);
  }

  head(status: number, headers: Headers): void {
    this.out.head(200, [['content-type', 'application/octet-stream'], ['cache-control', 'no-store'], ...this.cors]);
    this.out.write(this.seal(R.HEAD, jsonBytes({ status, headers } satisfies E2EResHead)));
  }

  write(data: Uint8Array): boolean {
    let ok = true;
    for (let off = 0; off < data.length; off += E2E_CHUNK) ok = this.out.write(this.seal(R.DATA, data.subarray(off, off + E2E_CHUNK)));
    return ok;
  }

  end(): void {
    this.out.write(this.seal(R.END));
    this.out.end();
  }

  fail(message: string): void {
    this.out.fail(message);
  }
}

export function workstationHttpBase(url: string): string {
  const u = new URL(url);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`工作站地址协议无效: ${u.protocol}`);
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

export class WorkstationAgent {
  private readonly identity: RelayIdentity;
  private readonly e2e: E2EServer;
  private readonly httpBase: string;
  private readonly streams = new Map<number, HostStream>();
  private socket: WebSocket | null = null;
  private connected = false;
  private stopped = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastLogged = '';

  constructor(
    private readonly relay: WorkstationTunnelConfig,
    private readonly hostId: string,
    private readonly localPort: number,
  ) {
    this.identity = identityFromHostKey(relay.hostKey);
    this.e2e = new E2EServer(this.identity, hostId);
    this.httpBase = workstationHttpBase(relay.url);
  }


  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close(1000, 'Host 退出');
  }

  private log(message: string): void {
    if (message === this.lastLogged) return;
    this.lastLogged = message;
    console.log(`[tandem] workstation: ${message}`);
  }

  private connect(): void {
    if (this.stopped) return;
    const tunnelUrl = new URL(this.httpBase);
    tunnelUrl.protocol = tunnelUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    tunnelUrl.pathname = `${tunnelUrl.pathname.replace(/\/+$/, '')}${TUNNEL_PATH}`;
    const ws = new WebSocket(tunnelUrl.toString(), { maxPayload: MAX_FRAME, handshakeTimeout: 15_000 });
    this.socket = ws;
    let ready = false;
    let alive = true;

    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, HEARTBEAT_MS);
    ws.on('pong', () => (alive = true));

    ws.on('message', (data: RawData, isBinary: boolean) => {
      alive = true;
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (!isBinary) {
        const msg = parseJson<{ type: string }>(buf);
        if (msg.type === 'challenge') {
          const { nonce } = msg as unknown as TunnelChallenge;
          const hello: TunnelHello = {
            type: 'hello',
            v: TUNNEL_VERSION,
            hostId: this.hostId,
            pub: b64u(this.identity.publicRaw),
            sig: b64u(signWith(this.identity, registrationMessage(nonce, this.hostId))),
          };
          ws.send(JSON.stringify(hello));
        } else if (msg.type === 'ready') {
          ready = true;
          this.connected = true;
          this.attempt = 0;
          this.log(`已连接 ${this.httpBase}`);
        }
        return;
      }
      if (!ready) return;
      const frame = decodeFrame(buf);
      if (frame) this.onFrame(frame);
    });

    ws.on('error', (err) => {
      if (!ready) this.log(`连接失败：${err.message}`);
    });
    ws.on('close', (code, reason) => {
      clearInterval(heartbeat);
      const wasReady = ready;
      this.connected = false;
      for (const stream of [...this.streams.values()]) stream.abort();
      this.streams.clear();
      if (this.socket === ws) this.socket = null;
      if (this.stopped) return;
      if (code === 4403) {
        this.log('工作站拒绝：hostId 已绑定其他公钥（请核对工作站凭据，或重新加入）');
      } else if (wasReady) {
        this.log(`连接断开（${code}${reason.length ? ` ${reason.toString()}` : ''}），将重连`);
      }
      // 4409：同一密钥的另一实例已接管，避免两个实例互相顶替
      const base = Math.max(code === 4409 ? 15_000 : 0, Math.min(60_000, 1000 * 2 ** this.attempt++));
      this.timer = setTimeout(() => this.connect(), base * (0.5 + Math.random() * 0.5));
    });
  }

  private send(type: number, id: number, payload?: Uint8Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encodeFrame(type, id, payload));
  }

  private onFrame(frame: Frame): void {
    const id = frame.streamId;
    if (frame.type === F.REQ_HEAD) {
      this.startHttp(id, parseJson<{ method: string; url: string; headers: Headers }>(frame.payload));
    } else if (frame.type === F.WS_OPEN) {
      this.startWs(id, parseJson<{ url: string; headers: Headers }>(frame.payload));
    } else {
      this.streams.get(id)?.onFrame(frame);
    }
  }

  // ---------- 响应发送端 ----------

  private out(id: number): Out {
    return new Out((type, payload) => this.send(type, id, payload), () => this.streams.delete(id));
  }

  /** 把一个小响应整体发完（不登记流）。 */
  private respond(id: number, status: number, headers: Headers, body?: Uint8Array): void {
    const out = this.out(id);
    out.head(status, headers);
    if (body?.length) out.write(body);
    out.end();
  }

  private respondJson(id: number, status: number, value: unknown, extra: Headers = []): void {
    const body = jsonBytes(value);
    this.respond(id, status, [['content-type', 'application/json; charset=utf-8'], ['content-length', String(body.length)], ...extra], body);
  }

  // ---------- 本机回环 HTTP ----------

  private loopback(
    head: { method: string; url: string; headers: Headers },
    sink: Sink,
  ): { write(chunk: Uint8Array): void; end(): void; destroy(): void } {
    const flat: string[] = [];
    for (const [k, v] of head.headers) {
      const lower = k.toLowerCase();
      if (lower === 'host' || HOP_BY_HOP.has(lower)) continue;
      flat.push(k, v);
    }
    flat.push('Host', `127.0.0.1:${this.localPort}`);
    const req = http.request({ host: '127.0.0.1', port: this.localPort, method: head.method, path: head.url, headers: flat });
    req.on('response', (res) => {
      const headers: Headers = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        if (!HOP_BY_HOP.has(res.rawHeaders[i]!.toLowerCase())) headers.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
      }
      sink.head(res.statusCode ?? 502, headers);
      sink.onResume = () => res.resume();
      res.on('data', (chunk: Buffer) => {
        if (!sink.write(chunk)) res.pause();
      });
      res.on('end', () => sink.end());
      res.on('error', () => sink.fail('本机响应中断'));
      res.on('aborted', () => sink.fail('本机响应中断'));
    });
    req.on('error', (err) => sink.fail(`本机请求失败：${err.message}`));
    return {
      write: (chunk) => void req.write(chunk),
      end: () => void req.end(),
      destroy: () => void req.destroy(),
    };
  }

  private startHttp(id: number, head: { method: string; url: string; headers: Headers }): void {
    const pathname = head.url.split('?')[0] ?? '';
    if (pathname.startsWith(E2E_PREFIX)) {
      this.startE2EHttp(id, head);
      return;
    }
    if (this.relay.requireE2E) {
      this.respondJson(id, 403, { error: '该 Host 仅接受端到端加密连接（/_e2e）' }, [['access-control-allow-origin', '*']]);
      return;
    }
    const out = this.out(id);
    const req = this.loopback(head, out);
    this.streams.set(id, {
      onFrame: (frame) => {
        if (frame.type === F.REQ_DATA) req.write(frame.payload);
        else if (frame.type === F.REQ_END) req.end();
        else if (frame.type === F.RES_ACK) out.ack(readU32(frame.payload));
        else if (frame.type === F.ABORT) this.cancel(id, req);
      },
      abort: () => this.cancel(id, req),
    });
  }

  private cancel(id: number, req: { destroy(): void }): void {
    req.destroy();
    this.streams.delete(id);
  }

  // ---------- 端到端加密 HTTP ----------

  private corsHeaders(head: { headers: Headers }): Headers {
    return [
      ['access-control-allow-origin', hasHeader(head.headers, 'origin') ?? '*'],
      ['vary', 'Origin'],
      ['access-control-allow-methods', 'POST, OPTIONS'],
      ['access-control-allow-headers', 'Content-Type'],
      ['access-control-max-age', '600'],
    ];
  }

  private startE2EHttp(id: number, head: { method: string; url: string; headers: Headers }): void {
    const url = new URL(head.url, 'http://workstation');
    const cors = this.corsHeaders(head);
    if (head.method === 'OPTIONS') {
      this.respond(id, 204, cors);
      return;
    }
    if (head.method !== 'POST' || (url.pathname !== E2E_HELLO && url.pathname !== E2E_HTTP)) {
      this.respondJson(id, 404, { error: 'Not Found' }, cors);
      return;
    }
    const limit = url.pathname === E2E_HELLO ? 4096 : E2E_MAX_RECORD;
    const chunks: Buffer[] = [];
    let size = 0;
    this.streams.set(id, {
      onFrame: (frame) => {
        if (frame.type === F.REQ_DATA) {
          size += frame.payload.length;
          if (size > limit) {
            this.streams.delete(id);
            this.respondJson(id, 413, { error: '请求过大' }, cors);
            return;
          }
          chunks.push(Buffer.from(frame.payload));
        } else if (frame.type === F.REQ_END) {
          const body = Buffer.concat(chunks);
          this.streams.delete(id);
          if (url.pathname === E2E_HELLO) this.e2eHello(id, body, cors);
          else this.e2eRequest(id, url, body, cors);
        } else if (frame.type === F.ABORT) {
          this.streams.delete(id);
        }
      },
      abort: () => this.streams.delete(id),
    });
  }

  private e2eHello(id: number, body: Buffer, cors: Headers): void {
    try {
      this.respondJson(id, 200, this.e2e.hello(body), [...cors, ['cache-control', 'no-store']]);
    } catch (err) {
      this.respondJson(id, 400, { error: (err as Error).message }, cors);
    }
  }

  private e2eRequest(id: number, url: URL, body: Buffer, cors: Headers): void {
    const sid = url.searchParams.get('sid') ?? '';
    const n = Number(url.searchParams.get('n'));
    const session = this.e2e.session(sid);
    if (!session) {
      // 410：Host 重启或会话过期，客户端应重新握手
      this.respondJson(id, 410, { error: '加密会话不存在或已过期，请重新握手' }, cors);
      return;
    }
    if (!this.e2e.acceptCounter(session, n)) {
      this.respondJson(id, 409, { error: '请求计数无效或重复' }, cors);
      return;
    }
    let env: { head: E2EHttpHead; body: Uint8Array };
    try {
      env = unpackEnvelope<E2EHttpHead>(openRecord(session.kC2S, session.sid, n, 0, body));
    } catch {
      this.respondJson(id, 400, { error: '解密失败' }, cors);
      return;
    }

    const out = this.out(id);
    const req = this.loopback(
      { method: env.head.method, url: env.head.path, headers: Object.entries(env.head.headers ?? {}) },
      new SealedOut(out, session, n, cors),
    );
    if (env.body.length) req.write(env.body);
    req.end();
    this.streams.set(id, {
      onFrame: (frame) => {
        if (frame.type === F.RES_ACK) out.ack(readU32(frame.payload));
        else if (frame.type === F.ABORT) this.cancel(id, req);
      },
      abort: () => this.cancel(id, req),
    });
  }

  // ---------- WebSocket ----------

  private startWs(id: number, head: { url: string; headers: Headers }): void {
    const pathname = head.url.split('?')[0] ?? '';
    let target = head.url;
    // 加密 WS：消息体与首个信封都由客户端会话密钥保护
    let session: E2ESession | undefined;
    let counter = 0;
    if (pathname.startsWith(E2E_PREFIX)) {
      const url = new URL(head.url, 'http://workstation');
      session = this.e2e.session(url.searchParams.get('sid'));
      counter = Number(url.searchParams.get('n'));
      const opened = (() => {
        if (url.pathname !== E2E_WS || !session || !this.e2e.acceptCounter(session, counter)) return null;
        try {
          return unpackEnvelope<E2EWsHead>(openRecord(session.kC2S, session.sid, counter, 0, unb64u(url.searchParams.get('o') ?? ''))).head;
        } catch {
          return null;
        }
      })();
      if (!opened || typeof opened.path !== 'string' || !opened.path.startsWith('/')) {
        this.send(F.WS_REJECT, id, jsonBytes({ status: session ? 400 : 410 }));
        return;
      }
      target = opened.path;
    } else if (this.relay.requireE2E) {
      this.send(F.WS_REJECT, id, jsonBytes({ status: 403 }));
      return;
    }

    const local = new WebSocket(`ws://127.0.0.1:${this.localPort}${target}`, { maxPayload: MAX_FRAME });
    let opened = false;
    let c2sIndex = 1;
    let s2cIndex = 0;
    const toClient = (data: Buffer, isBinary: boolean): Uint8Array => {
      if (!session) return wsMsgPayload(data, isBinary);
      const plain = Buffer.concat([Buffer.from([isBinary ? WS_BINARY : WS_TEXT]), data]);
      return wsMsgPayload(sealRecord(session.kS2C, session.sid, counter, s2cIndex++, plain), true);
    };

    local.on('open', () => {
      opened = true;
      this.send(F.WS_OPENED, id);
    });
    local.on('unexpected-response', (_req, res) => {
      res.resume();
      this.send(F.WS_REJECT, id, jsonBytes({ status: res.statusCode ?? 502 }));
      this.streams.delete(id);
    });
    local.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      this.send(F.WS_MSG, id, toClient(buf, isBinary));
    });
    local.on('close', (code, reason) => {
      if (opened) this.send(F.WS_CLOSE, id, jsonBytes({ code, reason: reason.toString() }));
      this.streams.delete(id);
    });
    local.on('error', () => {
      if (!opened) {
        this.send(F.WS_REJECT, id, jsonBytes({ status: 502 }));
        this.streams.delete(id);
      }
    });

    this.streams.set(id, {
      onFrame: (frame) => {
        if (frame.type === F.WS_MSG && local.readyState === WebSocket.OPEN) {
          const binary = frame.payload[0] === 1;
          const data = Buffer.from(frame.payload.subarray(1));
          if (!session) {
            local.send(binary ? data : data.toString('utf8'), { binary });
            return;
          }
          try {
            const plain = openRecord(session.kC2S, session.sid, counter, c2sIndex++, data);
            const isBin = plain[0] === WS_BINARY;
            const payload = plain.subarray(1);
            local.send(isBin ? payload : payload.toString('utf8'), { binary: isBin });
          } catch {
            // 密文被篡改、丢失或重放：直接断开
            local.terminate();
          }
        } else if (frame.type === F.WS_CLOSE) {
          const info = parseJson<{ code?: number }>(frame.payload);
          local.close(info.code && info.code >= 1000 && info.code < 5000 && info.code !== 1005 && info.code !== 1006 ? info.code : 1000);
        } else if (frame.type === F.ABORT) {
          local.terminate();
        }
      },
      abort: () => local.terminate(),
    });
  }
}
