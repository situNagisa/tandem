// 工作站侧测试服务端 + 执行器进程管理。只监听 127.0.0.1，只用于测试。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, diffieHellman, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { describe } from 'vitest';
import * as P from './protocol.js';

const { T } = P;

export type Target = 'linux' | 'windows';
export const TARGETS: Target[] = ['linux', 'windows'];
export const CMD_EXE = '/mnt/c/Windows/System32/cmd.exe';
export const WINDOWS_AVAILABLE = existsSync(CMD_EXE);
export const HEARTBEAT_MS = 15_000;
export const MIB = 1024 * 1024;

const DIST = fileURLToPath(new URL('../../../executor/dist/', import.meta.url));
const BINARIES: Record<Target, string> = {
  linux: path.join(DIST, 'tandem-exec-linux-amd64'),
  windows: path.join(DIST, 'tandem-exec-windows-amd64.exe'),
};

export function binaryFor(target: Target): string {
  const bin = BINARIES[target];
  if (!existsSync(bin)) throw new Error(`执行器二进制不存在：${bin}。请先运行 node scripts/build-executor.mjs`);
  return bin;
}

export function forEachTarget(name: string, body: (target: Target) => void): void {
  for (const target of TARGETS) {
    describe.skipIf(target === 'windows' && !WINDOWS_AVAILABLE)(`${name} [${target}]`, () => body(target));
  }
}

const cleanups: Array<() => unknown> = [];

export function onCleanup(fn: () => unknown): void {
  cleanups.push(fn);
}

export async function runCleanups(): Promise<void> {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch (err) {
      console.warn('清理失败：', err);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil<V>(
  fn: () => V | undefined | null | false,
  timeoutMs: number,
  label: string,
): Promise<V> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    await sleep(20);
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    return state !== 'Z';
  } catch {
    return false;
  }
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data as ArrayBuffer);
}

// ---------- 沙箱目录（Linux 或 Windows 临时目录）----------

export interface Home {
  native: string;
  local: string;
}

export interface Sandbox {
  target: Target;
  root: string;
  local: string;
  nat(...parts: string[]): string;
  loc(...parts: string[]): string;
  home(name: string): Home;
}

export function createSandbox(target: Target): Sandbox {
  let local: string;
  let root: string;
  let pl: path.PlatformPath;
  if (target === 'linux') {
    local = mkdtempSync(path.join(os.tmpdir(), 'tandem-exec-test-'));
    root = local;
    pl = path.posix;
  } else {
    const winTemp = execFileSync(CMD_EXE, ['/c', 'echo %TEMP%'], { cwd: '/mnt/c/Windows', encoding: 'utf8' }).trim();
    const base = execFileSync('wslpath', ['-u', winTemp], { encoding: 'utf8' }).trim();
    local = mkdtempSync(path.join(base, 'tandem-exec-test-'));
    root = execFileSync('wslpath', ['-w', local], { encoding: 'utf8' }).trim();
    pl = path.win32;
  }
  onCleanup(() => rmSync(local, { recursive: true, force: true }));
  return {
    target,
    root,
    local,
    nat: (...parts) => pl.join(root, ...parts),
    loc: (...parts) => path.join(local, ...parts),
    home(name) {
      const dir = path.join(local, name);
      mkdirSync(dir, { recursive: true });
      return { native: pl.join(root, name), local: dir };
    },
  };
}

// ---------- 执行器进程 ----------

export interface ExecutorProcess {
  readonly pid: number;
  readonly exited: boolean;
  readonly exitCode: number | null;
  output(): string;
  peakRssKb(): number | undefined;
  stop(): Promise<void>;
}

export interface ExecutorOptions {
  target: Target;
  sandbox: Sandbox;
  home: Home;
  server?: string;
  token?: string;
  /** 额外环境变量；Windows 目标会同时加入 WSLENV，值原样传给 Windows 进程。 */
  env?: Record<string, string>;
}

export function spawnExecutor(opts: ExecutorOptions, args: string[]): ExecutorProcess {
  const { target, sandbox, home } = opts;
  let bin = binaryFor(target);
  let image = '';
  if (target === 'windows') {
    // 从 WSL 杀掉包装进程不会结束 Windows 侧的 exe，所以复制成唯一文件名，停止时按镜像名结束。
    image = `tandem-exec-${randomBytes(4).toString('hex')}.exe`;
    bin = path.join(sandbox.local, image);
    copyFileSync(binaryFor('windows'), bin);
  }
  const extra = opts.env ?? {};
  const env: NodeJS.ProcessEnv = { ...process.env, TANDEM_EXEC_HOME: home.native, ...extra };
  if (target === 'windows') {
    env.WSLENV = [process.env.WSLENV, 'TANDEM_EXEC_HOME', ...Object.keys(extra)].filter(Boolean).join(':');
  }
  const child: ChildProcess = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  const collect = (chunk: Buffer) => {
    text = (text + chunk.toString('utf8')).slice(-64 * 1024);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  let exited = false;
  let exitCode: number | null = null;
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });
  const proc: ExecutorProcess = {
    pid: child.pid ?? -1,
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    output: () => text,
    peakRssKb() {
      if (target !== 'linux' || exited) return undefined;
      const status = readFileSync(`/proc/${child.pid}/status`, 'utf8');
      const m = /VmHWM:\s+(\d+) kB/.exec(status);
      return m ? Number(m[1]) : undefined;
    },
    async stop() {
      if (!exited) {
        child.kill('SIGTERM');
        const deadline = Date.now() + 5000;
        while (!exited && Date.now() < deadline) await sleep(50);
        if (!exited) child.kill('SIGKILL');
        while (!exited) await sleep(50);
      }
      if (target === 'windows') {
        try {
          execFileSync(CMD_EXE, ['/c', `taskkill /F /T /IM ${image}`], { cwd: '/mnt/c/Windows', stdio: 'ignore' });
        } catch {
          // 进程已不存在
        }
      }
    },
  };
  onCleanup(() => proc.stop());
  return proc;
}

export function startExecutor(opts: ExecutorOptions): ExecutorProcess {
  if (opts.token) {
    if (!opts.server) throw new Error('join 需要 server');
    return spawnExecutor(opts, ['join', '--server', opts.server, '--token', opts.token]);
  }
  return spawnExecutor(opts, ['run']);
}

// ---------- 工作站侧服务端 ----------

export interface HostRecord {
  hostId: string;
  execPub: Buffer;
  name?: string;
  platform?: string;
  conn?: Conn;
}

export interface RejectEvent {
  t: number;
  reason: string;
  hostId: string;
}

export interface StreamResult {
  id: number;
  op: string;
  end: any;
  error?: { code: string; message: string };
  stdout: Buffer;
  stderr: Buffer;
  data: Buffer;
  outBytes: number;
  errBytes: number;
  dataBytes: number;
  elapsedMs: number;
}

export interface StartOptions {
  timeoutMs?: number;
  collect?: boolean;
  onOut?: (chunk: Buffer) => void;
  onErr?: (chunk: Buffer) => void;
  onData?: (chunk: Buffer) => void;
}

export interface StreamHandle {
  readonly id: number;
  readonly done: Promise<StreamResult>;
  stats(): { outBytes: number; errBytes: number; dataBytes: number };
  sendData(buf: Buffer): Promise<void>;
  sendBody(src: Buffer | AsyncIterable<Buffer>): Promise<void>;
  endBody(): void;
  cancel(): void;
}

interface Stream {
  id: number;
  op: string;
  startedAt: number;
  received: number;
  returned: number;
  pending: number;
  credit: number;
  waiters: Array<() => void>;
  finished: boolean;
  collect: boolean;
  outChunks: Buffer[];
  errChunks: Buffer[];
  dataChunks: Buffer[];
  outBytes: number;
  errBytes: number;
  dataBytes: number;
  onOut?: (chunk: Buffer) => void;
  onErr?: (chunk: Buffer) => void;
  onData?: (chunk: Buffer) => void;
  resolve: (r: StreamResult) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

type Phase = 'hello' | 'auth' | 'ready' | 'stalled' | 'closed';

const EMPTY = Buffer.alloc(0);

export class Conn {
  hostId = '';
  readyAt = 0;
  closedAt = 0;
  pongs = 0;
  pingTimes: number[] = [];
  welcome?: Buffer;
  private phase: Phase = 'hello';
  private helloHostId = '';
  private execEph = '';
  private wsEph = '';
  private recv?: P.Aead;
  private send?: P.Aead;
  private nextStreamId = 1;
  private readonly streams = new Map<number, Stream>();
  private flowPaused = false;
  private tamper = false;
  private pingTimer?: NodeJS.Timeout;

  constructor(
    private readonly ws: Workstation,
    private readonly sock: WebSocket,
  ) {}

  get isOpen(): boolean {
    return this.phase !== 'closed';
  }

  onMessage(data: Buffer, isBinary: boolean): void {
    try {
      if (!isBinary) return this.reject('非二进制消息');
      switch (this.phase) {
        case 'hello':
          return this.onHello(data);
        case 'auth':
          return this.onAuth(data);
        case 'ready':
          return this.onFrame(data);
        case 'stalled':
          this.ws.authFrames++;
          return this.reject('重放 WELCOME 后收到加密消息');
        default:
          return;
      }
    } catch (err) {
      this.reject(err instanceof Error ? err.message : String(err));
    }
  }

  onClose(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.closedAt = Date.now();
    clearInterval(this.pingTimer);
    for (const s of this.streams.values()) {
      s.finished = true;
      clearTimeout(s.timer);
      s.reject(new Error('连接已关闭'));
      for (const w of s.waiters.splice(0)) w();
    }
    this.streams.clear();
    this.ws.conns.delete(this);
    this.ws.closedLog.push(this);
    if (this.hostId) {
      const host = this.ws.hosts.get(this.hostId);
      if (host?.conn === this) host.conn = undefined;
    }
  }

  terminate(): void {
    this.sock.terminate();
  }

  tamperNext(): void {
    this.tamper = true;
  }

  pauseFlow(): void {
    this.flowPaused = true;
  }

  resumeFlow(): void {
    this.flowPaused = false;
    for (const s of this.streams.values()) {
      if (s.pending > 0) this.flow(s);
    }
  }

  start(op: string, args: Record<string, unknown> = {}, opts: StartOptions = {}): StreamHandle {
    if (this.phase !== 'ready') throw new Error(`连接未就绪（${this.phase}）`);
    const id = this.nextStreamId++;
    let resolve!: (r: StreamResult) => void;
    let reject!: (e: Error) => void;
    const done = new Promise<StreamResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    done.catch(() => {});
    const s: Stream = {
      id,
      op,
      startedAt: Date.now(),
      received: 0,
      returned: 0,
      pending: 0,
      credit: P.WINDOW,
      waiters: [],
      finished: false,
      collect: opts.collect ?? true,
      outChunks: [],
      errChunks: [],
      dataChunks: [],
      outBytes: 0,
      errBytes: 0,
      dataBytes: 0,
      onOut: opts.onOut,
      onErr: opts.onErr,
      onData: opts.onData,
      resolve,
      reject,
    };
    this.streams.set(id, s);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    s.timer = setTimeout(() => {
      if (!this.streams.delete(id)) return;
      s.finished = true;
      for (const w of s.waiters.splice(0)) w();
      reject(new Error(`${op} 超时（${timeoutMs}ms）`));
      try {
        this.sendEnc(T.CANCEL, id);
      } catch {
        // 连接已关闭
      }
    }, timeoutMs);
    this.sendEnc(T.REQ, id, Buffer.from(JSON.stringify({ op, ...args }), 'utf8'));
    return {
      id,
      done,
      stats: () => ({ outBytes: s.outBytes, errBytes: s.errBytes, dataBytes: s.dataBytes }),
      sendData: (buf) => this.sendData(s, buf),
      sendBody: async (src) => {
        if (Buffer.isBuffer(src)) {
          await this.sendData(s, src);
        } else {
          for await (const chunk of src) await this.sendData(s, chunk);
        }
        this.sendEnc(T.END, id);
      },
      endBody: () => this.sendEnc(T.END, id),
      cancel: () => this.sendEnc(T.CANCEL, id),
    };
  }

  request(op: string, args: Record<string, unknown> = {}, opts: StartOptions = {}): Promise<StreamResult> {
    return this.start(op, args, opts).done;
  }

  private async sendData(s: Stream, buf: Buffer): Promise<void> {
    for (let off = 0; off < buf.length; off += P.FRAME_MAX) {
      const part = buf.subarray(off, Math.min(off + P.FRAME_MAX, buf.length));
      while (s.credit < part.length) {
        if (s.finished) throw new Error(`流 ${s.id}（${s.op}）已结束，停止发送请求体`);
        await new Promise<void>((resolve) => s.waiters.push(resolve));
      }
      s.credit -= part.length;
      this.sendEnc(T.DATA, s.id, part);
    }
  }

  private sendEnc(type: number, streamId: number, payload: Buffer = EMPTY): void {
    if (this.sock.readyState !== WebSocket.OPEN) throw new Error('连接已关闭');
    const msg = this.send!.seal(P.frame(type, streamId, payload));
    if (this.tamper) {
      this.tamper = false;
      msg[0] ^= 0xff;
    }
    this.sock.send(msg);
  }

  private reject(reason: string): void {
    this.ws.rejects.push({ t: Date.now(), reason, hostId: this.helloHostId });
    this.terminate();
  }

  private onHello(data: Buffer): void {
    const f = P.parseFrame(data);
    if (f.type !== T.HELLO || f.streamId !== 0) return this.reject('期望 HELLO');
    const hello = JSON.parse(f.payload.toString('utf8')) as { eph: string; hostId?: string };
    const hostId = hello.hostId ?? '';
    if (hostId && !this.ws.hosts.has(hostId)) return this.reject('未知主机');
    const eph = P.genKeyPair('x25519');
    this.helloHostId = hostId;
    this.execEph = hello.eph;
    this.wsEph = P.b64(eph.pub);
    const tr = P.transcript(hostId, this.execEph, this.wsEph);
    const welcome = P.frame(
      T.WELCOME,
      0,
      JSON.stringify({
        v: 1,
        eph: this.wsEph,
        pub: P.b64(this.ws.identity.pub),
        sig: P.signTranscript(this.ws.identity.priv, tr),
        caps: P.OPS,
      }),
    );
    this.welcome = welcome;
    this.ws.welcomes.push({ hostId, frame: welcome });
    if (this.ws.welcomeReplay) {
      this.phase = 'stalled';
      this.sock.send(this.ws.welcomeReplay);
      return;
    }
    const shared = diffieHellman({ privateKey: eph.priv, publicKey: P.publicKeyFrom(P.unb64(this.execEph), 'x25519') });
    const keys = P.deriveKeys(shared, tr);
    this.recv = new P.Aead(keys.up, 1);
    this.send = new P.Aead(keys.down, 2);
    this.phase = 'auth';
    this.sock.send(welcome);
  }

  private onAuth(data: Buffer): void {
    this.ws.authFrames++;
    const f = P.parseFrame(this.recv!.open(data));
    if (f.type !== T.AUTH) return this.reject('期望 AUTH');
    const auth = JSON.parse(f.payload.toString('utf8')) as {
      hostId?: string;
      sig: string;
      token?: string;
      execPub?: string;
      name?: string;
      platform?: string;
    };
    const tr = P.transcript(this.helloHostId, this.execEph, this.wsEph);
    let host: HostRecord;
    if (this.helloHostId === '') {
      const denied = this.ws.consumeToken(auth.token ?? '');
      if (denied) return this.reject(denied);
      if (!auth.execPub) return this.reject('首次登记缺少 execPub');
      const execPub = P.unb64(auth.execPub);
      if (!P.verifyTranscript(execPub, tr, auth.sig)) return this.reject('AUTH 签名无效');
      host = { hostId: this.ws.newHostId(), execPub, name: auth.name, platform: auth.platform };
      this.ws.hosts.set(host.hostId, host);
    } else {
      host = this.ws.hosts.get(this.helloHostId)!;
      if (auth.hostId !== host.hostId) return this.reject('AUTH 的 hostId 不符');
      if (!P.verifyTranscript(host.execPub, tr, auth.sig)) return this.reject('AUTH 签名无效');
    }
    this.hostId = host.hostId;
    this.sendEnc(T.AUTH_OK, 0, Buffer.from(JSON.stringify({ hostId: host.hostId }), 'utf8'));
    host.conn?.terminate();
    host.conn = this;
    this.phase = 'ready';
    this.readyAt = Date.now();
    this.pingTimer = setInterval(() => this.ping(), HEARTBEAT_MS);
    this.pingTimer.unref();
    this.ws.readyLog.push(this);
  }

  private ping(): void {
    if (this.phase !== 'ready') return;
    this.pingTimes.push(Date.now());
    this.sendEnc(T.PING, 0);
  }

  private onFrame(data: Buffer): void {
    const f = P.parseFrame(this.recv!.open(data));
    if (f.payload.length > P.FRAME_MAX) return this.reject(`帧超过 64 KiB（${f.payload.length}）`);
    if (f.type === T.PONG) {
      this.pongs++;
      return;
    }
    const s = this.streams.get(f.streamId);
    if (!s) return;
    switch (f.type) {
      case T.FLOW: {
        s.credit += f.payload.readUInt32BE(0);
        for (const w of s.waiters.splice(0)) w();
        return;
      }
      case T.OUT:
      case T.ERR:
      case T.DATA: {
        const n = f.payload.length;
        if (s.received + n > P.WINDOW + s.returned) return this.reject(`流 ${s.id} 超出流控窗口`);
        s.received += n;
        s.pending += n;
        if (f.type === T.OUT) {
          s.outBytes += n;
          if (s.collect) s.outChunks.push(f.payload);
          s.onOut?.(f.payload);
        } else if (f.type === T.ERR) {
          s.errBytes += n;
          if (s.collect) s.errChunks.push(f.payload);
          s.onErr?.(f.payload);
        } else {
          s.dataBytes += n;
          if (s.collect) s.dataChunks.push(f.payload);
          s.onData?.(f.payload);
        }
        if (!this.flowPaused && s.pending >= P.FLOW_THRESHOLD) this.flow(s);
        return;
      }
      case T.END: {
        this.streams.delete(s.id);
        s.finished = true;
        clearTimeout(s.timer);
        for (const w of s.waiters.splice(0)) w();
        const end = f.payload.length > 0 ? JSON.parse(f.payload.toString('utf8')) : null;
        s.resolve({
          id: s.id,
          op: s.op,
          end,
          error: end?.error,
          stdout: Buffer.concat(s.outChunks),
          stderr: Buffer.concat(s.errChunks),
          data: Buffer.concat(s.dataChunks),
          outBytes: s.outBytes,
          errBytes: s.errBytes,
          dataBytes: s.dataBytes,
          elapsedMs: Date.now() - s.startedAt,
        });
        return;
      }
      default:
        return this.reject(`未知帧类型 ${f.type}`);
    }
  }

  private flow(s: Stream): void {
    this.sendEnc(T.FLOW, s.id, P.u32(s.pending));
    s.returned += s.pending;
    s.pending = 0;
  }
}

export class Workstation {
  readonly hosts = new Map<string, HostRecord>();
  readonly conns = new Set<Conn>();
  readonly readyLog: Conn[] = [];
  readonly closedLog: Conn[] = [];
  readonly rejects: RejectEvent[] = [];
  readonly welcomes: Array<{ hostId: string; frame: Buffer }> = [];
  authFrames = 0;
  welcomeReplay: Buffer | null = null;
  private readonly tokens = new Map<string, { expiresAt: number; used: boolean }>();
  private port = 0;

  private constructor(
    readonly identity: P.KeyPair,
    private readonly wss: WebSocketServer,
  ) {}

  static async start(opts: { identity?: P.KeyPair } = {}): Promise<Workstation> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: P.WS_PATH, perMessageDeflate: false });
    await once(wss, 'listening');
    const ws = new Workstation(opts.identity ?? P.genKeyPair('ed25519'), wss);
    ws.port = (wss.address() as AddressInfo).port;
    wss.on('connection', (sock: WebSocket) => ws.accept(sock));
    onCleanup(() => ws.close());
    return ws;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}${P.WS_PATH}`;
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  issueToken(opts: { fpOf?: Buffer } = {}): string {
    const secret = randomBytes(24).toString('hex');
    const token = `ach_${secret}.${P.fingerprint(opts.fpOf ?? this.identity.pub)}`;
    this.tokens.set(token, { expiresAt: Date.now() + 15 * 60_000, used: false });
    return token;
  }

  consumeToken(token: string): string | null {
    const rec = this.tokens.get(token);
    if (!rec) return 'token-unknown';
    if (rec.used) return 'token-used';
    if (Date.now() > rec.expiresAt) return 'token-expired';
    rec.used = true;
    return null;
  }

  newHostId(): string {
    return randomBytes(12).toString('base64url');
  }

  disconnect(conn: Conn): void {
    conn.terminate();
  }

  hostConn(hostId: string): Conn {
    const conn = this.hosts.get(hostId)?.conn;
    if (!conn || !conn.isOpen) throw new Error(`主机 ${hostId} 不在线`);
    return conn;
  }

  async waitReady(opts: { hostId?: string; since?: number; timeoutMs?: number } = {}): Promise<Conn> {
    const since = opts.since ?? 0;
    return waitUntil(
      () => this.readyLog.slice(since).find((c) => !opts.hostId || c.hostId === opts.hostId),
      opts.timeoutMs ?? 10_000,
      `主机 ${opts.hostId ?? ''} 认证完成`,
    );
  }

  private accept(sock: WebSocket): void {
    const conn = new Conn(this, sock);
    this.conns.add(conn);
    sock.on('message', (data: RawData, isBinary: boolean) => conn.onMessage(toBuffer(data), isBinary));
    sock.on('close', () => conn.onClose());
    sock.on('error', () => {});
  }
}

export function okOrThrow(r: StreamResult): StreamResult {
  if (r.error) throw new Error(`${r.op} 失败：${r.error.code} ${r.error.message}`);
  return r;
}

export async function remoteWrite(conn: Conn, file: string, data: Buffer | string): Promise<StreamResult> {
  const h = conn.start('fs.write', { path: file, mkdirp: true });
  await h.sendBody(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  return okOrThrow(await h.done);
}

export async function remoteRead(conn: Conn, file: string, args: Record<string, unknown> = {}): Promise<StreamResult> {
  return okOrThrow(await conn.request('fs.read', { path: file, ...args }));
}

export function text(buf: Buffer): string {
  return buf.toString('utf8').trim();
}

// 断开当前连接，等待执行器用同一 hostId 重新认证。
export async function dropAndRejoin(ws: Workstation, conn: Conn, timeoutMs = 10_000): Promise<Conn> {
  const since = ws.readyLog.length;
  const t0 = Date.now();
  ws.disconnect(conn);
  const next = await ws.waitReady({ hostId: conn.hostId, since, timeoutMs });
  console.info(`[重连] 主机 ${conn.hostId} 重新认证耗时 ${Date.now() - t0}ms`);
  return next;
}

export function hasher(): { update(c: Buffer): void; hex(): string } {
  const h = createHash('sha256');
  return {
    update: (c) => {
      h.update(c);
    },
    hex: () => h.digest('hex'),
  };
}

// 每 200ms 用 sys.info 采样一次 heapInuse，返回峰值。
export function startSampler(conn: Conn, intervalMs = 200): { stop(): Promise<{ max: number; samples: number }> } {
  let stopped = false;
  const result = { max: 0, samples: 0 };
  const loop = (async () => {
    while (!stopped && conn.isOpen) {
      try {
        const r = await conn.request('sys.info');
        const heap = r.end?.heapInuse;
        if (typeof heap === 'number') {
          result.max = Math.max(result.max, heap);
          result.samples++;
        }
      } catch {
        return;
      }
      await sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return result;
    },
  };
}
