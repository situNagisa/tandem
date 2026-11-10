// SSE 解析：按空行分隔事件，支持 data 多行。provider 事件流与网关原始透传共用。
import type { Usage } from '@tandem/protocol';
import { isAbortError } from '../util/text.js';
import { applyAnthropicUsage, applyOpenAiUsage } from './usage.js';

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * 发起流式请求。连接池里的空闲连接可能已被对端关闭，首个请求会以 fetch failed 失败；
 * 在拿到响应之前重试一次，避免整轮直接报错。中断/超时不重试。
 */
export async function fetchSse(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted || isAbortError(err)) throw err;
    return fetch(url, init);
  }
}

export async function* readSse(response: Response, onData?: () => void): AsyncGenerator<SseEvent> {
  if (!response.body) throw new Error('响应没有 body，无法读取流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, idx);
        const sepLen = buffer[idx] === '\r' ? 4 : 2;
        buffer = buffer.slice(idx + sepLen);
        const ev = parseEvent(raw);
        if (ev) {
          // 只有真正的数据事件才算“有输出”；心跳/注释不能重置空闲计时器。
          onData?.();
          yield ev;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const ev = parseEvent(buffer);
      if (ev) {
        onData?.();
        yield ev;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(raw: string): SseEvent | undefined {
  const dataLines: string[] = [];
  let event: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join('\n') };
}

/** 网关原样转发时逐块喂入文本，累计 usage；不改变转发字节。 */
export function createSseUsageTracker(
  protocol: 'openai' | 'anthropic',
  usage: Usage,
): { push(text: string): void; end(): void } {
  let buffer = '';
  const handleEvent = (raw: string) => {
    const ev = parseEvent(raw);
    if (!ev) return;
    const data = ev.data.trim();
    if (!data || data === '[DONE]') return;
    try {
      const json = JSON.parse(data) as Record<string, any>;
      if (protocol === 'openai') {
        applyOpenAiUsage(json.usage, usage, { merge: 'max', inputAliases: true, outputAliases: true, cachedAlias: true });
      } else if (json.type === 'message_start') {
        applyAnthropicUsage(json.message?.usage, usage);
      } else if (json.type === 'message_delta') {
        applyAnthropicUsage(json.usage, usage);
      }
    } catch {
      /* 不完整/非 JSON 事件忽略 */
    }
  };
  return {
    push(text: string) {
      buffer += text.replace(/\r\n/g, '\n');
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        handleEvent(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    },
    end() {
      if (buffer.trim()) handleEvent(buffer);
      buffer = '';
    },
  };
}
