// 一条主机隧道：把 HTTP 请求与 WebSocket 连接按 streamId 多路复用到本机 Host。
import { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  F,
  decodeFrame,
  encodeFrame,
  jsonBytes,
  parseJson,
  u32Bytes,
  wsMsgPayload,
  type Frame,
} from './wire.js';

// 令牌桶：带宽限流。允许透支，返回需要等待的毫秒数，由调用方暂停数据源而不是丢数据。
class Bucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  take(bytes: number): number {
    if (this.rate <= 0) return 0;
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    this.tokens -= bytes;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rate) * 1000);
  }
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'expect',
  'forwarded',
  'x-real-ip',
]);

/** 暂停数据源的缓冲阈值：隧道发送缓冲超过它就停读客户端。 */
const HIGH_WATER = 8 * 1024 * 1024;
const WS_CLIENT_HIGH_WATER = 16 * 1024 * 1024;
const WS_OPEN_TIMEOUT_MS = 15_000;

interface RelayStream {
  onFrame(frame: Frame): void;
  /** 隧道断开或被替换。 */
  abort(message: string): void;
}

export interface HostLimits {
  maxStreams: number;
  bytesPerSec: number;
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: message });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function sanitizeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1000;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class HostTunnel {
  private streams = new Map<number, RelayStream>();
  private nextId = 1;
  private readonly bucket: Bucket;
  private paused = false;

  constructor(
    readonly hostId: string,
    readonly socket: WebSocket,
    private readonly limits: HostLimits,
    private readonly wss: WebSocketServer,
  ) {
    this.bucket = new Bucket(limits.bytesPerSec, limits.bytesPerSec * 2);
    socket.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const buf = toBuffer(data);
      const frame = decodeFrame(buf);
      if (!frame) return;
      if (frame.type === F.WS_MSG) this.throttleTunnel(frame.payload.length);
      this.streams.get(frame.streamId)?.onFrame(frame);
    });
  }

  get streamCount(): number {
    return this.streams.size;
  }

  send(type: number, id: number, payload?: Uint8Array): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(encodeFrame(type, id, payload));
  }

  /** 隧道被关闭或替换：重置所有进行中的流。 */
  closeAll(message: string): void {
    for (const stream of [...this.streams.values()]) stream.abort(message);
    this.streams.clear();
  }

  /** Host→客户端的数据超出带宽预算时短暂停读隧道（TCP 反压到 Host）。 */
  private throttleTunnel(bytes: number): void {
    const delay = this.bucket.take(bytes);
    if (delay <= 0 || this.paused) return;
    this.paused = true;
    this.socket.pause();
    setTimeout(() => {
      this.paused = false;
      this.socket.resume();
    }, delay).unref();
  }

  private register(stream: RelayStream): number | null {
    if (this.streams.size >= this.limits.maxStreams) return null;
    const id = this.nextId++;
    if (this.nextId > 0xffffffff) this.nextId = 1;
    this.streams.set(id, stream);
    return id;
  }

  private release(id: number): void {
    this.streams.delete(id);
  }

  /** 暂停可读流，直到隧道缓冲与带宽预算都允许继续。 */
  private pauseUntilDrained(pause: () => void, resume: () => void, delay: number): void {
    pause();
    const check = () => {
      if (this.socket.bufferedAmount > HIGH_WATER / 2) setTimeout(check, 10).unref();
      else resume();
    };
    setTimeout(check, Math.max(delay, 5)).unref();
  }

  proxyHttp(req: IncomingMessage, res: ServerResponse, url: string): void {
    let id = 0;
    let finished = false;
    let headSent = false;

    const stream: RelayStream = {
      onFrame: (frame) => {
        switch (frame.type) {
          case F.RES_HEAD: {
            const head = parseJson<{ status: number; headers: [string, string][] }>(frame.payload);
            const flat: string[] = [];
            for (const [k, v] of head.headers) flat.push(k, v);
            res.writeHead(head.status, flat);
            res.flushHeaders();
            headSent = true;
            break;
          }
          case F.RES_DATA: {
            const n = frame.payload.length;
            const delay = this.bucket.take(n);
            // 写完（或客户端读走）才确认，Host 据此限制在途数据量；带宽超限时延后确认
            res.write(frame.payload, () => {
              if (finished) return;
              if (delay > 0) setTimeout(() => this.send(F.RES_ACK, id, u32Bytes(n)), delay).unref();
              else this.send(F.RES_ACK, id, u32Bytes(n));
            });
            break;
          }
          case F.RES_END:
            finished = true;
            this.release(id);
            res.end();
            break;
          case F.ABORT:
            finished = true;
            this.release(id);
            if (headSent) res.destroy();
            else jsonError(res, 502, 'Host 请求失败');
            break;
        }
      },
      abort: (message) => {
        finished = true;
        if (headSent) res.destroy();
        else jsonError(res, 502, message);
      },
    };

    const assigned = this.register(stream);
    if (assigned === null) {
      jsonError(res, 503, '该 Host 的并发请求过多');
      return;
    }
    id = assigned;

    const headers: [string, string][] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i]!;
      const lower = k.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower.startsWith('x-forwarded-')) continue;
      headers.push([k, req.rawHeaders[i + 1]!]);
    }
    this.send(F.REQ_HEAD, id, jsonBytes({ method: req.method, url, headers }));

    req.on('data', (chunk: Buffer) => {
      this.send(F.REQ_DATA, id, chunk);
      const delay = this.bucket.take(chunk.length);
      if (delay > 0 || this.socket.bufferedAmount > HIGH_WATER) {
        this.pauseUntilDrained(() => req.pause(), () => req.resume(), delay);
      }
    });
    req.on('end', () => {
      if (!finished) this.send(F.REQ_END, id);
    });
    // 客户端中途断开（含 SSE 订阅者离开）：通知 Host 取消
    res.on('close', () => {
      if (!finished) {
        finished = true;
        this.send(F.ABORT, id, jsonBytes({ message: '客户端已断开' }));
      }
      this.release(id);
    });
    req.on('error', () => res.destroy());
  }

  /** 客户端 WebSocket 升级：先问 Host 是否接受，再完成握手。 */
  proxyWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, url: string, onClose: () => void): void {
    let id = 0;
    let client: WebSocket | null = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      this.release(id);
      onClose();
    };
    const reject = (status: number) => {
      if (!socket.destroyed) {
        socket.write(
          `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\n\r\n`,
        );
        socket.destroy();
      }
      finish();
    };
    const timer = setTimeout(() => {
      this.send(F.ABORT, id, jsonBytes({ message: '握手超时' }));
      reject(504);
    }, WS_OPEN_TIMEOUT_MS);

    const stream: RelayStream = {
      onFrame: (frame) => {
        switch (frame.type) {
          case F.WS_OPENED:
            clearTimeout(timer);
            this.wss.handleUpgrade(req, socket as never, head, (ws) => {
              client = ws;
              this.wireClient(ws, id, finish);
            });
            break;
          case F.WS_REJECT: {
            clearTimeout(timer);
            reject(parseJson<{ status: number }>(frame.payload).status || 502);
            break;
          }
          case F.WS_MSG:
            if (client?.readyState === WebSocket.OPEN) {
              const binary = frame.payload[0] === 1;
              const data = frame.payload.subarray(1);
              client.send(binary ? data : Buffer.from(data).toString('utf8'), { binary });
              if (client.bufferedAmount > WS_CLIENT_HIGH_WATER) client.close(1013, '客户端读取过慢');
            }
            break;
          case F.WS_CLOSE: {
            clearTimeout(timer);
            const info = parseJson<{ code?: number; reason?: string }>(frame.payload);
            if (client) client.close(sanitizeCloseCode(info.code), (info.reason ?? '').slice(0, 100));
            else reject(502);
            finish();
            break;
          }
          case F.ABORT:
            clearTimeout(timer);
            if (client) client.terminate();
            else reject(502);
            finish();
            break;
        }
      },
      abort: () => {
        clearTimeout(timer);
        if (client) client.close(1012, 'Host 已断开');
        else reject(502);
        finish();
      },
    };

    const assigned = this.register(stream);
    if (assigned === null) {
      clearTimeout(timer);
      reject(503);
      return;
    }
    id = assigned;

    const headers: [string, string][] = [];
    const origin = req.headers.origin;
    if (typeof origin === 'string') headers.push(['origin', origin]);
    this.send(F.WS_OPEN, id, jsonBytes({ url, headers }));
    socket.on('close', () => {
      clearTimeout(timer);
      if (!done && !client) {
        this.send(F.ABORT, id, jsonBytes({ message: '客户端已断开' }));
        finish();
      }
    });
  }

  private wireClient(ws: WebSocket, id: number, finish: () => void): void {
    const pinger = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 25_000);
    pinger.unref();

    ws.on('message', (data, isBinary) => {
      const buf = toBuffer(data);
      this.send(F.WS_MSG, id, wsMsgPayload(buf, isBinary));
      const delay = this.bucket.take(buf.length);
      if (delay > 0 || this.socket.bufferedAmount > HIGH_WATER) {
        this.pauseUntilDrained(() => ws.pause(), () => ws.resume(), delay);
      }
    });
    ws.on('close', (code, reason) => {
      clearInterval(pinger);
      this.send(F.WS_CLOSE, id, jsonBytes({ code, reason: reason.toString().slice(0, 100) }));
      finish();
    });
    ws.on('error', () => ws.terminate());
  }
}
