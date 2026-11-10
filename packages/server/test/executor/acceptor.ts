// 工作站侧的执行器接入服务：只监听 127.0.0.1，供 M2/M3 对照测试使用。
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { ExecutorConn, type ExecutorAuth } from '../../src/executor/conn.js';
import * as P from '../../src/executor/wire.js';

export async function startAcceptor() {
  const identity = P.genKeyPair('ed25519');
  const hosts = new Map<string, Buffer>();
  const tokens = new Set<string>();
  const auth: ExecutorAuth = {
    identity,
    execPubOf: (hostId) => hosts.get(hostId),
    enroll({ token, execPub }) {
      if (!tokens.delete(token)) throw new Error('令牌无效');
      const hostId = randomBytes(12).toString('base64url');
      hosts.set(hostId, execPub);
      return hostId;
    },
  };
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: P.WS_PATH, perMessageDeflate: false });
  await once(wss, 'listening');
  const accepted: ExecutorConn[] = [];
  const waiting: Array<(conn: ExecutorConn) => void> = [];
  wss.on('connection', (sock: WebSocket) => {
    ExecutorConn.accept(sock, auth).then(
      (conn) => {
        const next = waiting.shift();
        if (next) next(conn);
        else accepted.push(conn);
      },
      () => sock.close(),
    );
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    issueToken() {
      const token = `ach_${randomBytes(24).toString('hex')}.${P.fingerprint(identity.pub)}`;
      tokens.add(token);
      return token;
    },
    nextConn(timeoutMs = 20_000): Promise<ExecutorConn> {
      const ready = accepted.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待执行器连接超时')), timeoutMs);
        waiting.push((conn) => {
          clearTimeout(timer);
          resolve(conn);
        });
      });
    },
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}
