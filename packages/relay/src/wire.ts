// 隧道帧格式与端到端加密的线协议常量。Host、relay、客户端共用，只依赖 Uint8Array / DataView / TextEncoder，浏览器可用。

export const TUNNEL_PATH = '/_tunnel';
export const TUNNEL_VERSION = 1;

/** 隧道二进制帧：[type u8][streamId u32 BE][payload]。 */
export const F = {
  /** relay→Host：{ method, url, headers: [k, v][] } */
  REQ_HEAD: 1,
  REQ_DATA: 2,
  REQ_END: 3,
  /** Host→relay：{ status, headers: [k, v][] } */
  RES_HEAD: 4,
  RES_DATA: 5,
  RES_END: 6,
  /** relay→Host：u32 BE，已写给客户端的响应字节数（响应流控窗口） */
  RES_ACK: 7,
  /** relay→Host：{ url, headers: [k, v][] } */
  WS_OPEN: 8,
  WS_OPENED: 9,
  /** Host→relay：{ status } 本地拒绝升级（如 token 无效） */
  WS_REJECT: 10,
  /** 双向：[0 文本 | 1 二进制][数据] */
  WS_MSG: 11,
  /** 双向：{ code, reason } */
  WS_CLOSE: 12,
  /** 双向：{ message } 重置整条流 */
  ABORT: 13,
} as const;

/** 响应流控窗口：Host 最多领先 relay 确认 1 MiB 的未确认响应数据。 */
export const RES_WINDOW = 1024 * 1024;

export interface Frame {
  type: number;
  streamId: number;
  payload: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(type: number, streamId: number, payload?: Uint8Array): Uint8Array {
  const body = payload ?? new Uint8Array(0);
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, streamId >>> 0);
  out.set(body, 5);
  return out;
}

export function decodeFrame(data: Uint8Array): Frame | null {
  if (data.length < 5) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { type: data[0]!, streamId: view.getUint32(1), payload: data.subarray(5) };
}

export function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function parseJson<T>(payload: Uint8Array): T {
  return JSON.parse(decoder.decode(payload)) as T;
}

export function u32Bytes(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
}

export function readU32(payload: Uint8Array): number {
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0);
}

/** 文本帧 / 二进制帧的 WS_MSG 负载。 */
export function wsMsgPayload(data: Uint8Array, isBinary: boolean): Uint8Array {
  const out = new Uint8Array(1 + data.length);
  out[0] = isBinary ? 1 : 0;
  out.set(data, 1);
  return out;
}

// ---------- relay 注册握手（Host 持有 Ed25519 私钥） ----------

export interface TunnelChallenge { type: 'challenge'; v: number; nonce: string }
export interface TunnelHello { type: 'hello'; v: number; hostId: string; pub: string; sig: string }
export interface TunnelReady { type: 'ready' }

/** Host 对 relay 挑战签名的内容。 */
export function registrationMessage(nonce: string, hostId: string): Uint8Array {
  return encoder.encode(`tandem-relay-v1|${nonce}|${hostId}`);
}

/** hostId 只允许 URL 安全字符，避免路径穿越与日志注入。 */
export function isValidHostId(hostId: unknown): hostId is string {
  return typeof hostId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(hostId);
}

// ---------- 端到端加密（X25519 + Ed25519 + HKDF-SHA256 + AES-256-GCM） ----------

export const E2E_PREFIX = '/_e2e';
export const E2E_HELLO = '/_e2e/hello';
export const E2E_HTTP = '/_e2e/http';
export const E2E_WS = '/_e2e/ws';

/** 密文记录类型（明文首字节）。 */
export const R = { HEAD: 1, DATA: 2, END: 3 } as const;
/** 加密 WS 消息明文首字节。 */
export const WS_TEXT = 0;
export const WS_BINARY = 1;

export const E2E_MAX_RECORD = 64 * 1024 * 1024;
export const E2E_CHUNK = 64 * 1024;

export interface E2EHello { v: number; epk: string }
export interface E2EHelloReply { v: number; sid: string; epk: string; pub: string; sig: string }

/** 握手签名内容：绑定 hostId 与双方临时公钥，relay 无法替换其中任何一项。 */
export function e2eTranscript(hostId: string, clientEpk: Uint8Array, hostEpk: Uint8Array): Uint8Array {
  const label = encoder.encode(`tandem-e2e-v1|${hostId}|`);
  const out = new Uint8Array(label.length + clientEpk.length + hostEpk.length);
  out.set(label, 0);
  out.set(clientEpk, label.length);
  out.set(hostEpk, label.length + clientEpk.length);
  return out;
}

export const E2E_HKDF_INFO = 'tandem-e2e-v1 keys';

/** 记录 nonce：[请求/连接计数 u64 BE][记录序号 u32 BE]；同一会话内计数不重用，故 nonce 不重复。 */
export function recordNonce(counter: number, index: number): Uint8Array {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(counter));
  view.setUint32(8, index >>> 0);
  return out;
}

/** 请求信封明文：[u32 头长度][JSON 头][原始 body]。 */
export function packEnvelope(head: unknown, body?: Uint8Array): Uint8Array {
  const json = jsonBytes(head);
  const rest = body ?? new Uint8Array(0);
  const out = new Uint8Array(4 + json.length + rest.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(rest, 4 + json.length);
  return out;
}

export function unpackEnvelope<T>(data: Uint8Array): { head: T; body: Uint8Array } {
  if (data.length < 4) throw new Error('信封过短');
  const len = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  if (4 + len > data.length) throw new Error('信封长度无效');
  return { head: parseJson<T>(data.subarray(4, 4 + len)), body: data.subarray(4 + len) };
}

export interface E2EHttpHead { method: string; path: string; headers: Record<string, string> }
export interface E2EResHead { status: number; headers: [string, string][] }
export interface E2EWsHead { path: string }

export function b64u(data: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(text: string): Uint8Array {
  const std = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 指纹统一为小写 64 位十六进制（去掉 `sha256:`、冒号、空格）。 */
export function normalizeFingerprint(text: string): string {
  return text.toLowerCase().replace(/^sha256:/, '').replace(/[^0-9a-f]/g, '');
}

export function hex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
}
