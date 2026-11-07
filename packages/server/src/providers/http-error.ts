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

/** provider 返回「上下文超长」类错误：可压缩历史后重试一次。 */
export function isContextLengthError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as { status?: unknown }).status;
  const message = err instanceof Error ? err.message : String(err);
  if (
    !/context[_ ]length[_ ]exceeded|prompt is too long|maximum context length|context window|too many (?:input )?tokens|input is too long|reduce the length of the (?:messages|prompt)|exceeds? the (?:model'?s? )?context/i.test(
      message,
    ) &&
    !/上下文.{0,12}(?:超长|过长|超过|上限)/.test(message)
  ) {
    return false;
  }
  // 有状态码时只接受 400/413；有些兼容端点用 422/500 返回，保留按文案判断
  return typeof status !== 'number' || status === 400 || status === 413 || status === 422 || status >= 500;
}
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
