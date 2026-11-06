// OpenAI Chat Completions 适配（openai / openai-compatible / gemini OpenAI 兼容端点）。
import { describeHttpError } from './http-error.js';
import type { ContentBlock, Message, Usage } from '@tandem/protocol';
import { joinEndpoint, providerDefaultBaseUrl } from '../config.js';
import { isAbortError, truncateEnd } from '../util/text.js';
import { readSse, fetchSse } from './sse.js';
import { createIdleTimeout, idleTimeoutError } from './idle-timeout.js';
import type { StreamRequest, StreamResult } from './types.js';

type AnyRecord = Record<string, any>;

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

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

function baseUrlOf(req: StreamRequest): string {
  const base = req.profile.baseUrl || providerDefaultBaseUrl(req.profile.kind);
  if (!base) {
    throw new Error('该账号未配置 baseUrl（OpenAI 兼容接口需要填写端点地址）');
  }
  return base;
}

export async function streamOpenAI(req: StreamRequest): Promise<StreamResult> {
  const url = joinEndpoint(baseUrlOf(req), '/chat/completions');
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
  if (req.effort && req.effort !== 'off') {
    body.reasoning_effort = req.effort === 'max' ? 'high' : req.effort;
  }
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
    const current = { ...payload } as AnyRecord;
    let droppedEffort = false;
    let droppedStreamOptions = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetchSse(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(current),
        signal: idle.signal,
      });
      if (res.ok) {
        if (droppedEffort) req.onEffortDropped?.();
        return res;
      }
      const text = await res.text();
      // 模型/兼容服务不支持 reasoning_effort：去掉后重试一次
      if (
        !droppedEffort &&
        current.reasoning_effort &&
        res.status === 400 &&
        /reasoning|unsupported|unknown|invalid.*param|not support/i.test(text)
      ) {
        droppedEffort = true;
        delete current.reasoning_effort;
        continue;
      }
      // 部分兼容服务不支持 stream_options，去掉后重试
      if (
        !droppedStreamOptions &&
        current.stream_options &&
        /stream_options|include_usage/i.test(text)
      ) {
        droppedStreamOptions = true;
        delete current.stream_options;
        continue;
      }
      throw new Error(describeHttpError(res.status, text, url, res.statusText));
    }
    throw new Error(describeHttpError(400, '请求参数不被模型支持', url));
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
      if (json.usage) {
        const rawPrompt = numOr(json.usage.prompt_tokens, 0);
        // OpenAI 的 prompt_tokens 已包含 cached_tokens；内部 Usage 记录未命中部分。
        const cached = numOr(
          json.usage.prompt_tokens_details?.cached_tokens,
          numOr(json.usage.prompt_cache_hit_tokens, 0),
        );
        usage.inputTokens = Math.max(0, rawPrompt - cached);
        usage.cacheReadTokens = cached;
        usage.outputTokens = numOr(json.usage.completion_tokens, usage.outputTokens);
        usage.reasoningTokens = numOr(
          json.usage.completion_tokens_details?.reasoning_tokens,
          numOr(json.usage.reasoning_tokens, 0),
        );
      }
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
  const res = await fetch(joinEndpoint(base, '/chat/completions'), {
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
