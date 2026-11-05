// SSE 解析：按空行分隔事件，支持 data 多行。
export interface SseEvent {
  event?: string;
  data: string;
}

export async function* readSse(response: Response): AsyncGenerator<SseEvent> {
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
        if (ev) yield ev;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const ev = parseEvent(buffer);
      if (ev) yield ev;
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
