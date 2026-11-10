// Key 换用循环：按候选顺序尝试，失败后由调用方决定是否换 Key、是否记录状态。
// 两侧差异用参数保留：网关只对 retryable 失败换 Key；工作站换 Key 前先看是否已有输出。
import type { StoredProfile, StoredProfileKey } from '../types.js';
import { errorMessage } from '../util/text.js';

export interface UpstreamCandidate {
  keyId?: string;
  label?: string;
  profile: StoredProfile;
  /** 工作站侧需要 Key 记录来更新停用/冷却状态。 */
  key?: StoredProfileKey;
}

export interface KeyAttemptFailure {
  candidate: UpstreamCandidate;
  keyId?: string;
  status: number;
  message: string;
  retryable: boolean;
  error: unknown;
}

export interface KeyRotationResult<T> {
  ok: boolean;
  candidate?: UpstreamCandidate;
  value?: T;
  failures: KeyAttemptFailure[];
  last?: KeyAttemptFailure;
  aborted: boolean;
  /** 遇到不可重试的失败，调用方按自己的错误格式返回。 */
  fatal?: KeyAttemptFailure;
  /** 已有输出/已取消：调用方应抛出 last.error。 */
  rethrown: boolean;
}

export interface KeyRotationOptions<T> {
  candidates: UpstreamCandidate[];
  signal: AbortSignal;
  attempt(candidate: UpstreamCandidate): Promise<T>;
  /** 失败后是否换下一个 Key；缺省总是换。 */
  canRetry?(failure: KeyAttemptFailure): boolean;
  /** 失败后是否停止并抛错（例如已经向客户端输出过内容）。 */
  shouldRethrow?(failure: KeyAttemptFailure): boolean;
  onFailure?(failure: KeyAttemptFailure): void;
}

function toFailure(candidate: UpstreamCandidate, error: unknown): KeyAttemptFailure {
  const status = (error as { status?: unknown } | undefined)?.status;
  const retryable = (error as { retryable?: unknown } | undefined)?.retryable;
  return {
    candidate,
    ...(candidate.keyId ? { keyId: candidate.keyId } : {}),
    status: typeof status === 'number' ? status : 0,
    message: errorMessage(error),
    retryable: typeof retryable === 'boolean' ? retryable : true,
    error,
  };
}

export async function runKeyRotation<T>(opts: KeyRotationOptions<T>): Promise<KeyRotationResult<T>> {
  const failures: KeyAttemptFailure[] = [];
  const result = (aborted: boolean): KeyRotationResult<T> => {
    const last = failures[failures.length - 1];
    return { ok: false, failures, ...(last ? { last } : {}), aborted, rethrown: false };
  };
  for (const candidate of opts.candidates) {
    if (opts.signal.aborted) return result(true);
    try {
      const value = await opts.attempt(candidate);
      return { ok: true, candidate, value, failures, aborted: false, rethrown: false };
    } catch (error) {
      const failure = toFailure(candidate, error);
      failures.push(failure);
      opts.onFailure?.(failure);
      if (opts.shouldRethrow?.(failure)) {
        return { ok: false, failures, last: failure, aborted: opts.signal.aborted, rethrown: true };
      }
      if (opts.canRetry && !opts.canRetry(failure)) {
        return { ok: false, failures, last: failure, aborted: false, rethrown: false, fatal: failure };
      }
    }
  }
  return result(opts.signal.aborted);
}
