// 伪造执行器客户端：只用于负面用例（错误签名、重放），以及录制一次成功握手的报文。
import { diffieHellman, type KeyObject } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import * as P from './protocol.js';

const { T } = P;

export interface FakeHandshakeOptions {
  url: string;
  hostId?: string;
  token?: string;
  execPub?: Buffer;
  signWith?: KeyObject;
  expectWsPub?: Buffer;
  name?: string;
  platform?: string;
  replay?: { hello: Buffer; auth: Buffer };
  timeoutMs?: number;
}

export interface FakeHandshakeResult {
  outcome: 'auth_ok' | 'closed' | 'timeout';
  hostId?: string;
  hello?: Buffer;
  auth?: Buffer;
  welcome?: Buffer;
}

type Next = { kind: 'msg'; data: Buffer } | { kind: 'closed' } | { kind: 'timeout' };

class Inbox {
  private readonly queue: Buffer[] = [];
  private readonly waiters: Array<(n: Next) => void> = [];
  private closed = false;

  constructor(sock: WebSocket) {
    sock.on('message', (data: RawData) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      const w = this.waiters.shift();
      if (w) w({ kind: 'msg', data: buf });
      else this.queue.push(buf);
    });
    sock.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w({ kind: 'closed' });
    });
    sock.on('error', () => {});
  }

  next(timeoutMs: number): Promise<Next> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve({ kind: 'msg', data: queued });
    if (this.closed) return Promise.resolve({ kind: 'closed' });
    return new Promise<Next>((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      const wake = (n: Next) => {
        clearTimeout(timer);
        resolve(n);
      };
      this.waiters.push(wake);
    });
  }
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.once('open', () => resolve(sock));
    sock.once('error', reject);
  });
}

export async function fakeHandshake(opts: FakeHandshakeOptions): Promise<FakeHandshakeResult> {
  const sock = await openSocket(opts.url);
  const inbox = new Inbox(sock);
  const timeoutMs = opts.timeoutMs ?? 5000;
  try {
    if (opts.replay) {
      sock.send(opts.replay.hello);
      const welcome = await inbox.next(timeoutMs);
      if (welcome.kind !== 'msg') return { outcome: welcome.kind, hello: opts.replay.hello };
      sock.send(opts.replay.auth);
      const after = await inbox.next(timeoutMs);
      return { outcome: after.kind === 'msg' ? 'auth_ok' : after.kind, hello: opts.replay.hello, auth: opts.replay.auth };
    }

    if (!opts.execPub || !opts.signWith) throw new Error('握手需要 execPub 与 signWith');
    const { execPub, signWith } = opts;
    const hostId = opts.hostId ?? '';
    const eph = P.genKeyPair('x25519');
    const ephB64 = P.b64(eph.pub);
    const hello = P.frame(T.HELLO, 0, JSON.stringify({ v: [1, 1], eph: ephB64, hostId, caps: P.OPS }));
    sock.send(hello);

    const first = await inbox.next(timeoutMs);
    if (first.kind !== 'msg') return { outcome: first.kind, hello };
    const wf = P.parseFrame(first.data);
    if (wf.type !== T.WELCOME) return { outcome: 'closed', hello, welcome: first.data };
    const welcome = JSON.parse(wf.payload.toString('utf8')) as { eph: string; pub: string; sig: string };
    const wsPub = P.unb64(welcome.pub);
    if (opts.expectWsPub && !wsPub.equals(opts.expectWsPub)) throw new Error('WELCOME 的工作站公钥与预期不符');
    const tr = P.transcript(hostId, ephB64, welcome.eph);
    if (!P.verifyTranscript(wsPub, tr, welcome.sig)) throw new Error('WELCOME 签名无效');

    const shared = diffieHellman({ privateKey: eph.priv, publicKey: P.publicKeyFrom(P.unb64(welcome.eph), 'x25519') });
    const keys = P.deriveKeys(shared, tr);
    const send = new P.Aead(keys.up, 1);
    const recv = new P.Aead(keys.down, 2);

    const body: Record<string, unknown> = {
      hostId,
      sig: P.signTranscript(signWith, tr),
    };
    if (!hostId) {
      Object.assign(body, {
        token: opts.token,
        execPub: execPub.toString('base64'),
        name: opts.name ?? 'fake-exec',
        platform: opts.platform ?? 'linux/amd64',
      });
    }
    const auth = send.seal(P.frame(T.AUTH, 0, JSON.stringify(body)));
    sock.send(auth);

    const reply = await inbox.next(timeoutMs);
    if (reply.kind !== 'msg') return { outcome: reply.kind, hello, auth, welcome: first.data };
    const rf = P.parseFrame(recv.open(reply.data));
    if (rf.type !== T.AUTH_OK) return { outcome: 'closed', hello, auth, welcome: first.data };
    return {
      outcome: 'auth_ok',
      hostId: (JSON.parse(rf.payload.toString('utf8')) as { hostId: string }).hostId,
      hello,
      auth,
      welcome: first.data,
    };
  } finally {
    sock.terminate();
  }
}
