// 非流式一次性小请求：用于自动生成会话标题等短任务。
import { randomUUID } from 'node:crypto';
import { joinEndpoint, providerDefaultBaseUrl } from '../config.js';
import { tandemGatewayBase } from './openai.js';
import type { Message, StoredProfile } from '../types.js';
import { providerHttpError } from './http-error.js';
import type { ProxyRunner } from './types.js';
import { truncateEnd } from '../util/text.js';

type AnyRecord = Record<string, any>;

export interface CompleteRequest {
  profile: StoredProfile;
  /** 账号级模型账号的分组。 */
  groupId?: string;
  model: string;
  prompt: string;
  /** 可选的 system 提示。 */
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 账号级模型账号（Key 在工作站）交给工作站代理。 */
  proxy?: ProxyRunner;
}

/** 调一次非流式补全，返回纯文本；失败直接抛错由调用方兜底。 */
export async function completeText(req: CompleteRequest): Promise<string> {
  const maxTokens = req.maxTokens ?? 64;
  if (req.profile.proxied) {
    if (!req.proxy) throw new Error('账号级模型账号需要通过工作站代理，但主机未连接工作站');
    const message: Message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: req.prompt }],
      createdAt: Date.now(),
    };
    let text = '';
    await req.proxy.run(
      {
        profileId: req.profile.id,
        ...(req.groupId ? { groupId: req.groupId } : {}),
        model: req.model,
        system: req.system ?? '',
        messages: [message],
        tools: [],
        maxTokens,
        idleTimeoutSec: 180,
      },
      (event) => {
        if (event.type === 'text') text += event.text;
        if (event.type === 'error') throw new Error(event.message);
      },
      req.signal ?? new AbortController().signal,
    );
    return text.trim();
  }
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
      throw providerHttpError(res.status, text, base, res.statusText);
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
  if (req.profile.kind === 'openai' && /^(o[1-9]|gpt-5|gpt-6)/i.test(req.model)) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }
  const url = req.profile.kind === 'tandem-gateway'
    ? joinEndpoint(tandemGatewayBase(base), '/gateway/v1/chat/completions')
    : joinEndpoint(base, '/chat/completions');
  const res = await fetch(url, {
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
    throw providerHttpError(res.status, text, base, res.statusText);
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
