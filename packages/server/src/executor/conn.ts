// 工作站侧的执行器连接：握手时做响应方（发 WELCOME、校验 AUTH、首次登记），之后复用流、做接收窗口与心跳。
// 线协议见 docs/features/executor.md，原语在 ./wire.ts。
import { diffieHellman } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import * as P from './wire.js';

const { T } = P;
const HEARTBEAT_MS = 15_000;
const IDLE_MS = 45_000;
const EMPTY = Buffer.alloc(0);

export interface ExecutorAuth {
  /** 工作站的 Ed25519 身份，WELCOME 用它签名。 */
  identity: P.KeyPair;
  /** 已登记主机的执行器公钥；未登记返回 undefined。 */
  execPubOf(hostId: string): Buffer | undefined;
  /** 首次登记：令牌有效时登记执行器并返回 hostId；否则抛出原因。 */
  enroll(req: { token: string; execPub: Buffer; name: string; platform: string }): Promise<string>;
}

export interface StreamHandlers {
  onStdout?(chunk: Buffer): void;
  onStderr?(chunk: Buffer): void;
  onData?(chunk: Buffer): void;
}

interface Stream {
  handlers: StreamHandlers;
  resolve(end: Record<string, any>): void;
  reject(err: Error): void;
  /** 已收到的 OUT/ERR/DATA 字节，用于检查窗口。 */
  received: number;
  /** 已经通过 FLOW 确认的字节。 */
  acked: number;
  /** 已消费、尚未确认的字节。 */
  unconsumed: number;
  /** 请求体（工作站到执行器）还能发送的字节数，由执行器的 FLOW 增加。 */
  credit: number;
  /** 等待 credit 或流结束的发送方。 */
  wake: Array<() => void>;
  done: boolean;
  detach?: () => void;
}

type Phase = 'hello' | 'auth' | 'enrolling' | 'ready' | 'closed';

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

export class ExecutorConn {
  private phase: Phase = 'hello';
  private boundHostId = '';
  private helloHostId = '';
  private transcript: Buffer = EMPTY;
  private recv?: P.Aead;
  private send?: P.Aead;
  private nextStreamId = 1;
  private lastSeen = Date.now();
  private timer?: NodeJS.Timeout;
  private readonly streams = new Map<number, Stream>();
  private readonly closeHooks: Array<() => void> = [];
  private readonly established: Promise<ExecutorConn>;
  private settleOk!: (conn: ExecutorConn) => void;
  private settleErr!: (err: Error) => void;

  private constructor(
    private readonly sock: WebSocket,
    private readonly auth: ExecutorAuth,
  ) {
    this.established = new Promise((resolve, reject) => {
      this.settleOk = resolve;
      this.settleErr = reject;
    });
  }

  /** 在已升级的 WebSocket 上完成握手；认证通过后 resolve。 */
  static accept(sock: WebSocket, auth: ExecutorAuth): Promise<ExecutorConn> {
    const conn = new ExecutorConn(sock, auth);
    sock.on('message', (data: RawData, isBinary: boolean) => conn.onMessage(toBuffer(data), isBinary));
    sock.on('close', () => conn.shut('连接已关闭'));
    sock.on('error', () => {});
    return conn.established;
  }

  get hostId(): string {
    return this.boundHostId;
  }

  /**
   * 发起一次请求。END 带 error 时 reject，错误对象的 code 为协议错误码（ENOENT 等）。
   * body 作为请求体按执行器的 FLOW 分帧发送，发完发 END。
   * signal 中断时发送 CANCEL，并以 AbortError reject，之后该流的帧被忽略。
   */
  request(
    op: string,
    args: Record<string, unknown> = {},
    handlers: StreamHandlers = {},
    signal?: AbortSignal,
    body?: Buffer,
  ): Promise<Record<string, any>> {
    if (this.phase !== 'ready') return Promise.reject(new Error('执行器未就绪'));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextStreamId++;
    return new Promise((resolve, reject) => {
      const stream: Stream = {
        handlers,
        resolve,
        reject,
        received: 0,
        acked: 0,
        unconsumed: 0,
        credit: P.WINDOW,
        wake: [],
        done: false,
      };
      if (signal) {
        const onAbort = () => {
          this.streams.delete(id);
          stream.detach = undefined;
          this.finishStream(stream);
          reject(abortError());
          if (this.phase === 'ready') this.sendEnc(T.CANCEL, id);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        stream.detach = () => signal.removeEventListener('abort', onAbort);
      }
      this.sendEnc(T.REQ, id, Buffer.from(JSON.stringify({ op, ...args }), 'utf8'));
      this.streams.set(id, stream);
      if (body) this.sendBody(id, stream, body).catch((err) => this.shut(String(err)));
    });
  }

  private async sendBody(id: number, s: Stream, body: Buffer): Promise<void> {
    for (let off = 0; off < body.length; off += P.FRAME_MAX) {
      const part = body.subarray(off, Math.min(off + P.FRAME_MAX, body.length));
      while (s.credit < part.length) {
        if (s.done) return;
        await new Promise<void>((resolve) => s.wake.push(resolve));
      }
      if (s.done) return;
      s.credit -= part.length;
      this.sendEnc(T.DATA, id, part);
    }
    if (!s.done) this.sendEnc(T.END, id);
  }

  private finishStream(s: Stream): void {
    s.done = true;
    for (const w of s.wake.splice(0)) w();
  }

  close(): void {
    this.shut('连接已关闭');
  }

  /** 连接断开（握手失败或运行中断开）后调用一次。 */
  onClose(fn: () => void): void {
    this.closeHooks.push(fn);
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.phase === 'closed' || this.phase === 'enrolling') return;
    try {
      if (!isBinary) throw new Error('期望二进制帧');
      if (this.phase === 'hello') this.onHello(data);
      else if (this.phase === 'auth') void this.onAuth(data).catch((err: unknown) => this.shut(errorText(err)));
      else this.onFrame(data);
    } catch (err) {
      this.shut(errorText(err));
    }
  }

  private onHello(data: Buffer): void {
    const f = P.parseFrame(data);
    if (f.type !== T.HELLO || f.streamId !== 0) throw new Error('期望 HELLO');
    const hello = JSON.parse(f.payload.toString('utf8')) as { eph: string; hostId?: string };
    const hostId = hello.hostId ?? '';
    if (hostId && !this.auth.execPubOf(hostId)) throw new Error('未知主机');
    const eph = P.genKeyPair('x25519');
    const wsEph = P.b64(eph.pub);
    const tr = P.transcript(hostId, hello.eph, wsEph);
    this.sock.send(
      P.frame(
        T.WELCOME,
        0,
        JSON.stringify({
          v: 1,
          eph: wsEph,
          pub: P.b64(this.auth.identity.pub),
          sig: P.signTranscript(this.auth.identity.priv, tr),
          caps: P.OPS,
        }),
      ),
    );
    const shared = diffieHellman({
      privateKey: eph.priv,
      publicKey: P.publicKeyFrom(P.unb64(hello.eph), 'x25519'),
    });
    const keys = P.deriveKeys(shared, tr);
    this.recv = new P.Aead(keys.up, 1);
    this.send = new P.Aead(keys.down, 2);
    this.helloHostId = hostId;
    this.transcript = tr;
    this.phase = 'auth';
  }

  private async onAuth(data: Buffer): Promise<void> {
    const f = P.parseFrame(this.recv!.open(data));
    if (f.type !== T.AUTH) throw new Error('期望 AUTH');
    const auth = JSON.parse(f.payload.toString('utf8')) as {
      hostId?: string;
      sig: string;
      token?: string;
      execPub?: string;
      name?: string;
      platform?: string;
    };
    let hostId: string;
    if (this.helloHostId === '') {
      if (!auth.execPub) throw new Error('首次登记缺少 execPub');
      const execPub = P.unb64(auth.execPub);
      if (!P.verifyTranscript(execPub, this.transcript, auth.sig)) throw new Error('AUTH 签名无效');
      this.phase = 'enrolling';
      hostId = await this.auth.enroll({
        token: auth.token ?? '',
        execPub,
        name: auth.name ?? '',
        platform: auth.platform ?? '',
      });
      if (this.phase !== 'enrolling') return;
    } else {
      const execPub = this.auth.execPubOf(this.helloHostId);
      if (!execPub || auth.hostId !== this.helloHostId) throw new Error('AUTH 的 hostId 不符');
      if (!P.verifyTranscript(execPub, this.transcript, auth.sig)) throw new Error('AUTH 签名无效');
      hostId = this.helloHostId;
    }
    this.sendEnc(T.AUTH_OK, 0, Buffer.from(JSON.stringify({ hostId }), 'utf8'));
    this.boundHostId = hostId;
    this.phase = 'ready';
    this.lastSeen = Date.now();
    this.timer = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.timer.unref();
    this.settleOk(this);
  }

  private onFrame(data: Buffer): void {
    const f = P.parseFrame(this.recv!.open(data));
    this.lastSeen = Date.now();
    switch (f.type) {
      case T.PING:
        this.sendEnc(T.PONG, 0);
        return;
      case T.PONG:
        return;
      case T.OUT:
      case T.ERR:
      case T.DATA:
        this.onBody(f);
        return;
      case T.FLOW: {
        const s = this.streams.get(f.streamId);
        if (!s) return;
        if (f.payload.length !== 4) throw new Error('FLOW 长度错误');
        s.credit += f.payload.readUInt32BE(0);
        for (const w of s.wake.splice(0)) w();
        return;
      }
      case T.END:
        this.onEnd(f);
        return;
      default:
        throw new Error(`未知帧类型 ${f.type}`);
    }
  }

  private onBody(f: P.Frame): void {
    if (f.payload.length > P.FRAME_MAX) throw new Error('数据帧超过 64 KiB');
    const s = this.streams.get(f.streamId);
    if (!s) return;
    const n = f.payload.length;
    if (s.received + n > P.WINDOW + s.acked) throw new Error(`流 ${f.streamId} 超出流控窗口`);
    s.received += n;
    s.unconsumed += n;
    if (f.type === T.OUT) s.handlers.onStdout?.(f.payload);
    else if (f.type === T.ERR) s.handlers.onStderr?.(f.payload);
    else s.handlers.onData?.(f.payload);
    if (s.unconsumed >= P.FLOW_THRESHOLD) {
      this.sendEnc(T.FLOW, f.streamId, P.u32(s.unconsumed));
      s.acked += s.unconsumed;
      s.unconsumed = 0;
    }
  }

  private onEnd(f: P.Frame): void {
    const s = this.streams.get(f.streamId);
    if (!s) return;
    this.streams.delete(f.streamId);
    s.detach?.();
    this.finishStream(s);
    const end = f.payload.length > 0 ? (JSON.parse(f.payload.toString('utf8')) as Record<string, any>) : {};
    if (end.error) {
      s.reject(Object.assign(new Error(end.error.message), { code: end.error.code }));
    } else {
      s.resolve(end);
    }
  }

  private tick(): void {
    if (Date.now() - this.lastSeen > IDLE_MS) {
      this.shut('心跳超时');
      return;
    }
    this.sendEnc(T.PING, 0);
  }

  private sendEnc(type: number, streamId: number, payload: Buffer = EMPTY): void {
    this.sock.send(this.send!.seal(P.frame(type, streamId, payload)));
  }

  private shut(reason: string): void {
    if (this.phase === 'closed') return;
    const handshaking = this.phase !== 'ready';
    this.phase = 'closed';
    clearInterval(this.timer);
    // 握手失败时把原因放进 close 帧，执行器的日志里能看到（如令牌无效、已过期）。
    if (handshaking) this.sock.close(4400, reason.slice(0, 60));
    else this.sock.terminate();
    const err = new Error(`执行器连接已断开：${reason}`);
    for (const s of this.streams.values()) {
      s.detach?.();
      this.finishStream(s);
      s.reject(err);
    }
    this.streams.clear();
    this.settleErr(err);
    for (const fn of this.closeHooks.splice(0)) fn();
  }
}
