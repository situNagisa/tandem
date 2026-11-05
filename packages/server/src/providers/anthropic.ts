// Anthropic Messages API 适配：SSE 流式、tool use、thinking、图片、prompt caching。
import type { ContentBlock, Message, Usage } from '@tandem/protocol';
import { joinEndpoint, providerDefaultBaseUrl } from '../config.js';
import { isAbortError, truncateEnd } from '../util/text.js';
import { readSse } from './sse.js';
import type { StreamRequest, StreamResult } from './types.js';

type AnyBlock = Record<string, any>;

function supportsThinking(model: string): boolean {
  return /claude-(?:3-7|[a-z]+-4)/.test(model);
}

/** 内部 Message -> Anthropic messages；合并连续同角色，保证 user/assistant 交替。 */
export function toAnthropicMessages(messages: Message[]): AnyBlock[] {
  const out: AnyBlock[] = [];
  for (const msg of messages) {
    const content: AnyBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'text') {
        if (block.text) content.push({ type: 'text', text: block.text });
      } else if (block.type === 'thinking') {
        // 有签名才回传（开启 extended thinking 后工具循环要求原样带回）
        const signature = (block as AnyBlock).signature;
        if (signature) content.push({ type: 'thinking', thinking: block.text, signature });
      } else if (block.type === 'image') {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 },
        });
      } else if (block.type === 'tool_use') {
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} });
      } else if (block.type === 'tool_result') {
        content.push({
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content,
          ...(block.isError ? { is_error: true } : {}),
        });
      }
    }
    if (content.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === msg.role) {
      last.content.push(...content);
    } else {
      out.push({ role: msg.role, content });
    }
  }
  return out;
}

/** 在最后 n 条消息的最后一个内容块上加缓存断点。 */
function markCache(messages: AnyBlock[], n: number): void {
  for (let i = messages.length - 1, count = 0; i >= 0 && count < n; i--, count++) {
    const content = messages[i]?.content;
    if (Array.isArray(content) && content.length > 0) {
      const last = content[content.length - 1];
      if (last.type !== 'thinking') last.cache_control = { type: 'ephemeral' };
    }
  }
}

export async function streamAnthropic(req: StreamRequest): Promise<StreamResult> {
  const base = req.profile.baseUrl || providerDefaultBaseUrl('anthropic');
  const url = joinEndpoint(base, '/v1/messages');
  const messages = toAnthropicMessages(req.messages);
  markCache(messages, 2);

  const tools = req.tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(index === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));

  const body: AnyBlock = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [
      {
        type: 'text',
        text: req.system,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages,
    stream: true,
  };
  if (tools.length > 0) body.tools = tools;
  if (supportsThinking(req.model)) {
    body.thinking = { type: 'enabled', budget_tokens: 1024 };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-api-key': req.profile.apiKey,
    'anthropic-version': '2023-06-01',
  };

  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const inputBuf = new Map<number, string>();

  const send = async (payload: AnyBlock) => {
    let res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: req.signal,
    });
    // 少数模型/代理不支持 thinking，退化为普通请求
    if (!res.ok && res.status === 400 && body.thinking) {
      const text = await res.text();
      if (/thinking/i.test(text)) {
        const retryBody = { ...payload } as AnyBlock;
        delete retryBody.thinking;
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(retryBody),
          signal: req.signal,
        });
      } else {
        throw new Error(`Anthropic API ${res.status}: ${truncateEnd(text, 800)}`);
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${truncateEnd(text || res.statusText, 800)}`);
    }
    return res;
  };

  const finishToolInputs = () => {
    for (const [index, raw] of inputBuf) {
      const block = req.blocks[index];
      if (!block || block.type !== 'tool_use') continue;
      if (!raw.trim()) {
        block.input = {};
        continue;
      }
      try {
        block.input = JSON.parse(raw);
      } catch {
        block.input = {};
      }
    }
  };

  try {
    const res = await send(body);
    for await (const ev of readSse(res)) {
      if (ev.data === '[DONE]') break;
      let json: AnyBlock;
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (json.type) {
        case 'message_start': {
          const u = json.message?.usage;
          if (u) {
            usage.inputTokens = u.input_tokens ?? 0;
            usage.outputTokens = u.output_tokens ?? 0;
          }
          break;
        }
        case 'content_block_start': {
          const index: number = json.index;
          const cb = json.content_block ?? {};
          let block: ContentBlock | undefined;
          if (cb.type === 'text') block = { type: 'text', text: cb.text ?? '' };
          else if (cb.type === 'thinking') block = { type: 'thinking', text: cb.thinking ?? '' };
          else if (cb.type === 'redacted_thinking') block = { type: 'thinking', text: '[思考内容已加密]' };
          else if (cb.type === 'tool_use') {
            block = { type: 'tool_use', id: cb.id, name: cb.name, input: {} };
            inputBuf.set(index, '');
          }
          if (!block) break;
          req.blocks[index] = block;
          req.onBlockStart(index, block);
          break;
        }
        case 'content_block_delta': {
          const index: number = json.index;
          const block = req.blocks[index];
          const delta = json.delta ?? {};
          if (!block) break;
          if (delta.type === 'text_delta' && block.type === 'text') {
            const text = delta.text ?? '';
            block.text += text;
            req.onText(index, text);
          } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
            const text = delta.thinking ?? '';
            block.text += text;
            req.onText(index, text);
          } else if (delta.type === 'signature_delta') {
            (block as AnyBlock).signature = delta.signature;
          } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
            const partial = delta.partial_json ?? '';
            inputBuf.set(index, (inputBuf.get(index) ?? '') + partial);
            req.onToolInput(index, partial);
          }
          break;
        }
        case 'content_block_stop': {
          const index: number = json.index;
          const raw = inputBuf.get(index);
          const block = req.blocks[index];
          if (raw !== undefined && block?.type === 'tool_use') {
            try {
              block.input = raw.trim() ? JSON.parse(raw) : {};
            } catch {
              block.input = {};
            }
            inputBuf.delete(index);
          }
          break;
        }
        case 'message_delta': {
          const u = json.usage;
          if (u?.output_tokens != null) usage.outputTokens = u.output_tokens;
          break;
        }
        case 'error': {
          throw new Error(json.error?.message ?? 'Anthropic 流式返回错误');
        }
        default:
          break;
      }
    }
  } catch (err) {
    if (!isAbortError(err) && !req.signal.aborted) {
      finishToolInputs();
      throw err;
    }
  } finally {
    finishToolInputs();
  }

  return { usage };
}

/** 验证 key：发一条极小请求。 */
export async function testAnthropic(
  baseUrl: string | undefined,
  apiKey: string,
  model: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const base = baseUrl || providerDefaultBaseUrl('anthropic');
  const res = await fetch(joinEndpoint(base, '/v1/messages'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${truncateEnd(text || res.statusText, 500)}` };
  }
  return { ok: true };
}
