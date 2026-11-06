// 轮次条的动效内核：轻量 spring + 对话区滚动跟随。只写 transform/opacity，不触发布局。

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

export interface ScrollFollower {
  /** locate 每帧重新取目标 scrollTop（按消息 id 找元素），跳过 content-visibility 的估算高度。 */
  to(locate: () => number | null, instant?: boolean): void
  cancel(): void
  readonly running: boolean
  destroy(): void
}

const FOLLOW_K = 240
const FOLLOW_C = 31

/**
 * 对话区滚动跟随：临界阻尼弹簧追一个"实时目标"。
 * 距离很远时先瞬移到目标前约 1 屏，再弹簧滑入，避免长距离动画中途反复改落点。
 */
export function createScrollFollower(
  getRoot: () => HTMLElement | null,
  onUserScroll: () => void,
): ScrollFollower {
  let raf = 0
  let locate: (() => number | null) | null = null
  let pos = 0
  let vel = 0
  let last = 0
  let written = 0
  let verifyTimer = 0
  let verifies = 0
  let teleported = false

  const stop = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    window.clearTimeout(verifyTimer)
    locate = null
  }

  const frame = (now: number) => {
    raf = 0
    const root = getRoot()
    if (!root || !locate) return stop()
    const dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000))
    last = now
    // 滚动锚定会在 content-visibility 渲染后改 scrollTop：并入当前位置继续追，真正的用户操作由 onInterrupt 处理。
    if (Math.abs(root.scrollTop - written) > 1) pos = root.scrollTop
    const target = locate()
    if (target == null) return stop()
    const max = Math.max(0, root.scrollHeight - root.clientHeight)
    const goal = Math.min(max, Math.max(0, target))
    if (!teleported) {
      teleported = true
      const reach = root.clientHeight * 2.2
      if (Math.abs(goal - pos) > reach) {
        pos = goal - Math.sign(goal - pos) * root.clientHeight * 1.1
        vel = 0
      }
    }
    const n = Math.max(1, Math.ceil(dt / 0.004))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      vel += (FOLLOW_K * (goal - pos) - FOLLOW_C * vel) * h
      pos += vel * h
    }
    const done = Math.abs(goal - pos) < 0.5 && Math.abs(vel) < 6
    if (done) pos = goal
    root.scrollTop = pos
    written = root.scrollTop
    if (done) {
      const keep = locate
      raf = 0
      // 渲染后行高会变成真实值，稍后复核一次落点
      window.clearTimeout(verifyTimer)
      if (verifies < 2) {
        verifies++
        verifyTimer = window.setTimeout(() => {
          const r = getRoot()
          const t = keep()
          if (r && t != null && Math.abs(Math.min(Math.max(0, r.scrollHeight - r.clientHeight), t) - r.scrollTop) > 3) {
            locate = keep
            teleported = true
            pos = r.scrollTop
            vel = 0
            written = r.scrollTop
            last = performance.now()
            raf = requestAnimationFrame(frame)
          } else {
            locate = null
          }
        }, 140)
      } else {
        locate = null
      }
      return
    }
    raf = requestAnimationFrame(frame)
  }

  const onInterrupt = () => {
    if (raf || locate) stop()
    onUserScroll()
  }
  let attached: HTMLElement | null = null
  const attach = (root: HTMLElement) => {
    if (attached === root) return
    attached?.removeEventListener('wheel', onInterrupt)
    attached?.removeEventListener('touchstart', onInterrupt)
    attached?.removeEventListener('pointerdown', onInterrupt)
    attached = root
    root.addEventListener('wheel', onInterrupt, { passive: true })
    root.addEventListener('touchstart', onInterrupt, { passive: true })
    root.addEventListener('pointerdown', onInterrupt, { passive: true })
  }

  return {
    to(next, instant = false) {
      const root = getRoot()
      if (!root) return
      attach(root)
      window.clearTimeout(verifyTimer)
      locate = next
      verifies = 0
      if (instant || prefersReducedMotion()) {
        if (raf) cancelAnimationFrame(raf)
        raf = 0
        const t = next()
        if (t != null) {
          root.scrollTop = t
          written = root.scrollTop
        }
        pos = root.scrollTop
        vel = 0
        teleported = true
        verifyTimer = window.setTimeout(() => {
          const r = getRoot()
          const t2 = next()
          if (r && t2 != null && Math.abs(t2 - r.scrollTop) > 3) r.scrollTop = t2
          locate = null
        }, 140)
        return
      }
      teleported = false
      if (!raf) {
        pos = root.scrollTop
        written = root.scrollTop
        vel = 0
        last = performance.now()
        raf = requestAnimationFrame(frame)
      }
    },
    cancel() {
      stop()
    },
    get running() {
      return raf !== 0 || locate !== null
    },
    destroy() {
      stop()
      attached?.removeEventListener('wheel', onInterrupt)
      attached?.removeEventListener('touchstart', onInterrupt)
      attached?.removeEventListener('pointerdown', onInterrupt)
      attached = null
    },
  }
}
