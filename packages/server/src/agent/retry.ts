// 模型请求网络中断续跑：网络错误/超时（含已有重试）全部失败后不结束回合，
// 进入「等待网络」指数退避重试（单次最长 2 分钟，总计最长 30 分钟）。
import type { Host } from '../host.js';
import type { SessionRecord } from '../types.js';
import { isContextLengthError } from '../providers/http-error.js';
import { errorMessage, truncateEnd } from '../util/text.js';

export const RETRY_WINDOW_MS = 30 * 60_000;
export const RETRY_MAX_DELAY_MS = 2 * 60_000;
const RETRY_BASE_DELAY_MS = 2_000;

/** 只对网络/超时/服务端临时故障重试；鉴权、参数、内容过滤等 4xx 直接失败。 */
export function isRetryableProviderError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'AbortError') return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') {
    if (status === 408 || status === 409 || status === 425 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }
  const message = errorMessage(err);
  if (/用户中断|已中断|cancell?ed by user/i.test(message)) return false;
  return /fetch failed|failed to fetch|network|networkerror|econnreset|econnrefused|econnaborted|etimedout|enotfound|eai_again|epipe|socket hang up|socket|terminated|other side closed|connection (?:closed|reset|lost|error)|stream (?:error|closed|interrupted)|premature close|timed? ?out|timeout|无响应|网络|断线|连接.*(?:失败|中断|关闭)|空闲超时|\b(?:500|502|503|504|429)\b/i.test(
    message,
  );
}

function clearRetry(host: Host, rec: SessionRecord): void {
  const rt = host.ensureRuntime(rec.id);
  if (rt.retryInfo) delete rt.retryInfo;
  if (rec.retryInfo) delete rec.retryInfo;
  if (rt.retryWake) delete rt.retryWake;
}

function delayFor(attempt: number): number {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * 包一层网络重试。run 内是完整的一次模型请求（含同组多 Key 切换）。
 * onBeforeRetry 在每次真正重试前调用（用于清空上一次流式输出，避免重复内容）。
 */
export async function withNetworkRetry<T>(
  host: Host,
  rec: SessionRecord,
  signal: AbortSignal,
  run: () => Promise<T>,
  onBeforeRetry?: () => void,
): Promise<T> {
  const rt = host.ensureRuntime(rec.id);
  const startedAt = Date.now();
  let attempt = 0;

  for (;;) {
    try {
      const value = await run();
      clearRetry(host, rec);
      if (rec.status === 'retrying') host.setStatus(rec, 'running');
      return value;
    } catch (err) {
      if (signal.aborted || isContextLengthError(err) || !isRetryableProviderError(err)) {
        clearRetry(host, rec);
        host.broadcastSummary(rec);
        throw err;
      }
      if (Date.now() - startedAt >= RETRY_WINDOW_MS) {
        clearRetry(host, rec);
        host.broadcastSummary(rec);
        throw new Error(
          `网络持续中断超过 30 分钟，已停止重试。最近错误：${truncateEnd(errorMessage(err), 300)}`,
        );
      }
      attempt += 1;
      const delay = delayFor(attempt);
      const nextAt = Date.now() + delay;
      const lastError = truncateEnd(errorMessage(err), 300);
      rt.retryInfo = { attempt, nextAt, lastError };
      rec.retryInfo = { attempt, nextAt, lastError };
      host.setStatus(rec, 'retrying');
      host.broadcastSummary(rec);
      host.store.markDirty(rec.id, false);
      await waitForRetry(rt, delay, signal);
      if (signal.aborted) {
        clearRetry(host, rec);
        host.broadcastSummary(rec);
        throw err;
      }
      // 立即重试：清空上一次的流式内容后重新请求，成功时不会重复已输出文本
      onBeforeRetry?.();
      host.setStatus(rec, 'running');
    }
  }
}

function waitForRetry(
  rt: ReturnType<Host['ensureRuntime']>,
  delay: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (aborted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      delete rt.retryWake;
      if (aborted) reject(new Error('用户中断'));
      else resolve();
    };
    const timer = setTimeout(() => finish(false), delay);
    const onAbort = () => finish(true);
    signal.addEventListener('abort', onAbort, { once: true });
    rt.retryWake = () => finish(false);
  });
}
