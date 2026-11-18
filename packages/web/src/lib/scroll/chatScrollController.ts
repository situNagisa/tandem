/**
 * 消息区滚动控制器：每个 `.chat-scroll` 一个实例（方案见 docs/archive/plan/scroll-controller-2026-11-14.md）。
 *
 * 它是消息区 `scrollTop` 的唯一写者：DOM 事件、ResizeObserver / MutationObserver、rAF 都绑在这里，
 * 组件只发意图（open / follow / jump / beginAnchor …）并订阅结论。是否贴底、这次 scroll 事件是
 * 谁引起的，全部按纯函数 `chatScroll.ts` 的写入记账（write ledger）判定，不用时间窗。
 *
 * 跳转与锚点也在这里：`jump()` 自己积分弹簧、逐帧重取落点、最多复核 2 次；`beginAnchor()` /
 * `endAnchor()` 用「插入前捕获 + 内容高度连续 2 帧不变」收尾，不用 700/1200ms 定时器。
 * 跳转期间不写锚点（E×F），跳完再恢复；跳转结束（到达 / 超时 / 被替换）后不再写视口。
 */
import {
  atBottom,
  classifyScroll,
  next,
  planTeleport,
  shouldEmitReachTop,
  showFollowButton,
  springDt,
  stepSpring,
  targetTop,
  type Anchor,
  type ScrollAlign,
  type ScrollEvent,
  type ScrollSample,
  type ScrollState,
  type ScrollTarget,
  type WriteMark,
} from './chatScroll'
import { settleJump } from '../jump'

export type UserCause = 'wheel' | 'touch' | 'pointer' | 'key' | 'scrollbar'

export interface ScrollSnapshot {
  top: number
  height: number
  client: number
  atBottom: boolean
  /** 控制器累计写 scrollTop 的次数（写入记账，回归据此断言「结束后不再写」）。 */
  writes: number
  /** 最后一次写入的时间戳（performance.now）。 */
  lastWriteAt: number
}

/** 视口内第一条可见行：尺寸变化或内容插入后用它把画面补回原位。 */
interface TopRow {
  id: string
  offset: number
}

/** 一次跳转的弹簧积分状态；逐帧重取目标，到达后进入复核。 */
interface JumpAnimation {
  token: number
  /** 目标已挂载、动画已开始；false 时等 MessageList 把目标挂上来再调用 jump。 */
  started: boolean
  verifying: boolean
  verifyStable: number
  verifyTotal: number
  pos: number
  vel: number
  teleported: boolean
  beganAt: number
  lastWritten: number
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
  /** E：跳到某条消息 / 工具卡；目标未挂载时保持 jumping，等挂载后再调一次。 */
  jump(target: ScrollTarget, opts: { token: number; align?: ScrollAlign }): void
  /** 取消当前跳转（列表卸载、新 fail 场景）。 */
  cancelJump(): void
  /** F/G：插入内容（取段、固定轮、补缺口）前捕获锚点；following/settling/jumping 时只记下意图。 */
  beginAnchor(): void
  /** F/G：数据到达后允许按稳定帧收尾（锚点保留到内容高度连续 2 帧不变）。 */
  endAnchor(): void
  /** 外部（轮次大纲）即将跳转：先让出跟随，避免观察器补偿与跳转抢写点。 */
  yieldToJump(): void
  /** 声明这是一次用户滚动（覆盖式滚动条拖动等控制器收不到输入的场景）。 */
  notifyUserScroll(cause: UserCause): void

  /** 跳转结束（到达 / 超时 / 被替换）时通知，参数为这次跳转的 token。 */
  onJumpEnd(listener: (token: number) => void): () => void
  /** 替代 `scrollTop < 240`：同一次停留只触发一次，离开顶部后重新武装。 */
  onReachTop(listener: () => void): () => void
  /** 用户自己滚到挂载窗口底部：窗口从这里回尾 / 扩展，不再按距离猜。 */
  onReachBottom(listener: () => void): () => void

  snapshot(): ScrollSnapshot
  showFollowButton(): boolean
}

const KEY_UP = new Set(['PageUp', 'ArrowUp', 'Home'])
const KEY_DOWN = new Set(['PageDown', 'ArrowDown', 'End', ' '])
/** 跳转一直挂不上目标（取段失败/视图已切走）时自动失效（保留原语义）。 */
const JUMP_EXPIRE_MS = 15_000
/** 跳转动画从点击算起的最长时长（规格 2026-11-14「约 300ms」）。 */
const JUMP_MAX_MS = 300
/** 弹簧到达后的落点复核：内容高度稳定 2 帧（或最多 12 帧）后测一次，最多 2 次复核。 */
const VERIFY_STABLE_FRAMES = 2
/** 锚点收尾：content-visibility 的行高会分几批变成真实值，稳定帧要留够余量。 */
const ANCHOR_STABLE_FRAMES = 6
const VERIFY_MAX_FRAMES = 12
/**
 * 跳转前先渲染目标上方这么多行。视口外的行停在 `contain-intrinsic-size` 的估计高度，
 * 到位后才渲染会让上方内容骤然收缩、目标被顶出视口（跳转落点偏上 46px 的根因）；
 * 复核窗口只盯内容高度稳定，渲染更晚就补不回来，所以落点要在真实行高上算。
 */
const JUMP_FORCE_ROWS = 60

/** 用户最后一次滚动方向：只有它能把「滚回底部」认作恢复跟随。 */
type ScrollIntent = 'up' | 'down' | null

class ChatScrollControllerImpl implements ChatScrollController {
  state: ScrollState = { kind: 'idle' }

  private box: HTMLElement | null = null
  private content: HTMLElement | null = null
  private key: string | null = null
  private listeners = new Set<(state: ScrollState) => void>()
  private jumpEndListeners = new Set<(token: number) => void>()
  private reachTopListeners = new Set<() => void>()
  private reachBottomListeners = new Set<() => void>()

  /** 上一次 scroll 事件看到的位置；只由 scroll 与我们的写入更新。 */
  private prev: ScrollSample = { top: 0, height: 0, client: 0 }
  /** 最后一次写入后的真实位置（被浏览器夹紧后也记真实值）。 */
  private mark: WriteMark = { top: 0, height: 0, writtenAt: 0 }
  /** 上次观察到的内容高度：用来看「这一帧内容有没有增高」。 */
  private lastHeight = -1
  private boxSize = ''
  private topRow: TopRow | null = null
  private buttonShown = false

  private writes = 0
  private lastWriteAt = 0

  private raf = 0
  private anchorRaf = 0
  private tempAnchor: TopRow | null = null
  private tempFrames = 0
  private lastFrameAt = 0
  private heightAtLastFrame = -1
  private spring: { pos: number; vel: number } | null = null
  private touchStartY: number | null = null
  private scrollIntent: ScrollIntent = null

  /** 有取段 / 固定轮 / 补缺口在路上：锚点保留到数据落地，稳定帧从 endAnchor 之后才计数。 */
  private anchorRequested = false
  private anchorStable = 0
  private reachTopArmed = true
  private jumpAnim: JumpAnimation | null = null
  private jumpTimer = 0
  /** 跳转期间被强制渲染的行（跳完后恢复 content-visibility 交给浏览器）。 */
  private forcedRows: HTMLElement[] = []
  private forcedFor: HTMLElement | null = null

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
    this.reachTopArmed = true
    this.bind()
    if (this.key !== key) {
      this.open(key)
    } else {
      if (this.state.kind === 'jumping') {
        // 滚动区节点重新挂载（从子代理视图返回）：跳转目标按新节点重新取。
        this.jumpAnim = null
        this.beginJump(this.state.token, this.state.target, this.state.align)
      } else if (this.state.kind === 'following' || this.state.kind === 'settling') {
        // 新节点从 0 开始，直接补到底。
        this.writeBottom()
        this.schedule()
      }
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
    this.jumpEndListeners.clear()
    this.reachTopListeners.clear()
    this.reachBottomListeners.clear()
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
    if (this.jumpTimer) window.clearTimeout(this.jumpTimer)
    this.jumpTimer = 0
    this.jumpAnim = null
    this.releaseForcedRows()
    this.anchorRequested = false
  }

  /* -------------------------------------------------------------- 意图 */

  open(key: string): void {
    this.key = key
    this.lastHeight = -1
    this.topRow = null
    this.tempAnchor = null
    this.tempFrames = 0
    this.spring = null
    this.anchorRequested = false
    this.reachTopArmed = true
    this.jumpAnim = null
    if (this.jumpTimer) window.clearTimeout(this.jumpTimer)
    this.jumpTimer = 0
    this.apply({ type: 'open', key })
  }

  follow(opts?: { smooth?: boolean }): void {
    this.releaseTempAnchor()
    this.apply({ type: 'follow', smooth: opts?.smooth === true })
  }

  jump(target: ScrollTarget, opts: { token: number; align?: ScrollAlign }): void {
    if (!target.messageId && !target.toolUseId) return
    this.apply({ type: 'jump', token: opts.token, target, align: opts.align, mounted: true })
  }

  cancelJump(): void {
    this.apply({ type: 'cancel-jump' })
  }

  beginAnchor(): void {
    if (!this.box) return
    this.anchorRequested = true
    this.anchorStable = 0
    // 锚点与临时锚点是同一个参考位置的两种实现：只留一个，避免两套补偿互相拉扯。
    this.tempAnchor = null
    this.tempFrames = 0
    this.captureRequestedAnchor()
  }

  endAnchor(): void {
    this.anchorRequested = false
    this.anchorStable = 0
    if (this.state.kind === 'anchoring') this.schedule()
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

  onJumpEnd(listener: (token: number) => void): () => void {
    this.jumpEndListeners.add(listener)
    return () => {
      this.jumpEndListeners.delete(listener)
    }
  }

  onReachTop(listener: () => void): () => void {
    this.reachTopListeners.add(listener)
    return () => {
      this.reachTopListeners.delete(listener)
    }
  }

  onReachBottom(listener: () => void): () => void {
    this.reachBottomListeners.add(listener)
    return () => {
      this.reachBottomListeners.delete(listener)
    }
  }

  snapshot(): ScrollSnapshot {
    const view = this.sample()
    return {
      ...view,
      atBottom: atBottom(view),
      writes: this.writes,
      lastWriteAt: this.lastWriteAt,
    }
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
      // 跳转期间的真实滚动由状态机直接结算（转 detached，不再写视口，1724#03）。
      this.apply({ type: 'user-scroll', atBottom: at })
      // 用户把挂载窗口滚到了底（不必是「恢复跟随」那种向下意图）：窗口从这里回尾/扩展。
      if (atBottom(sample) && this.state.kind !== 'jumping') this.emit(this.reachBottomListeners)
    }
    this.checkReachTop(sample)
    this.updateButton()
  }

  private onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return
    this.scrollIntent = event.deltaY < 0 ? 'up' : 'down'
    // 跳转中用户任何方向滚动：立即结算跳转，之后不再写视口（1724#03）。
    if (this.endJumpForUserInput()) return
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
    if (this.endJumpForUserInput()) return
    if (this.scrollIntent === 'up') this.leaveFollow()
  }

  private onPointerDown = (event: PointerEvent): void => {
    // 只有点在滚动区自身（滚动条槽）上才算用户接管；点内容里的按钮/文字不算。
    if (event.target !== this.box) return
    // 槽内点击可能向上也可能向下，方向未知：先停跟随，不据此恢复。
    this.scrollIntent = null
    if (this.endJumpForUserInput()) return
    this.leaveFollow()
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (KEY_UP.has(event.key) || KEY_DOWN.has(event.key)) {
      this.scrollIntent = KEY_UP.has(event.key) ? 'up' : 'down'
      if (this.endJumpForUserInput()) return
      if (this.scrollIntent === 'up') this.leaveFollow()
    }
  }

  private leaveFollow(): void {
    if (!this.box) return
    this.releaseTempAnchor()
    this.apply({ type: 'user-scroll', atBottom: false })
    this.spring = null
    this.updateButton()
  }

  /**
   * 跳转中用户真的操作了：立即结束这次跳转（状态机转 detached），此后不再写视口。
   * 在 scroll 事件之前就用滚轮/触摸/按键的提前量结算，保证「滚轮后不会被写回」。
   */
  private endJumpForUserInput(): boolean {
    if (this.state.kind !== 'jumping') return false
    this.releaseTempAnchor()
    this.apply({ type: 'user-scroll', atBottom: false })
    this.spring = null
    this.updateButton()
    return true
  }

  private checkReachTop(sample: ScrollSample): void {
    const { fire, armed } = shouldEmitReachTop(this.state, sample.top, this.reachTopArmed)
    this.reachTopArmed = armed
    if (fire) this.emit(this.reachTopListeners)
  }

  private emit<T>(listeners: Set<(value: T) => void>, value?: T): void {
    for (const listener of [...listeners]) listener(value as T)
  }

  /* ------------------------------------------------------- 观察器 */

  private onContentResize(): void {
    const box = this.box
    if (!box) return
    const height = box.scrollHeight
    if (height === this.lastHeight) return
    this.lastHeight = height
    if (this.state.kind === 'anchoring') {
      const anchor = this.state.anchor
      const found = !!anchor.messageId && this.hasRow(anchor.messageId)
      this.apply({ type: 'content-grow', anchorFound: found })
    } else {
      this.apply({ type: 'content-grow' })
    }
    if (this.tempAnchor && this.state.kind !== 'anchoring') {
      // 尺寸变化后的重排还会持续几帧（content-visibility 换成真实高度）：临时锚点一直补到稳定。
      // 正在按取段锚点补偿时以锚点为准，两套补偿不能同时写。
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
    if (previous.kind === 'jumping' && result.state.kind === 'detached') {
      // 跳转的写入不是用户滚动：视口首行快照要按落点重取，否则之后的尺寸变化
      // 会拿跳转前的旧首行做临时锚点，把视口拉回起点。
      this.topRow = this.captureTopRow()
      this.tempAnchor = null
      this.tempFrames = 0
    }
    // 取段开始时还在跟随/跳转：等用户真正离开底部（或跳完转 detached）再捕获锚点。
    if (this.anchorRequested && this.state.kind === 'detached') this.captureRequestedAnchor()
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
      case 'anchor':
        this.compensateAnchor(effect.anchor)
        break
      case 'anchor-fallback':
        this.fallbackAnchor(effect.anchor)
        break
      case 'drop-anchor':
        // 只丢锚点数据；取段还在路上（anchorRequested）时，用户继续滚动会在新位置重新捕获。
        break
      case 'jump':
        this.beginJump(effect.token, effect.target, effect.align)
        break
      case 'jump-verify':
        this.beginJumpVerify(effect.token)
        break
      case 'jump-end':
        this.finishJump(effect.token)
        break
      case 'need-mount':
        // 目标未挂载：MessageList 负责取段/挪窗口，挂上后再调 jump。
        break
      case 'follow-exit':
        break
      case 'destroy':
        this.anchorRequested = false
        this.reachTopArmed = true
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
    this.writes += 1
    this.lastWriteAt = performance.now()
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

  /* --------------------------------------------------------- 跳转 */

  private findTargetEl(target: ScrollTarget): HTMLElement | null {
    const root = this.content ?? this.box
    if (!root) return null
    if (target.toolUseId) {
      return root.querySelector<HTMLElement>(`[data-tool-use-id="${CSS.escape(target.toolUseId)}"]`)
    }
    if (target.messageId) {
      return root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target.messageId)}"]`)
    }
    return null
  }

  /** 目标该落的 scrollTop（每帧重取：content-visibility 的行渲染后才变成真实高度）。 */
  private jumpGoal(el: HTMLElement, align: ScrollAlign): number {
    const box = this.box
    if (!box) return 0
    const rowTop = box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top
    return targetTop(
      { top: rowTop, height: el.getBoundingClientRect().height },
      { clientHeight: box.clientHeight, scrollHeight: box.scrollHeight },
      align,
    )
  }

  private beginJump(token: number, target: ScrollTarget, align: ScrollAlign): void {
    const box = this.box
    if (!box) return
    if (this.jumpAnim?.token !== token) {
      this.jumpAnim = {
        token,
        started: false,
        verifying: false,
        verifyStable: 0,
        verifyTotal: 0,
        pos: box.scrollTop,
        vel: 0,
        teleported: false,
        beganAt: 0,
        lastWritten: box.scrollTop,
      }
    }
    const anim = this.jumpAnim
    const el = this.findTargetEl(target)
    if (anim && el) {
      this.forceRowsAbove(el)
      if (!anim.started) {
        this.startJumpAnimation(anim, box)
      } else if (anim.verifying) {
        // 复核发现落点偏了（行高变真实值）：以当前位置再滑一次，不再重置复核次数。
        this.startJumpAnimation(anim, box)
      }
      this.schedule()
    }
    this.armJumpExpiry(token)
  }

  private startJumpAnimation(anim: JumpAnimation, box: HTMLElement): void {
    anim.started = true
    anim.verifying = false
    anim.verifyStable = 0
    anim.verifyTotal = 0
    anim.pos = box.scrollTop
    anim.vel = 0
    anim.teleported = anim.teleported && anim.pos !== 0
    anim.beganAt = performance.now()
    anim.lastWritten = box.scrollTop
  }

  private armJumpExpiry(token: number): void {
    if (this.jumpTimer) window.clearTimeout(this.jumpTimer)
    this.jumpTimer = window.setTimeout(() => {
      this.jumpTimer = 0
      if (this.state.kind === 'jumping' && this.state.token === token) {
        this.apply({ type: 'jump-failed' })
      }
    }, JUMP_EXPIRE_MS)
  }

  private beginJumpVerify(token: number): void {
    if (!this.jumpAnim || this.jumpAnim.token !== token) return
    this.jumpAnim.verifying = true
    this.jumpAnim.verifyStable = 0
    this.jumpAnim.verifyTotal = 0
    this.schedule()
  }

  private finishJump(token: number): void {
    if (this.jumpAnim?.token === token) this.jumpAnim = null
    if (this.jumpTimer) window.clearTimeout(this.jumpTimer)
    this.jumpTimer = 0
    this.releaseForcedRows()
    settleJump(token)
    this.emit(this.jumpEndListeners, token)
  }

  /** 跳转前把目标上方一段行渲染成真实高度，落点与复核都基于真实布局。 */
  private forceRowsAbove(el: HTMLElement): void {
    if (this.forcedFor === el) return
    this.releaseForcedRows()
    const content = this.content
    if (!content) return
    const row = el.closest<HTMLElement>('.msg-row') ?? el
    const rows = [...content.querySelectorAll<HTMLElement>('.msg-row')]
    const end = Math.max(0, rows.indexOf(row))
    this.forcedFor = el
    for (let i = Math.max(0, end - JUMP_FORCE_ROWS); i < end; i++) {
      rows[i].style.contentVisibility = 'visible'
      this.forcedRows.push(rows[i])
    }
    // 读布局：逐行真实高度要在算落点前生效。
    if (this.forcedRows.length) void el.getBoundingClientRect().top
  }

  private releaseForcedRows(): void {
    for (const row of this.forcedRows) row.style.contentVisibility = ''
    this.forcedRows = []
    this.forcedFor = null
  }

  private stepJump(now: number, dt: number, heightChanged: boolean): void {
    const state = this.state
    if (state.kind !== 'jumping') return
    const box = this.box
    const anim = this.jumpAnim
    if (!box || !anim || anim.token !== state.token) return
    const el = this.findTargetEl(state.target)
    if (!el) {
      // 目标在动画中消失（窗口挪走/视图切换）：结束这次跳转，别让状态一直挂着。
      if (anim.started) this.apply({ type: 'jump-failed' })
      return
    }
    if (!anim.started) this.startJumpAnimation(anim, box)
    if (anim.verifying) {
      anim.verifyTotal += 1
      anim.verifyStable = heightChanged ? 0 : anim.verifyStable + 1
      if (anim.verifyStable < VERIFY_STABLE_FRAMES && anim.verifyTotal < VERIFY_MAX_FRAMES) return
      const residual = Math.abs(this.jumpGoal(el, state.align) - box.scrollTop)
      this.apply({ type: 'jump-verify', residual })
      return
    }
    // 浏览器夹紧等外部写入会被并入当前位置继续追目标；用户滚动已在事件入口结算跳转（1724#03）。
    if (Math.abs(box.scrollTop - anim.lastWritten) > 1) {
      anim.pos = box.scrollTop
      anim.vel = 0
    }
    const goal = this.jumpGoal(el, state.align)
    if (!anim.teleported) {
      const plan = planTeleport(anim.pos, goal, box.clientHeight)
      if (plan.teleported) {
        anim.pos = plan.pos
        anim.vel = 0
      }
      anim.teleported = true
    }
    const reduce = this.reducedMotion()
    let done: boolean
    if (reduce) {
      anim.pos = goal
      anim.vel = 0
      done = true
    } else {
      const step = stepSpring(anim.pos, anim.vel, goal, dt)
      anim.pos = step.done ? goal : step.pos
      anim.vel = step.vel
      done = step.done || now - anim.beganAt >= JUMP_MAX_MS
    }
    this.write(done ? goal : anim.pos)
    anim.lastWritten = box.scrollTop
    if (!done) return
    this.apply({ type: 'jump-arrived' })
  }

  private reducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  /* --------------------------------------------------------- 锚点 */

  private hasRow(id: string): boolean {
    return !!this.box?.querySelector(`.msg-row[data-message-id="${CSS.escape(id)}"]`)
  }

  private captureRequestedAnchor(): void {
    if (!this.anchorRequested || this.state.kind !== 'detached') return
    this.tempAnchor = null
    this.tempFrames = 0
    const box = this.box
    const row = this.captureTopRow()
    if (!box || !row) return
    const anchor: Anchor = {
      messageId: row.id,
      offset: row.offset,
      height: box.scrollHeight,
      top: box.scrollTop,
    }
    this.apply({ type: 'begin-anchor', anchor })
  }

  private compensateAnchor(anchor: Anchor): void {
    const box = this.box
    if (!box || !anchor.messageId) return
    const row = box.querySelector<HTMLElement>(
      `.msg-row[data-message-id="${CSS.escape(anchor.messageId)}"]`,
    )
    if (!row) return
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top
    const delta = offset - anchor.offset
    if (Math.abs(delta) >= 1) this.write(box.scrollTop + delta)
  }

  /** 锚点行被卸载：按 scrollHeight 差补一次就释放（纯函数已把状态改回 resume）。 */
  private fallbackAnchor(anchor: Anchor): void {
    const box = this.box
    if (!box) return
    this.write(box.scrollTop + (box.scrollHeight - anchor.height))
    this.anchorRequested = false
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
      if (this.state.kind === 'detached' && !this.tempAnchor && !this.anchorRequested) {
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

  private anchoringUnderway(): boolean {
    return this.state.kind === 'anchoring' && !this.anchorRequested
  }

  private tick = (now: number): void => {
    this.raf = 0
    const box = this.box
    if (!box) {
      this.spring = null
      this.jumpAnim = null
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
    if (this.state.kind === 'jumping') this.stepJump(now, dt, heightChanged)
    if (this.tempAnchor) {
      // 临时锚点：内容高度连续 2 帧不变才算这次重排结束。
      if (heightChanged) this.tempFrames = 0
      else this.tempFrames += 1
      if (this.tempFrames >= 2) this.releaseTempAnchor()
    }
    if (this.state.kind === 'settling') {
      const view = this.sample()
      // settling 只表示「想贴底」：内容稳定却没在底部时补一次，避免空转。
      if (!heightChanged && !this.spring && !atBottom(view)) this.writeBottom()
      this.apply({ type: 'frame', heightChanged, atBottom: atBottom(this.sample()) })
    } else if (this.anchoringUnderway()) {
      if (heightChanged) this.anchorStable = 0
      else this.anchorStable += 1
      // 行高分几批变成真实值：高度继续变就重置；稳定够久才让状态机按 2 帧收尾。
      if (heightChanged || this.anchorStable >= ANCHOR_STABLE_FRAMES) {
        this.apply({ type: 'frame', heightChanged, atBottom: atBottom(this.sample()) })
      }
    }
    if (
      this.spring ||
      this.tempAnchor ||
      this.state.kind === 'jumping' ||
      this.state.kind === 'settling' ||
      this.anchoringUnderway()
    ) {
      this.schedule()
    }
  }
}

export function createChatScrollController(): ChatScrollController {
  return new ChatScrollControllerImpl()
}
