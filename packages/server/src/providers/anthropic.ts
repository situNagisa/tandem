// Anthropic Messages API 适配：SSE 流式、tool use、thinking、图片、prompt caching。
import { providerHttpError } from './http-error.js';
import type { ContentBlock, Message, Usage } from '@tandem/protocol';
import { joinEndpoint, providerDefaultBaseUrl } from '../config.js';
import { isAbortError, truncateEnd } from '../util/text.js';
import { readSse, fetchSse } from '../upstream/sse.js';
import { postWithBodyFallbacks, summarizeUpstreamRejection } from '../upstream/request.js';
import { applyAnthropicUsage } from '../upstream/usage.js';
import { createIdleTimeout, idleTimeoutError } from './idle-timeout.js';
import { parseRateLimitHeaders, retryAfterMs } from './rate-limit.js';
import { ANTHROPIC_THINKING_BUDGETS, adaptiveCanDisable, builtinCapabilities, claudeThinkingMode, overrideFor } from './capabilities.js';
import type { StreamRequest, StreamResult } from './types.js';

type AnyBlock = Record<string, any>;

/** 能力表（账号覆盖 > 内置）明确支持该档位时才启用 thinking；未知能力的模型保守关闭。 */
function supportsThinking(model: string, profile: StreamRequest['profile'], effort: StreamRequest['effort']): boolean {
  if (!effort || effort === 'off') return false;
  const efforts =
    overrideFor(profile.modelCapabilities, model)?.efforts ??
    builtinCapabilities(profile.kind, model).efforts;
  return !!efforts && efforts.includes(effort);
}

const THINKING_BUDGETS = ANTHROPIC_THINKING_BUDGETS;

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
        const redacted = (block as AnyBlock).redacted;
        if (redacted) content.push({ type: 'redacted_thinking', data: redacted });
        else if (signature) content.push({ type: 'thinking', thinking: block.text, signature });
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

  const thinking = supportsThinking(req.model, req.profile, req.effort);
  const budget = thinking ? THINKING_BUDGETS[req.effort!] : undefined;
  const adaptive = thinking && claudeThinkingMode(req.model) === 'adaptive';
  const body: AnyBlock = {
    model: req.model,
    max_tokens: budget ? Math.max(req.maxTokens, budget + 4096) : req.maxTokens,
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
  if (adaptive) {
    // adaptive 型号默认 display=omitted（思考文本为空），显式 summarized 才能在 UI 看到思考过程。
    body.thinking = { type: 'adaptive', display: 'summarized' };
    body.output_config = { effort: req.effort };
  } else if (budget) {
    body.thinking = { type: 'enabled', budget_tokens: budget };
  } else if (
    req.effort === 'off' &&
    claudeThinkingMode(req.model) === 'adaptive' &&
    adaptiveCanDisable(req.model)
  ) {
    // 默认就开 adaptive 的型号，不传 thinking 并不等于关；显式 disabled 才是真的关。
    body.thinking = { type: 'disabled' };
  }

  const idle = createIdleTimeout(req.signal, req.idleTimeoutSec);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-api-key': req.profile.apiKey,
    'anthropic-version': '2023-06-01',
  };

  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const inputBuf = new Map<number, string>();

  const send = async (payload: AnyBlock) => {
    const sent = await postWithBodyFallbacks<AnyBlock>({
      body: payload,
      send: (body) =>
        fetchSse(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: idle.signal,
        }),
      fallbacks: [
        // 只接受 adaptive 的型号会明确报 "thinking.type.enabled" is not supported：改用 adaptive 重试，不算降级
        {
          applies: (res, body) =>
            res.status === 400 &&
            body.thinking?.type === 'enabled' &&
            /thinking\.type\.enabled\\?"? is not supported/.test(res.text),
          drop: (body) => ({
            ...body,
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: req.effort },
          }),
        },
        // 少数模型/代理不支持 thinking：去掉后重试一次。
        {
          applies: (res, body) =>
            res.status === 400 &&
            !!body.thinking &&
            /thinking|budget_tokens|reasoning|unsupported|not support/i.test(res.text),
          drop: (body) => {
            const retryBody: AnyBlock = { ...body, max_tokens: req.maxTokens };
            delete retryBody.thinking;
            delete retryBody.output_config;
            return retryBody;
          },
          onDropped: (rejected) =>
            req.onEffortDropped?.(summarizeUpstreamRejection(rejected, [req.profile.apiKey, req.profile.baseUrl])),
        },
      ],
    });
    if (!sent.res.ok) {
      throw providerHttpError(
        sent.res.status,
        sent.text,
        url,
        sent.res.statusText,
        parseRateLimitHeaders('anthropic', sent.res.headers),
        retryAfterMs(sent.res.headers),
      );
    }
    const limit = parseRateLimitHeaders('anthropic', sent.res.headers);
    if (limit) req.onRateLimit?.(limit);
    return sent.res;
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
    for await (const ev of readSse(res, idle.reset)) {
      if (ev.data === '[DONE]') break;
      let json: AnyBlock;
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (json.type) {
        case 'message_start': {
          applyAnthropicUsage(json.message?.usage, usage);
          break;
        }
        case 'content_block_start': {
          const index: number = json.index;
          const cb = json.content_block ?? {};
          let block: ContentBlock | undefined;
          if (cb.type === 'text') block = { type: 'text', text: cb.text ?? '' };
          else if (cb.type === 'thinking') block = { type: 'thinking', text: cb.thinking ?? '' };
          else if (cb.type === 'redacted_thinking') {
            block = { type: 'thinking', text: '[思考内容已加密]' };
            // 工具循环要求把加密块原样带回，data 存在内部字段，不进入协议
            (block as AnyBlock).redacted = cb.data;
          }
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
          applyAnthropicUsage(json.usage, usage);
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
    if (idle.timedOut) throw idleTimeoutError(req.idleTimeoutSec);
    if (!isAbortError(err) && !req.signal.aborted) {
      finishToolInputs();
      throw err;
    }
  } finally {
    idle.clear();
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
