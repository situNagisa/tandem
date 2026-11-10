// OpenAI Chat Completions 适配（openai / openai-compatible / gemini OpenAI 兼容端点）。
import { providerHttpError } from './http-error.js';
import type { ContentBlock, Message, Usage } from '@tandem/protocol';
import { joinEndpoint, providerDefaultBaseUrl } from '../config.js';
import { isAbortError, truncateEnd } from '../util/text.js';
import { readSse, fetchSse } from '../upstream/sse.js';
import { postWithBodyFallbacks, summarizeUpstreamRejection } from '../upstream/request.js';
import { applyOpenAiUsage } from '../upstream/usage.js';
import { createIdleTimeout, idleTimeoutError } from './idle-timeout.js';
import { parseRateLimitHeaders, retryAfterMs } from './rate-limit.js';
import type { StreamRequest, StreamResult } from './types.js';
import { openaiReasoningEffort } from './capabilities.js';

type AnyRecord = Record<string, any>;

/** 内部消息 -> OpenAI messages（tool_use/tool_result 映射为 tool_calls / role:tool）。 */
export function toOpenAIMessages(messages: Message[], system: string): AnyRecord[] {
  const out: AnyRecord[] = [{ role: 'system', content: system }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const parts: AnyRecord[] = [];
      const toolMessages: AnyRecord[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          if (block.text) parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${block.mediaType};base64,${block.dataBase64}` },
          });
        } else if (block.type === 'tool_result') {
          toolMessages.push({
            role: 'tool',
            tool_call_id: block.toolUseId,
            content: block.content,
          });
        }
        // thinking 不回传给模型
      }
      out.push(...toolMessages);
      if (parts.length > 0) {
        const onlyText = parts.every((p) => p.type === 'text');
        out.push({
          role: 'user',
          content: onlyText ? parts.map((p) => p.text).join('\n') : parts,
        });
      }
    } else {
      const texts: string[] = [];
      const toolCalls: AnyRecord[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          if (block.text) texts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      if (texts.length === 0 && toolCalls.length === 0) continue;
      const message: AnyRecord = {
        role: 'assistant',
        content: texts.length > 0 ? texts.join('\n') : null,
      };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      out.push(message);
    }
  }
  return out;
}

/** Tandem 网关地址允许带或不带 /gateway/v1，统一去掉后再拼端点。 */
export function tandemGatewayBase(base: string): string {
  return base.trim().replace(/\/+$/, '').replace(/\/gateway\/v1$/i, '');
}

function baseUrlOf(req: StreamRequest): string {
  const base = req.profile.baseUrl || providerDefaultBaseUrl(req.profile.kind);
  if (!base) {
    throw new Error('该账号未配置 baseUrl（OpenAI 兼容接口需要填写端点地址）');
  }
  return base;
}

function chatUrl(base: string, kind: StreamRequest['profile']['kind']): string {
  if (kind === 'tandem-gateway') return joinEndpoint(tandemGatewayBase(base), '/gateway/v1/chat/completions');
  return joinEndpoint(base, '/chat/completions');
}

export async function streamOpenAI(req: StreamRequest): Promise<StreamResult> {
  const url = chatUrl(baseUrlOf(req), req.profile.kind);
  const idle = createIdleTimeout(req.signal, req.idleTimeoutSec);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${req.profile.apiKey}`,
  };

  const body: AnyRecord = {
    model: req.model,
    messages: toOpenAIMessages(req.messages, req.system),
    stream: true,
    stream_options: { include_usage: true },
  };
  // 新版 OpenAI 推理模型使用 max_completion_tokens；兼容接口仍用 max_tokens
  if (req.profile.kind === 'openai' && /^(o[1-9]|gpt-5|gpt-6)/i.test(req.model)) {
    body.max_completion_tokens = req.maxTokens;
  } else {
    body.max_tokens = req.maxTokens;
  }
  const reasoningEffort = openaiReasoningEffort(
    req.profile.kind,
    req.model,
    req.effort,
    req.profile.modelCapabilities,
  );
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    body.tool_choice = 'auto';
  }

  const send = async (payload: AnyRecord) => {
    const sent = await postWithBodyFallbacks<AnyRecord>({
      body: payload,
      send: (body) =>
        fetchSse(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: idle.signal,
        }),
      fallbacks: [
        // 模型/兼容服务不支持 reasoning_effort：去掉后重试一次
        {
          applies: (res, body) =>
            res.status === 400 &&
            !!body.reasoning_effort &&
            /reasoning|effort|thinking|思考|推理|unsupported|unknown|invalid.*param|not support|不支持|未知参数|不合法/i.test(
              res.text,
            ),
          drop: (body) => {
            const next = { ...body };
            delete next.reasoning_effort;
            return next;
          },
          onDropped: (rejected) =>
            req.onEffortDropped?.(summarizeUpstreamRejection(rejected, [req.profile.apiKey, req.profile.baseUrl])),
        },
        // 部分兼容服务不支持 stream_options，去掉后重试
        {
          applies: (res, body) => !!body.stream_options && /stream_options|include_usage/i.test(res.text),
          drop: (body) => {
            const next = { ...body };
            delete next.stream_options;
            return next;
          },
        },
      ],
    });
    if (!sent.res.ok) {
      throw providerHttpError(
        sent.res.status,
        sent.text,
        url,
        sent.res.statusText,
        parseRateLimitHeaders('openai', sent.res.headers),
        retryAfterMs(sent.res.headers),
      );
    }
    const limit = parseRateLimitHeaders('openai', sent.res.headers);
    if (limit) req.onRateLimit?.(limit);
    return sent.res;
  };

  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let nextIndex = 0;
  let textIndex = -1;
  let thinkingIndex = -1;
  const toolStates = new Map<number, { blockIndex: number; args: string }>();
  let stopReason: string | undefined;

  const ensureText = (): number => {
    if (textIndex < 0) {
      textIndex = nextIndex++;
      const block: ContentBlock = { type: 'text', text: '' };
      req.blocks[textIndex] = block;
      req.onBlockStart(textIndex, block);
    }
    return textIndex;
  };

  const ensureThinking = (): number => {
    if (thinkingIndex < 0) {
      thinkingIndex = nextIndex++;
      const block: ContentBlock = { type: 'thinking', text: '' };
      req.blocks[thinkingIndex] = block;
      req.onBlockStart(thinkingIndex, block);
    }
    return thinkingIndex;
  };

  const finishToolInputs = () => {
    for (const state of toolStates.values()) {
      const block = req.blocks[state.blockIndex];
      if (!block || block.type !== 'tool_use') continue;
      try {
        block.input = state.args.trim() ? JSON.parse(state.args) : {};
      } catch {
        block.input = {};
      }
    }
    toolStates.clear();
  };

  try {
    const res = await send(body);
    for await (const ev of readSse(res, idle.reset)) {
      if (ev.data === '[DONE]') break;
      let json: AnyRecord;
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (json.error) {
        throw new Error(json.error.message ?? '模型接口返回错误');
      }
      if (json.usage) applyOpenAiUsage(json.usage, usage, { merge: 'replace', cachedAlias: false });
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (choice.finish_reason) stopReason = choice.finish_reason;

      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        const index = ensureThinking();
        const block = req.blocks[index];
        if (block?.type === 'thinking') {
          block.text += reasoning;
          req.onText(index, reasoning);
        }
      }

      if (typeof delta.content === 'string' && delta.content) {
        const index = ensureText();
        const block = req.blocks[index];
        if (block?.type === 'text') {
          block.text += delta.content;
          req.onText(index, delta.content);
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as AnyRecord[]) {
          const streamIndex: number = tc.index ?? 0;
          let state = toolStates.get(streamIndex);
          if (!state) {
            const blockIndex = nextIndex++;
            state = { blockIndex, args: '' };
            toolStates.set(streamIndex, state);
            const block: ContentBlock = {
              type: 'tool_use',
              id: tc.id || `call_${streamIndex}`,
              name: tc.function?.name || 'unknown',
              input: {},
            };
            req.blocks[blockIndex] = block;
            req.onBlockStart(blockIndex, block);
          }
          const block = req.blocks[state.blockIndex];
          if (!block || block.type !== 'tool_use') continue;
          if (tc.id && block.id.startsWith('call_')) block.id = tc.id;
          if (tc.function?.name && block.name === 'unknown') block.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
            state.args += tc.function.arguments;
            req.onToolInput(state.blockIndex, tc.function.arguments);
          }
        }
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

  return { usage, stopReason };
}

/** 验证 key：发一条极小请求。 */
export async function testOpenAI(
  baseUrl: string | undefined,
  kind: StreamRequest['profile']['kind'],
  apiKey: string,
  model: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const base = baseUrl || providerDefaultBaseUrl(kind);
  if (!base) return { ok: false, error: '未配置 baseUrl' };
  const url = kind === 'tandem-gateway'
    ? joinEndpoint(tandemGatewayBase(base), '/gateway/v1/chat/completions')
    : joinEndpoint(base, '/chat/completions');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      ...(kind === 'openai' && /^(o[1-9]|gpt-5|gpt-6)/i.test(model)
        ? { max_completion_tokens: 16 }
        : { max_tokens: 1 }),
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
