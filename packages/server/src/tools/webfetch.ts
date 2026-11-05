// WebFetch：抓取 URL 并转成纯文本（截断）。
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { htmlToText } from '../util/html.js';
import { truncateEnd } from '../util/text.js';

const MAX_BYTES = 5 * 1024 * 1024;

export const definition: ToolDefinition = {
  name: 'WebFetch',
  readOnly: true,
  requiresApproval: true,
  description:
    'Fetches a URL, converts HTML to plain text and returns the content (truncated). ' +
    'Use the prompt to state what you are looking for in the page.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch. Must include http:// or https://.' },
      prompt: { type: 'string', description: 'What to extract or answer from the page.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
};

export async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!/^https?:\/\//i.test(url)) return { content: 'url 必须以 http:// 或 https:// 开头', isError: true };
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; Tandem/0.1; +https://github.com/tandem)',
        accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      return { content: `请求失败: HTTP ${res.status} ${res.statusText}`, isError: true };
    }
    let text = await res.text();
    if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES);

    const contentType = res.headers.get('content-type') ?? '';
    let body: string;
    if (/html/i.test(contentType) || /^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text)) {
      body = htmlToText(text);
    } else {
      body = text;
    }

    const header = `URL: ${res.url || url}\n状态: ${res.status}\n\n`;
    const footer = prompt ? `\n\n[请基于以上内容回答：${prompt}]` : '';
    return { content: truncateEnd(header + body + footer, 30_000) };
  } catch (err) {
    const message = (err as Error).name === 'TimeoutError' ? '请求超时（30s）' : (err as Error).message;
    return { content: `抓取失败: ${message}`, isError: true };
  }
}
