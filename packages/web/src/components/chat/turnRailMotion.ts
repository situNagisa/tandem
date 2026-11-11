// 轮次条的动效内核：轻量 spring（只写 transform/opacity，不触发布局）。
// 对话区的定位与取消统一在 lib/jump.ts。

let reducedQuery: MediaQueryList | null = null
export function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false
  reducedQuery ??= matchMedia('(prefers-reduced-motion: reduce)')
  return reducedQuery.matches
}

/** 半隐式欧拉弹簧，内部按 ≤4ms 子步积分，帧率抖动时手感不变。 */
export class Spring {
  x: number
  v = 0
  t: number
  constructor(
    x: number,
    private k: number,
    private c: number,
    private eps = 0.001,
  ) {
    this.x = x
    this.t = x
  }
  step(dt: number): void {
    const n = Math.max(1, Math.ceil(dt / 0.004))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - this.t) - this.c * this.v) * h
      this.x += this.v * h
    }
    if (this.settled) {
      this.x = this.t
      this.v = 0
    }
  }
  get settled(): boolean {
    return Math.abs(this.v) < this.eps * 8 && Math.abs(this.x - this.t) < this.eps
  }
  snap(value = this.t): void {
    this.x = value
    this.t = value
    this.v = 0
  }
}
