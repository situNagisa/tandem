import { truncateEnd } from '../util/text.js';

/** 带 HTTP 状态码的 provider 错误：多 Key 切换据此判定停用 / 冷却。 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, message: string, url: string) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.url = url;
  }
}

export function providerHttpError(
  status: number,
  body: string,
  url: string,
  statusText = '',
): ProviderHttpError {
  return new ProviderHttpError(status, describeHttpError(status, body, url, statusText), url);
}

/** 把 provider 的 HTTP 错误响应整理成用户能看懂的一句话（不把 HTML 页面原样抛给界面）。 */
export function describeHttpError(status: number, body: string, url: string, statusText = ''): string {
  const text = (body || '').trim();
  let detail = '';
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    detail = typeof j.error === 'string' ? j.error : j.error?.message || j.message || '';
  } catch {
    if (/^<!doctype html|^<html/i.test(text)) {
      const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
      detail = `服务器返回了网页而不是 API 响应${title ? `（${title}）` : ''}，请检查接口地址是否正确`;
    } else {
      detail = text;
    }
  }
  const hint =
    status === 401 || status === 403 ? 'Key 无效或无权限' :
    status === 404 || status === 405 ? '接口地址或协议类型可能不对' :
    status === 429 ? '请求过于频繁或额度不足' :
    status >= 500 ? '服务端暂时不可用' : '';
  let host = url;
  try { host = new URL(url).host; } catch { /* 保持原样 */ }
  const head = `${host} 返回 ${status}${hint ? `：${hint}` : ''}`;
  return detail ? `${head}。${truncateEnd(detail || statusText, 300)}` : head;
}
