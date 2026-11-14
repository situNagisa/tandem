/**
 * 消息区滚动控制器：每个 `.chat-scroll` 一个实例（方案见 docs/archive/plan/scroll-controller-2026-11-14.md）。
 *
 * 它是消息区 `scrollTop` 的唯一写者：DOM 事件、ResizeObserver / MutationObserver、rAF 都绑在这里，
 * 组件只发意图（open / follow …）并订阅结论。是否贴底、这次 scroll 事件是谁引起的，全部按
 * 纯函数 `chatScroll.ts` 的写入记账（write ledger）判定，不用时间窗。
 *
 * 本步接入的是 ChatView 的贴底、跟随、上翻、回到底部、切换会话与尺寸变化；
 * 跳转（jump.ts）与 MessageList 的锚点仍是各自实现，控制器只保证不与它们抢写点。
 */
import {
  atBottom,
  classifyScroll,
  next,
  showFollowButton,
  springDt,
  stepSpring,
  type ScrollEvent,
  type ScrollSample,
  type ScrollState,
  type WriteMark,
} from './chatScroll'

export type UserCause = 'wheel' | 'touch' | 'pointer' | 'key' | 'scrollbar'

export interface ScrollSnapshot {
  top: number
  height: number
  client: number
  atBottom: boolean
}

/** 视口内第一条可见行：尺寸变化后用它把画面补回原位。 */
interface TopRow {
  id: string
  offset: number
}

export interface ChatScrollController {
  readonly state: ScrollState
  /** 状态种类或「回到底部」按钮的显示发生变化时通知。 */
  subscribe(listener: (state: ScrollState) => void): () => void

  // 生命周期（由 useChatScrollController 绑定 DOM）
  attach(box: HTMLElement, content: HTMLElement, key: string): void
  /** 滚动区节点被卸载（如切到子代理只读视图）：停掉观察与动画，保留状态。 */
  detachDom(): void
  destroy(): void

  /** A/H：打开或切到另一个会话，重置并进入 settling（同步写底，之后随内容增长贴底）。 */
  open(key: string): void
  /** D：回到底部；smooth 时由控制器逐帧弹簧，不用原生 smooth（原生中间帧无法记账）。 */
  follow(opts?: { smooth?: boolean }): void
  /** 外部（jump.ts）即将写 scrollTop：先让出跟随，避免观察器补偿与它抢写点。 */
  yieldToJump(): void
  /** 声明这是一次用户滚动（覆盖式滚动条拖动等控制器收不到输入的场景）。 */
  notifyUserScroll(cause: UserCause): void

  snapshot(): ScrollSnapshot
  showFollowButton(): boolean
}

const KEY_UP = new Set(['PageUp', 'ArrowUp', 'Home'])
const KEY_DOWN = new Set(['PageDown', 'ArrowDown', 'End', ' '])

/** 用户最后一次滚动方向：只有它能把「滚回底部」认作恢复跟随。 */
type ScrollIntent = 'up' | 'down' | null

class ChatScrollControllerImpl implements ChatScrollController {
  state: ScrollState = { kind: 'idle' }

  private box: HTMLElement | null = null
  private content: HTMLElement | null = null
  private key: string | null = null
  private listeners = new Set<(state: ScrollState) => void>()

  /** 上一次 scroll 事件看到的位置；只由 scroll 与我们的写入更新。 */
  private prev: ScrollSample = { top: 0, height: 0, client: 0 }
  /** 最后一次写入后的真实位置（被浏览器夹紧后也记真实值）。 */
  private mark: WriteMark = { top: 0, height: 0, writtenAt: 0 }
  /** 上次观察到的内容高度：用来看「这一帧内容有没有增高」。 */
  private lastHeight = -1
  private boxSize = ''
  private topRow: TopRow | null = null
  private buttonShown = false

  private raf = 0
  private anchorRaf = 0
  private tempAnchor: TopRow | null = null
  private tempFrames = 0
  private lastFrameAt = 0
  private heightAtLastFrame = -1
  private spring: { pos: number; vel: number } | null = null
  private touchStartY: number | null = null
  private scrollIntent: ScrollIntent = null

  private ro: ResizeObserver | null = null
  private boxRo: ResizeObserver | null = null
  private mo: MutationObserver | null = null

  /* ------------------------------------------------------------ 生命周期 */

  attach(box: HTMLElement, content: HTMLElement, key: string): void {
    if (this.box === box && this.content === content) {
      if (this.key !== key) this.open(key)
      return
    }
    this.teardownDom()
    this.box = box
    this.content = content
    this.prev = this.sample()
    this.mark = { top: this.prev.top, height: this.prev.height, writtenAt: 0 }
    this.lastHeight = -1
    this.boxSize = `${box.clientWidth}x${box.clientHeight}`
    this.topRow = null
    this.tempAnchor = null
    this.tempFrames = 0
    this.heightAtLastFrame = -1
    this.bind()
    if (this.key !== key) {
      this.open(key)
    } else if (this.state.kind === 'following' || this.state.kind === 'settling') {
      // 滚动区节点重新挂载（从子代理视图返回）：新节点从 0 开始，直接补到底。
      this.writeBottom()
      this.schedule()
    }
  }

  detachDom(): void {
    this.teardownDom()
    this.box = null
    this.content = null
  }

  destroy(): void {
    this.apply({ type: 'destroy' })
    this.teardownDom()
    this.box = null
    this.content = null
    this.listeners.clear()
  }

  private bind(): void {
    const box = this.box
    const content = this.content
    if (!box || !content) return
    box.addEventListener('scroll', this.onScroll, { passive: true })
    box.addEventListener('wheel', this.onWheel, { passive: true })
    box.addEventListener('touchstart', this.onTouchStart, { passive: true })
    box.addEventListener('touchmove', this.onTouchMove, { passive: true })
    box.addEventListener('pointerdown', this.onPointerDown)
    box.addEventListener('keydown', this.onKeyDown)
    if (typeof ResizeObserver !== 'undefined') {
      // 两个观察器分开：内容增高与滚动区尺寸变化要分派不同的补偿。
      this.ro = new ResizeObserver(() => this.onContentResize())
      this.ro.observe(content)
      this.boxRo = new ResizeObserver(() => this.onBoxResize())
      this.boxRo.observe(box)
    }
    if (typeof MutationObserver !== 'undefined') {
      // 新增一行（占位条、审批卡）是微任务，能赶在绘制前补回底部。
      this.mo = new MutationObserver(() => this.onContentResize())
      this.mo.observe(content, { childList: true, subtree: true })
    }
  }

  private teardownDom(): void {
    const box = this.box
    if (box) {
      box.removeEventListener('scroll', this.onScroll)
      box.removeEventListener('wheel', this.onWheel)
      box.removeEventListener('touchstart', this.onTouchStart)
      box.removeEventListener('touchmove', this.onTouchMove)
      box.removeEventListener('pointerdown', this.onPointerDown)
      box.removeEventListener('keydown', this.onKeyDown)
    }
    this.ro?.disconnect()
    this.boxRo?.disconnect()
    this.mo?.disconnect()
    this.ro = null
    this.boxRo = null
    this.mo = null
    this.stopFrames()
    if (this.anchorRaf) window.cancelAnimationFrame(this.anchorRaf)
    this.anchorRaf = 0
    this.tempAnchor = null
    this.tempFrames = 0
    this.spring = null
    this.touchStartY = null
  }

  /* -------------------------------------------------------------- 意图 */

  open(key: string): void {
    this.key = key
    this.lastHeight = -1
    this.topRow = null
    this.tempAnchor = null
    this.tempFrames = 0
    this.spring = null
    this.apply({ type: 'open', key })
  }

  follow(opts?: { smooth?: boolean }): void {
    this.releaseTempAnchor()
    this.apply({ type: 'follow', smooth: opts?.smooth === true })
  }

  yieldToJump(): void {
    // 跳转自己逐帧写 scrollTop；这里只放弃跟随，不启动任何补偿。
    this.releaseTempAnchor()
    this.apply({ type: 'user-scroll', atBottom: false })
    this.spring = null
    this.updateButton()
  }

  notifyUserScroll(): void {
    this.leaveFollow()
  }

  /* ------------------------------------------------------------ 订阅 */

  subscribe(listener: (state: ScrollState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot(): ScrollSnapshot {
    const view = this.sample()
    return { ...view, atBottom: atBottom(view) }
  }

  showFollowButton(): boolean {
    return this.box ? showFollowButton(this.sample()) : false
  }

  /* ------------------------------------------------------- DOM 事件 */

  private onScroll = (): void => {
    const box = this.box
    if (!box) return
    const sample = this.sample()
    const cause = classifyScroll(this.prev, sample, this.mark)
    this.prev = sample
    if (cause === 'user') {
      // 只有用户滚动能改写跟随状态；记录视口首行，供尺寸变化时补回。
      // 「滚回底部恢复跟随」要求这是一次真的用户输入（滚轮/触摸/按键）：其他组件
      // 直接改 scrollTop（MessageList 的窗口锚点、锚点补偿）不能顺手把跟随打开。
      this.releaseTempAnchor()
      this.topRow = this.captureTopRow()
      const at = atBottom(sample) && this.scrollIntent === 'down'
      this.apply({ type: 'user-scroll', atBottom: at })
    }
    this.updateButton()
  }

  private onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return
    this.scrollIntent = event.deltaY < 0 ? 'up' : 'down'
    // 上滚的提前量：浏览器真正改变位置之前就停止跟随，避免同一帧里的补底把这次上滚吃掉。
    if (event.deltaY < 0) this.leaveFollow()
  }

  private onTouchStart = (event: TouchEvent): void => {
    this.touchStartY = event.touches[0]?.clientY ?? null
  }

  private onTouchMove = (event: TouchEvent): void => {
    const start = this.touchStartY
    const at = event.touches[0]?.clientY
    if (start == null || at == null) return
    if (Math.abs(at - start) < 2) return
    // 手指往下拖 = 看更早的内容；往上推 = 往更新的内容走。
    this.scrollIntent = at > start ? 'up' : 'down'
    if (this.scrollIntent === 'up') this.leaveFollow()
  }

  private onPointerDown = (event: PointerEvent): void => {
    // 只有点在滚动区自身（滚动条槽）上才算用户接管；点内容里的按钮/文字不算。
    if (event.target !== this.box) return
    // 槽内点击可能向上也可能向下，方向未知：先停跟随，不据此恢复。
    this.scrollIntent = null
    this.leaveFollow()
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (KEY_UP.has(event.key)) {
      this.scrollIntent = 'up'
      this.leaveFollow()
    } else if (KEY_DOWN.has(event.key)) {
      this.scrollIntent = 'down'
    }
  }

  private leaveFollow(): void {
    if (!this.box) return
    this.releaseTempAnchor()
    this.apply({ type: 'user-scroll', atBottom: false })
    this.spring = null
    this.updateButton()
  }

  /* ------------------------------------------------------- 观察器 */

  private onContentResize(): void {
    const box = this.box
    if (!box) return
    const height = box.scrollHeight
    if (height === this.lastHeight) return
    this.lastHeight = height
    this.apply({ type: 'content-grow' })
    if (this.tempAnchor) {
      // 尺寸变化后的重排还会持续几帧（content-visibility 换成真实高度）：临时锚点一直补到稳定。
      this.compensateTempAnchor()
    } else if (this.state.kind === 'detached') {
      // 内容增高会移动视口里的首行，但滚动位置没变、不会有 scroll 事件：
      // 延后一帧刷新锚点快照，尺寸变化时按用户此刻看到的位置补回。
      this.scheduleAnchorRefresh()
    }
  }

  private onBoxResize(): void {
    const box = this.box
    if (!box) return
    const size = `${box.clientWidth}x${box.clientHeight}`
    if (size === this.boxSize) return
    this.boxSize = size
    this.apply({ type: 'resize' })
  }

  /* --------------------------------------------------------- 迁移 */

  private apply(event: ScrollEvent): void {
    const previous = this.state
    const result = next(previous, event)
    this.state = result.state
    for (const effect of result.effects) this.run(effect)
    if (previous.kind !== result.state.kind) this.notify()
    if (this.state.kind === 'settling' || this.state.kind === 'anchoring') this.schedule()
    this.updateButton()
  }

  private run(effect: ReturnType<typeof next>['effects'][number]): void {
    switch (effect.type) {
      case 'write-bottom':
        this.writeBottom()
        break
      case 'spring-bottom':
        this.startSpring()
        break
      case 'temp-anchor':
        this.beginTempAnchor()
        break
      default:
        // 锚点与跳转（jump.ts）本步仍由各自实现负责。
        break
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener(this.state)
  }

  private updateButton(): void {
    if (!this.box) return
    const shown = showFollowButton(this.sample())
    if (shown === this.buttonShown) return
    this.buttonShown = shown
    this.notify()
  }

  /* --------------------------------------------------------- 写入 */

  private write(top: number): void {
    const box = this.box
    if (!box) return
    box.scrollTop = top
    this.mark = { top: box.scrollTop, height: box.scrollHeight, writtenAt: performance.now() }
    this.prev = this.sample()
  }

  private writeBottom(): void {
    const box = this.box
    if (!box) return
    // 读 scrollHeight 会触发布局：content-visibility 的新行会在这里撑高，写入后仍在底部。
    this.write(box.scrollHeight)
  }

  private startSpring(): void {
    const box = this.box
    if (!box) return
    this.spring = { pos: box.scrollTop, vel: 0 }
    this.schedule()
  }

  /** 尺寸变化后把视口首行补回原偏移（临时锚点：稳定 2 帧后释放，不等定时器）。 */
  private beginTempAnchor(): void {
    if (!this.box || this.state.kind !== 'detached') return
    this.tempAnchor = this.tempAnchor ?? this.topRow ?? this.captureTopRow()
    this.tempFrames = 0
    this.compensateTempAnchor()
    this.schedule()
  }

  private compensateTempAnchor(): void {
    const box = this.box
    const anchor = this.tempAnchor
    if (!box || !anchor) return
    const row = box.querySelector<HTMLElement>(
      `.msg-row[data-message-id="${CSS.escape(anchor.id)}"]`,
    )
    if (!row) {
      this.releaseTempAnchor()
      return
    }
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top
    const delta = offset - anchor.offset
    if (Math.abs(delta) >= 1) this.write(box.scrollTop + delta)
  }

  private releaseTempAnchor(): void {
    if (!this.tempAnchor) return
    this.tempAnchor = null
    this.tempFrames = 0
    if (this.state.kind === 'detached') this.topRow = this.captureTopRow()
  }

  /** 延后一帧刷新锚点快照：此时重排已经落定，看到的就是用户此刻的画面。 */
  private scheduleAnchorRefresh(): void {
    if (this.anchorRaf) return
    this.anchorRaf = window.requestAnimationFrame(() => {
      this.anchorRaf = 0
      if (this.state.kind === 'detached' && !this.tempAnchor) {
        this.topRow = this.captureTopRow()
      }
    })
  }

  private captureTopRow(): TopRow | null {
    const box = this.box
    if (!box) return null
    const boxTop = box.getBoundingClientRect().top
    for (const row of box.querySelectorAll<HTMLElement>('.msg-row[data-message-id]')) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom <= boxTop + 1) continue
      const id = row.dataset.messageId
      return id ? { id, offset: rect.top - boxTop } : null
    }
    return null
  }

  private sample(): ScrollSample {
    const box = this.box
    if (!box) return { top: 0, height: 0, client: 0 }
    return { top: box.scrollTop, height: box.scrollHeight, client: box.clientHeight }
  }

  /* ------------------------------------------------------- 帧循环 */

  private schedule(): void {
    if (this.raf) return
    this.lastFrameAt = performance.now()
    this.raf = window.requestAnimationFrame(this.tick)
  }

  private stopFrames(): void {
    if (this.raf) window.cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private tick = (now: number): void => {
    this.raf = 0
    const box = this.box
    if (!box) {
      this.spring = null
      return
    }
    const dt = springDt(now - this.lastFrameAt)
    this.lastFrameAt = now
    const height = box.scrollHeight
    const heightChanged = height !== this.heightAtLastFrame
    this.heightAtLastFrame = height
    if (this.spring) {
      if (this.state.kind !== 'settling') {
        this.spring = null
      } else {
        const goal = Math.max(0, height - box.clientHeight)
        // 内容增高时观察器可能已经先补到底：并入当前位置继续追，别把视口写回旧位置。
        if (Math.abs(box.scrollTop - this.spring.pos) > 1) {
          this.spring = { pos: box.scrollTop, vel: this.spring.vel }
        }
        const step = stepSpring(this.spring.pos, this.spring.vel, goal, dt)
        this.spring = step.done ? null : { pos: step.pos, vel: step.vel }
        this.write(step.done ? goal : step.pos)
      }
    }
    if (this.tempAnchor) {
      // 临时锚点：内容高度连续 2 帧不变才算这次重排结束。
      if (heightChanged) this.tempFrames = 0
      else this.tempFrames += 1
      if (this.tempFrames >= 2) this.releaseTempAnchor()
    }
    if (this.state.kind === 'settling' || this.state.kind === 'anchoring') {
      const view = this.sample()
      // settling 只表示「想贴底」：内容稳定却没在底部时补一次，避免空转。
      if (!heightChanged && !this.spring && !atBottom(view)) this.writeBottom()
      this.apply({ type: 'frame', heightChanged, atBottom: atBottom(this.sample()) })
    }
    if (this.spring || this.tempAnchor || this.state.kind === 'settling' || this.state.kind === 'anchoring') {
      this.schedule()
    }
  }
}

export function createChatScrollController(): ChatScrollController {
  return new ChatScrollControllerImpl()
}
