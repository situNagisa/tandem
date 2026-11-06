// 令牌桶：带宽限流。允许透支，返回需要等待的毫秒数，由调用方暂停数据源而不是丢数据。
export class Bucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  take(bytes: number): number {
    if (this.rate <= 0) return 0;
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    this.tokens -= bytes;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rate) * 1000);
  }
}

/** 每个 key 的并发计数。 */
export class Counter {
  private counts = new Map<string, number>();

  tryAcquire(key: string, max: number): boolean {
    const n = this.counts.get(key) ?? 0;
    if (n >= max) return false;
    this.counts.set(key, n + 1);
    return true;
  }

  release(key: string): void {
    const n = (this.counts.get(key) ?? 0) - 1;
    if (n > 0) this.counts.set(key, n);
    else this.counts.delete(key);
  }
}

export interface RelayLimits {
  maxHosts: number;
  maxStreamsPerHost: number;
  /** 每个来源 IP 的并发客户端连接数（HTTP + WS）。 */
  maxConnsPerIp: number;
  /** 每个来源 IP 的并发 Host 隧道数。 */
  maxTunnelsPerIp: number;
  /** 每个 Host 双向合计的带宽上限（字节/秒），0 = 不限。 */
  bytesPerSec: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxHosts: 1000,
  maxStreamsPerHost: 256,
  maxConnsPerIp: 128,
  maxTunnelsPerIp: 8,
  bytesPerSec: 16 * 1024 * 1024,
};
