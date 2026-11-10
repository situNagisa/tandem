// 上游转发：请求构造、参数降级重试（stream_options / reasoning_effort / thinking）、错误文本提取。
// 网关与 provider 只在“发什么 body、错误怎么呈现”上不同，传输层逻辑集中在这里。
import { joinEndpoint, providerDefaultBaseUrl } from '../config.js';
import type { StoredProfile } from '../types.js';

type AnyRecord = Record<string, any>;

export type UpstreamProtocol = 'openai' | 'anthropic';

/** 一次上游尝试的失败；retryable 供网关判断是否换 Key，工作站不看这个字段。 */
export class UpstreamAttemptError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  /** 请求还没发出就失败（账号配置错误），调用方原样回传自己的错误格式。 */
  readonly setup: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean; setup?: boolean } = {}) {
    super(message);
    this.name = 'UpstreamAttemptError';
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? true;
    this.setup = options.setup === true;
  }
}

export function extractUpstreamError(text: string, status: number): string {
  try {
    const data = JSON.parse(text) as AnyRecord;
    const message = data?.error?.message ?? data?.message ?? data?.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 400);
  } catch {
    /* 非 JSON */
  }
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact ? compact.slice(0, 400) : `上游返回 HTTP ${status}`;
}

export function retryableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 409 || status === 429 || status >= 500;
}

/** 上游不支持某个参数时的降级：命中条件后去掉/改写参数重试一次。 */
export interface BodyFallback<B> {
  applies(res: { status: number; text: string }, body: B): boolean;
  drop(body: B): B;
  /** 降级后最终拿到成功响应时回调（如上报 effort_dropped）。 */
  onDropped?(): void;
}

/** 发送 JSON body；非 2xx 且命中降级条件时改 body 重试，每个降级只生效一次。 */
export async function postWithBodyFallbacks<B extends AnyRecord>(opts: {
  body: B;
  send(body: B): Promise<Response>;
  fallbacks?: Array<BodyFallback<B>>;
}): Promise<{ res: Response; body: B; text: string }> {
  let body = opts.body;
  const pending = [...(opts.fallbacks ?? [])];
  const dropped: Array<BodyFallback<B>> = [];
  while (true) {
    const res = await opts.send(body);
    if (res.ok) {
      for (const fallback of dropped) fallback.onDropped?.();
      return { res, body, text: '' };
    }
    const text = await res.text().catch(() => '');
    const index = pending.findIndex((fallback) => fallback.applies({ status: res.status, text }, body));
    if (index < 0) return { res, body, text };
    const [fallback] = pending.splice(index, 1);
    dropped.push(fallback!);
    body = fallback!.drop(body);
  }
}

export interface PassthroughRequest {
  url: string;
  init: RequestInit;
  body: AnyRecord;
  addedStreamOptions: boolean;
}

/** 网关原样转发：只替换 model / 鉴权头，协议不翻译。 */
export function buildPassthroughRequest(opts: {
  profile: StoredProfile;
  protocol: UpstreamProtocol;
  body: AnyRecord;
  model: string;
  signal: AbortSignal;
  clientHeaders?: { anthropicVersion?: string; anthropicBeta?: string };
}): PassthroughRequest {
  const { profile, protocol, body, model, signal } = opts;
  const bodyOut: AnyRecord = { ...body, model };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: body.stream === true ? 'text/event-stream' : 'application/json',
  };
  let url: string;
  let addedStreamOptions = false;
  if (protocol === 'anthropic') {
    const base = profile.baseUrl || providerDefaultBaseUrl('anthropic');
    url = joinEndpoint(base, '/v1/messages');
    headers['x-api-key'] = profile.apiKey;
    headers['anthropic-version'] = opts.clientHeaders?.anthropicVersion ?? '2023-06-01';
    const beta = opts.clientHeaders?.anthropicBeta;
    if (beta?.trim()) headers['anthropic-beta'] = beta;
  } else {
    const base = profile.baseUrl || providerDefaultBaseUrl(profile.kind);
    if (!base) {
      throw new UpstreamAttemptError(`账号「${profile.name}」未配置 baseUrl`, { status: 503, retryable: false, setup: true });
    }
    url = joinEndpoint(base, '/chat/completions');
    headers.authorization = `Bearer ${profile.apiKey}`;
    // 要求上游在流末尾带 usage；部分兼容服务不支持，会在 400 时自动去掉重试。
    if (bodyOut.stream === true && !bodyOut.stream_options) {
      bodyOut.stream_options = { include_usage: true };
      addedStreamOptions = true;
    }
  }
  return { url, init: { method: 'POST', headers, signal }, body: bodyOut, addedStreamOptions };
}
