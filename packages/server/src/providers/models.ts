// 从各 provider 拉取可用模型列表：填 Key 后自动获取，无需手填。
import type {
  ListModelsInput,
  ModelCapabilities,
  ModelInfo,
  ProviderKind,
  ReasoningEffort,
} from '@tandem/protocol';
import { inferProtocolBaseUrl, joinEndpoint, providerDefaultBaseUrl } from '../config.js';
import type { StoredProfile } from '../types.js';
import { errorMessage, isAbortError, truncateEnd } from '../util/text.js';
import { tandemGatewayBase } from './openai.js';
import {
  applyModelCapabilities,
  defaultEffortsForKind,
  providerEffortsFor,
} from './capabilities.js';

const TIMEOUT_MS = 15_000;
/** Gemini 原生模型列表端点（OpenAI 兼容端点失败时的兜底）。 */
const GEMINI_NATIVE_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface ListModelsResult {
  ok: boolean;
  models: ModelInfo[];
  error?: string;
}

/** 明显不是对话类模型的关键词，拉列表时过滤掉。 */
const NON_CHAT_PATTERNS = [
  /embed/i,
  /(^|[-_/])tts([-_/]|$)/i,
  /whisper/i,
  /dall[-_ ]?e/i,
  /moderation/i,
  /(^|[-_/])image/i,
  /(^|[-_/])audio/i,
  /realtime/i,
  /transcri/i,
  /speech/i,
  /(^|[-_/])sora([-_/]|$)/i,
  /rerank/i,
  /(^|[-_/])ocr([-_/]|$)/i,
];

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}`);
  }
}

function isNonChatModel(id: string): boolean {
  return NON_CHAT_PATTERNS.some((re) => re.test(id));
}

/** 粗略的新旧排序：取 id 里第一个版本号，大的在前，同版本按字母序。 */
function sortNewestFirst(models: ModelInfo[]): ModelInfo[] {
  const version = (id: string): number => {
    const m = id.match(/(\d+(?:\.\d+)?)/);
    return m ? Number.parseFloat(m[1]!) : -1;
  };
  return models.sort((a, b) => {
    const diff = version(b.id) - version(a.id);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

function dedupe(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const model of models) {
    if (!model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

const EFFORT_ORDER: ReasoningEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function normalizeEfforts(value: unknown): ReasoningEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const picked = EFFORT_ORDER.filter((effort) => value.includes(effort));
  return picked.length ? picked : [];
}

/** provider 模型条目里的能力字段；不同服务商字段名不一致，做兼容读取。 */
function providerCapabilities(
  item: any,
  kind: ProviderKind,
): ModelCapabilities | undefined {
  const caps: ModelCapabilities = {};

  const thinking = item?.capabilities?.thinking ?? item?.capabilities?.extended_thinking;
  if (thinking && typeof thinking.supported === 'boolean') {
    caps.efforts = thinking.supported ? defaultEffortsForKind(kind) : [];
  }
  const effortCaps = item?.capabilities?.effort;
  if (effortCaps && typeof effortCaps === 'object') {
    if (effortCaps.supported === false) caps.efforts = [];
    else if (typeof effortCaps.supported === 'boolean' || Array.isArray(effortCaps.levels)) {
      const levels = normalizeEfforts(effortCaps.levels);
      caps.efforts =
        levels && levels.length
          ? EFFORT_ORDER.filter((effort) => effort === 'off' || levels.includes(effort))
          : defaultEffortsForKind(kind);
    }
  }

  const declared = normalizeEfforts(item?.efforts ?? item?.reasoning_efforts);
  if (declared !== undefined) caps.efforts = declared;

  const params: unknown = item?.supported_parameters;
  if (Array.isArray(params) && params.some((p) => p === 'reasoning_effort' || p === 'reasoning')) {
    caps.efforts = providerEffortsFor(kind);
  }

  const contextWindow =
    item?.contextWindow ??
    item?.context_window ??
    item?.context_length ??
    item?.max_context_length ??
    item?.max_input_tokens ??
    item?.inputTokenLimit ??
    item?.top_provider?.context_length;
  const window = Number(contextWindow);
  if (Number.isFinite(window) && window > 0) caps.contextWindow = window;

  return caps.efforts !== undefined || caps.contextWindow !== undefined ? caps : undefined;
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, any>> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...headers },
    signal,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new HttpError(res.status, text || res.statusText);
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error('返回内容不是合法 JSON，请检查 baseUrl 是否指向模型接口');
  }
}

async function listAnthropic(baseUrl: string, apiKey: string, signal: AbortSignal): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  let afterId: string | undefined;
  // limit=1000 通常一次取完；仍按 has_more 翻页兜底
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ limit: '1000' });
    if (afterId) params.set('after_id', afterId);
    const url = `${joinEndpoint(baseUrl, '/v1/models')}?${params.toString()}`;
    const data = await getJson(
      url,
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal,
    );
    const items: any[] = Array.isArray(data.data) ? data.data : [];
    for (const item of items) {
      if (typeof item?.id !== 'string' || !item.id) continue;
      const info: ModelInfo = { id: item.id };
      if (typeof item.display_name === 'string' && item.display_name) info.displayName = item.display_name;
      const caps = providerCapabilities(item, 'anthropic');
      if (caps) Object.assign(info, caps);
      models.push(info);
    }
    const lastId = typeof data.last_id === 'string' ? data.last_id : undefined;
    if (!data.has_more || !lastId || items.length === 0) break;
    afterId = lastId;
  }
  return dedupe(models);
}

async function listOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<ModelInfo[]> {
  const data = await getJson(
    joinEndpoint(baseUrl, '/models'),
    { authorization: `Bearer ${apiKey}` },
    signal,
  );
  const items: any[] = Array.isArray(data.data)
    ? data.data
    : Array.isArray(data.models)
      ? data.models
      : [];
  const models: ModelInfo[] = [];
  for (const item of items) {
    const rawId = typeof item?.id === 'string' ? item.id : typeof item?.name === 'string' ? item.name : '';
    // Gemini 原生格式可能带 models/ 前缀
    const id = rawId.replace(/^models\//, '').trim();
    if (!id || isNonChatModel(id)) continue;
    const info: ModelInfo = { id };
    const caps = providerCapabilities(item, 'openai-compatible');
    if (caps) Object.assign(info, caps);
    models.push(info);
  }
  return sortNewestFirst(dedupe(models));
}

/** Tandem 网关模型列表：网关按成员白名单过滤后返回 OpenAI 兼容格式。 */
async function listTandemGateway(baseUrl: string, apiKey: string, signal: AbortSignal): Promise<ModelInfo[]> {
  const data = await getJson(
    joinEndpoint(tandemGatewayBase(baseUrl), '/gateway/v1/models'),
    { authorization: `Bearer ${apiKey}` },
    signal,
  );
  const items: any[] = Array.isArray(data.data) ? data.data : [];
  const models: ModelInfo[] = [];
  for (const item of items) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    models.push({ id });
  }
  return sortNewestFirst(dedupe(models));
}

async function listGeminiNative(apiKey: string, signal: AbortSignal): Promise<ModelInfo[]> {
  const data = await getJson(
    `${GEMINI_NATIVE_MODELS_URL}?key=${encodeURIComponent(apiKey)}`,
    {},
    signal,
  );
  const items: any[] = Array.isArray(data.models) ? data.models : [];
  const models: ModelInfo[] = [];
  for (const item of items) {
    const rawId = typeof item?.name === 'string' ? item.name : '';
    const id = rawId.replace(/^models\//, '').trim();
    if (!id || isNonChatModel(id)) continue;
    // 只保留支持对话生成的模型
    const methods: unknown = item.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes('generateContent')) continue;
    const info: ModelInfo = { id };
    if (typeof item.displayName === 'string' && item.displayName) info.displayName = item.displayName;
    if (typeof item.inputTokenLimit === 'number') info.contextWindow = item.inputTokenLimit;
    const caps = providerCapabilities(item, 'gemini');
    if (caps) Object.assign(info, caps);
    models.push(info);
  }
  return sortNewestFirst(dedupe(models));
}

function friendlyError(err: unknown, baseUrl: string): string {
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) return 'Key 无效';
    const body = err.body.replace(/\s+/g, ' ').trim();
    return `HTTP ${err.status}: ${truncateEnd(body || '请求失败', 300)}`;
  }
  if (isAbortError(err)) return '请求超时（15 秒），请检查网络或端点地址';
  // fetch 在网络层失败时抛 TypeError（DNS 解析失败、连接被拒绝等）
  if (err instanceof TypeError) return `无法连接 ${baseUrl}`;
  return truncateEnd(errorMessage(err), 500);
}

/**
 * 拉取模型列表。apiKey/baseUrl 缺省时取 profileId 对应已存账号的值。
 * 所有错误都收敛成 { ok:false, error }，不向路由层抛异常。
 */
export async function listModels(
  input: ListModelsInput,
  profile?: StoredProfile,
): Promise<ListModelsResult> {
  const kind: ProviderKind = input.kind;
  const apiKey = (input.apiKey ?? '').trim() || profile?.apiKey || '';
  const inheritedBase =
    profile && kind !== profile.kind
      ? inferProtocolBaseUrl(profile.baseUrl, kind)
      : profile?.baseUrl;
  const baseUrl =
    (input.baseUrl ?? '').trim() || inheritedBase || providerDefaultBaseUrl(kind);
  if (!apiKey) return { ok: false, models: [], error: '未配置 API Key' };
  if (!baseUrl) return { ok: false, models: [], error: '未配置 baseUrl（OpenAI 兼容接口需要填写端点地址）' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const signal = controller.signal;
  const capabilityKind = profile?.kind ?? kind;
  const decorate = (models: ModelInfo[]) =>
    models.map((model) =>
      applyModelCapabilities(model, capabilityKind, profile?.modelCapabilities),
    );
  try {
    if (kind === 'tandem-gateway') {
      return { ok: true, models: decorate(await listTandemGateway(baseUrl, apiKey, signal)) };
    }
    if (kind === 'anthropic') {
      return { ok: true, models: decorate(await listAnthropic(baseUrl, apiKey, signal)) };
    }
    if (kind === 'gemini') {
      try {
        return { ok: true, models: decorate(await listOpenAICompatible(baseUrl, apiKey, signal)) };
      } catch (err) {
        if (signal.aborted) throw err;
        // OpenAI 兼容端点不可用时再试 Gemini 原生接口
        return { ok: true, models: decorate(await listGeminiNative(apiKey, signal)) };
      }
    }
    return { ok: true, models: decorate(await listOpenAICompatible(baseUrl, apiKey, signal)) };
  } catch (err) {
    if (kind === 'tandem-gateway' && err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      return { ok: false, models: [], error: '网关令牌无效或已被吊销' };
    }
    return { ok: false, models: [], error: friendlyError(err, baseUrl) };
  } finally {
    clearTimeout(timer);
  }
}
