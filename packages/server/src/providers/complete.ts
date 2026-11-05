// 非流式一次性小请求：用于自动生成会话标题等短任务。
import { joinEndpoint, providerDefaultBaseUrl } from '../config.js';
import type { StoredProfile } from '../types.js';
import { truncateEnd } from '../util/text.js';

type AnyRecord = Record<string, any>;

export interface CompleteRequest {
  profile: StoredProfile;
  model: string;
  prompt: string;
  /** 可选的 system 提示。 */
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** 调一次非流式补全，返回纯文本；失败直接抛错由调用方兜底。 */
export async function completeText(req: CompleteRequest): Promise<string> {
  const maxTokens = req.maxTokens ?? 64;
  if (req.profile.kind === 'anthropic') {
    const base = req.profile.baseUrl || providerDefaultBaseUrl('anthropic');
    const body: AnyRecord = {
      model: req.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: req.prompt }],
    };
    if (req.system) body.system = req.system;
    const res = await fetch(joinEndpoint(base, '/v1/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': req.profile.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${truncateEnd(text || res.statusText, 300)}`);
    }
    const data = (await res.json()) as AnyRecord;
    return (Array.isArray(data.content) ? data.content : [])
      .filter((block: AnyRecord) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: AnyRecord) => block.text as string)
      .join('')
      .trim();
  }

  const base = req.profile.baseUrl || providerDefaultBaseUrl(req.profile.kind);
  if (!base) throw new Error('该账号未配置 baseUrl');
  const messages: AnyRecord[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });
  const body: AnyRecord = {
    model: req.model,
    messages,
    stream: false,
  };
  // 新版 OpenAI 推理模型使用 max_completion_tokens；兼容接口仍用 max_tokens
  if (req.profile.kind === 'openai' && /^(o[1-9]|gpt-5)/i.test(req.model)) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }
  const res = await fetch(joinEndpoint(base, '/chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${req.profile.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${truncateEnd(text || res.statusText, 300)}`);
  }
  const data = (await res.json()) as AnyRecord;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part: AnyRecord) => typeof part?.text === 'string')
      .map((part: AnyRecord) => part.text as string)
      .join('')
      .trim();
  }
  return '';
}
