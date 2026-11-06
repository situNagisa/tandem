// relay 服务：Host 隧道入口 + 客户端 /h/<hostId>/... 转发。日志只记录注册/断开事件，绝不记录 URL、头部或 body。
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import {
  TUNNEL_PATH,
  TUNNEL_VERSION,
  b64u,
  isValidHostId,
  parseJson,
  registrationMessage,
  unb64u,
  type TunnelChallenge,
  type TunnelHello,
} from './wire.js';
import { Counter, DEFAULT_LIMITS, type RelayLimits } from './limits.js';
import { Registry } from './registry.js';
import { HostTunnel } from './tunnel.js';

export interface RelayOptions {
  dataDir: string;
  trustProxy?: boolean;
  limits?: Partial<RelayLimits>;
}

const HELLO_TIMEOUT_MS = 10_000;
const TUNNEL_PING_MS = 20_000;
const MAX_FRAME = 40 * 1024 * 1024;

function shortId(hostId: string): string {
  return `${hostId.slice(0, 8)}…`;
}

function ed25519Public(raw: Uint8Array) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw) }, format: 'jwk' });
}

export async function createRelay(options: RelayOptions): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const registry = new Registry(options.dataDir);
  const tunnels = new Map<string, HostTunnel>();
  const clientConns = new Counter();
  const tunnelConns = new Counter();
  const trustProxy = options.trustProxy === true;

  const app = Fastify({ logger: false, trustProxy, bodyLimit: 64 * 1024 * 1024 });
  // 请求体一律不解析，原样流给 Host
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null));

  const clientWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const tunnelWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  const ipOf = (req: IncomingMessage): string => {
    if (trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const value = Array.isArray(xff) ? xff[xff.length - 1] : xff;
      const last = value?.split(',').pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  /** 解析 /h/<hostId>/rest?query → { hostId, url }。 */
  const parseClientUrl = (raw: string): { hostId: string; url: string } | null => {
    const match = /^\/h\/([^/?#]+)(\/[^#]*|\?[^#]*)?$/.exec(raw);
    if (!match || !isValidHostId(match[1])) return null;
    let rest = match[2] ?? '/';
    if (rest.startsWith('?')) rest = `/${rest}`;
    return { hostId: match[1], url: rest };
  };

  app.get('/healthz', async () => ({ ok: true, hostsOnline: tunnels.size }));

  const proxy = (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): void => {
    reply.hijack();
    const raw = req.raw;
    const res = reply.raw;
    const fail = (status: number, message: string) => {
      const body = JSON.stringify({ error: message });
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'access-control-allow-origin': '*',
      });
      res.end(body);
    };
    const target = parseClientUrl(raw.url ?? '');
    if (!target) return fail(404, 'Not Found');
    const tunnel = tunnels.get(target.hostId);
    if (!tunnel) return fail(502, 'Host 不在线');
    const ip = ipOf(raw);
    if (!clientConns.tryAcquire(ip, limits.maxConnsPerIp)) return fail(429, '连接数过多');
    res.on('close', () => clientConns.release(ip));
    tunnel.proxyHttp(raw, res, target.url);
  };
  app.all('/h/:hostId', proxy);
  app.all('/h/:hostId/*', proxy);

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not Found' }));

  // ---------- Host 隧道注册 ----------
  const handleTunnel = (ws: WebSocket, ip: string): void => {
    const challenge = randomBytes(32).toString('base64url');
    const release = () => tunnelConns.release(ip);
    let hostId: string | null = null;
    let tunnel: HostTunnel | null = null;

    const timer = setTimeout(() => ws.close(4408, '握手超时'), HELLO_TIMEOUT_MS);
    ws.send(JSON.stringify({ type: 'challenge', v: TUNNEL_VERSION, nonce: challenge } satisfies TunnelChallenge));

    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);
      try {
        if (isBinary) throw new Error('hello 必须是文本帧');
        const hello = parseJson<TunnelHello>(Buffer.from(data as Buffer));
        if (hello.type !== 'hello' || !isValidHostId(hello.hostId)) throw new Error('hello 无效');
        const pub = unb64u(hello.pub);
        if (pub.length !== 32) throw new Error('公钥长度无效');
        const ok = verify(null, registrationMessage(challenge, hello.hostId), ed25519Public(pub), unb64u(hello.sig));
        if (!ok) {
          ws.close(4401, '签名无效');
          return;
        }
        const known = registry.has(hello.hostId);
        if (!known && registry.size >= limits.maxHosts) {
          ws.close(4429, '该 relay 已达 Host 数量上限');
          return;
        }
        if (registry.bind(hello.hostId, hello.pub) === 'conflict') {
          console.warn(`[relay] 拒绝 ${shortId(hello.hostId)}：hostId 已绑定其他公钥`);
          ws.close(4403, 'hostId 已绑定其他公钥');
          return;
        }
        hostId = hello.hostId;
      } catch (err) {
        ws.close(4400, (err as Error).message.slice(0, 100));
        return;
      }

      const previous = tunnels.get(hostId);
      tunnel = new HostTunnel(hostId, ws, { maxStreams: limits.maxStreamsPerHost, bytesPerSec: limits.bytesPerSec }, clientWss);
      tunnels.set(hostId, tunnel);
      if (previous) {
        previous.closeAll('Host 已在别处重连');
        previous.socket.close(4409, '被同一公钥的新连接取代');
      }
      ws.send(JSON.stringify({ type: 'ready' }));
      console.log(`[relay] Host 上线 ${shortId(hostId)}（在线 ${tunnels.size}）`);
    });

    let alive = true;
    ws.on('pong', () => (alive = true));
    const pinger = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, TUNNEL_PING_MS);
    pinger.unref();

    ws.on('close', () => {
      clearTimeout(timer);
      clearInterval(pinger);
      release();
      if (hostId && tunnel) {
        tunnel.closeAll('Host 已断开');
        if (tunnels.get(hostId) === tunnel) {
          tunnels.delete(hostId);
          console.log(`[relay] Host 下线 ${shortId(hostId)}（在线 ${tunnels.size}）`);
        }
      }
    });
    ws.on('error', () => ws.terminate());
  };

  const refuse = (socket: Duplex, status: string): void => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const rawUrl = req.url ?? '';
    const ip = ipOf(req);
    if (rawUrl.split('?')[0] === TUNNEL_PATH) {
      if (!tunnelConns.tryAcquire(ip, limits.maxTunnelsPerIp)) return refuse(socket, '429 Too Many Requests');
      tunnelWss.handleUpgrade(req, socket, head, (ws) => handleTunnel(ws, ip));
      return;
    }
    const target = parseClientUrl(rawUrl);
    if (!target) return refuse(socket, '404 Not Found');
    const tunnel = tunnels.get(target.hostId);
    if (!tunnel) return refuse(socket, '502 Bad Gateway');
    if (!clientConns.tryAcquire(ip, limits.maxConnsPerIp)) return refuse(socket, '429 Too Many Requests');
    tunnel.proxyWebSocket(req, socket, head, target.url, () => clientConns.release(ip));
  });

  const close = async () => {
    for (const tunnel of tunnels.values()) tunnel.socket.close(1001, 'relay 关闭');
    registry.flush();
    await app.close();
  };
  return { app, close };
}
