/**
 * 会话定位：轮次大纲、会话图、搜索、收件箱、上下文面板共用这一个实现。
 *
 * - 一次跳转只派发一次：目标消息未加载时只取它所在的片段，挂载后用轮次大纲同款弹簧动画滑到落点
 *   （长距离先瞬移到目标前约 1 屏再滑入）；到达后最多复核一次落点（content-visibility 的行
 *   渲染后才变成真实高度），之后不再写 scrollTop；
 * - 用户滚轮不中断这次跳转，动画自然结束；结束后视口归用户，不会有定时补正把视口拉回去
 *   （反馈1110：不需要滑轮中断跳转，也不要一直轮询锁视图）；
 * - 不派发定时轮询事件：新一次跳转直接替换上一次，MessageList 挂载时领取尚未完成的跳转。
 */

export const JUMP_EVENT = 'tandem-jump-message'

export interface JumpTarget {
  messageId?: string
  toolUseId?: string
  /** 落点：轮次大纲按「这一轮从这里开始」贴顶，其余入口居中。 */
  align?: 'center' | 'start'
}

export interface JumpRequest extends JumpTarget {
  token: number
}

type JumpListener = (request: JumpRequest) => void

let seq = 0
let active: JumpRequest | null = null
let expireTimer = 0
const listeners = new Set<JumpListener>()

/** 跳转请求是否仍然有效（没有新的跳转替换它）。 */
export function isJumpCurrent(token: number): boolean {
  return active?.token === token
}

/** 定位完成（或放弃）：之后的挂载不再领取这次跳转。 */
export function settleJump(token: number): void {
  if (!isJumpCurrent(token)) return
  active = null
  window.clearTimeout(expireTimer)
  expireTimer = 0
}

/**
 * 订阅跳转请求。挂载时先交付仍在进行的那一次（从搜索/收件箱跨路由进来时列表还没挂载），
 * 之后每次跳转只通知一次。
 */
export function subscribeJump(listener: JumpListener): () => void {
  listeners.add(listener)
  if (active) listener(active)
  return () => {
    listeners.delete(listener)
  }
}

export function jumpTo(target: JumpTarget): void {
  if (!target.messageId && !target.toolUseId) return
  const token = ++seq
  active = {
    token,
    ...(target.messageId ? { messageId: target.messageId } : {}),
    ...(target.toolUseId ? { toolUseId: target.toolUseId } : {}),
    ...(target.align ? { align: target.align } : {}),
  }
  // 目标一直没挂载（网络失败/视图已切走）时自动失效，避免下一次挂载的无关注释去领取旧跳转。
  window.clearTimeout(expireTimer)
  expireTimer = window.setTimeout(() => {
    if (active?.token === token) active = null
  }, 15_000)
  // ChatView 等只需要知道「正在跳转」的观察者：停止贴底跟随。
  window.dispatchEvent(
    new CustomEvent(JUMP_EVENT, {
      detail: { messageId: target.messageId, toolUseId: target.toolUseId, token },
    }),
  )
  for (const listener of [...listeners]) listener(active)
}

/** 跳到某条消息并定位（轮次大纲/会话图/搜索/收件箱回合行）。 */
export function focusMessage(messageId: string | undefined, align?: JumpTarget['align']): void {
  if (messageId) jumpTo({ messageId, ...(align ? { align } : {}) })
}

/** 跳到某张工具卡并定位（收件箱明细里的命令/审批）。 */
export function focusTool(toolUseId: string | undefined): void {
  if (toolUseId) jumpTo({ toolUseId })
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 目标相对滚动区该落的 scrollTop：贴顶（大纲逐轮切换）或居中；比视口还高时贴顶。 */
function targetScrollTop(box: HTMLElement, el: HTMLElement, align?: JumpTarget['align']): number {
  const view = box.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  const gap =
    align === 'start' || rect.height >= box.clientHeight - 32
      ? 16
      : (box.clientHeight - rect.height) / 2
  const max = Math.max(0, box.scrollHeight - box.clientHeight)
  return Math.min(max, Math.max(0, box.scrollTop + rect.top - view.top - gap))
}

const FOLLOW_K = 240
const FOLLOW_C = 31

interface JumpScroller {
  /** 每帧重新取目标 scrollTop（按消息 id 找元素，跳过 content-visibility 的估算高度）。 */
  to(locate: () => number | null, done: () => void): void
  cancel(): void
}

/**
 * 对话区滚动跟随：临界阻尼弹簧追一个"实时目标"（轮次大纲原来的跳转动画）。
 * 距离很远时先瞬移到目标前约 1 屏，再弹簧滑入，避免长距离动画中途反复改落点。
 * 到达后复核一次落点（渲染后行高变真实值）就结束，不轮询、不按定时器反复写 scrollTop。
 * 用户滚轮不打断动画（滚动锚定/用户滚动会被并入当前位置，弹簧随即继续追目标）。
 */
function createJumpScroller(getRoot: () => HTMLElement | null): JumpScroller {
  let raf = 0
  let locate: (() => number | null) | null = null
  let onDone: (() => void) | null = null
  let pos = 0
  let vel = 0
  let last = 0
  let written = 0
  let verifyTimer = 0
  let verifies = 0
  let teleported = false
  let began = 0

  const settle = () => {
    const done = onDone
    locate = null
    onDone = null
    done?.()
  }

  const stop = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    window.clearTimeout(verifyTimer)
    locate = null
    onDone = null
  }

  const verify = (keep: () => number | null) => {
    const root = getRoot()
    if (!root || locate !== keep) return
    const target = keep()
    const max = Math.max(0, root.scrollHeight - root.clientHeight)
    if (target == null || Math.abs(Math.min(max, Math.max(0, target)) - root.scrollTop) <= 3) {
      settle()
      return
    }
    // 渲染后行高变成真实值：以当前位置重新滑一次，之后不再写。
    locate = keep
    teleported = true
    pos = root.scrollTop
    vel = 0
    written = root.scrollTop
    last = performance.now()
    began = last
    raf = requestAnimationFrame(frame)
  }

  const frame = (now: number) => {
    raf = 0
    if (!locate) return
    const root = getRoot()
    if (!root) return stop()
    const dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000))
    last = now
    // 滚动锚定会在 content-visibility 渲染后改 scrollTop：并入当前位置继续追。
    if (Math.abs(root.scrollTop - written) > 1) pos = root.scrollTop
    const target = locate()
    if (target == null) return settle()
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
    const done =
      (Math.abs(goal - pos) < 0.5 && Math.abs(vel) < 6) || now - began >= 900
    if (done) pos = goal
    root.scrollTop = pos
    written = root.scrollTop
    if (done) {
      const keep = locate
      if (verifies < 2) {
        verifies++
        verifyTimer = window.setTimeout(() => verify(keep), 140)
      } else {
        settle()
      }
      return
    }
    raf = requestAnimationFrame(frame)
  }

  return {
    to(next, done) {
      const root = getRoot()
      if (!root) {
        done()
        return
      }
      window.clearTimeout(verifyTimer)
      locate = next
      onDone = done
      verifies = 0
      const max = () => Math.max(0, root.scrollHeight - root.clientHeight)
      if (reducedMotion()) {
        if (raf) cancelAnimationFrame(raf)
        raf = 0
        const t = next()
        if (t != null) {
          root.scrollTop = Math.min(max(), Math.max(0, t))
          written = root.scrollTop
        }
        pos = root.scrollTop
        vel = 0
        teleported = true
        verifyTimer = window.setTimeout(() => verify(next), 140)
        return
      }
      teleported = false
      if (!raf) {
        pos = root.scrollTop
        written = root.scrollTop
        vel = 0
        last = performance.now()
        began = last
        raf = requestAnimationFrame(frame)
      }
    },
    cancel: stop,
  }
}

let scroller: { box: HTMLElement; follow: JumpScroller } | null = null

/**
 * 用一个实例把视口滑到目标（轮次大纲/会话图/搜索/收件箱/子代理返回共用）。
 * `find` 每次重新取元素；返回的函数取消这次动画（列表卸载时调用）。
 */
export function startJumpScroll(
  token: number,
  box: HTMLElement,
  find: () => HTMLElement | null,
  align?: JumpTarget['align'],
  onDone?: () => void,
): () => void {
  if (!isJumpCurrent(token)) {
    onDone?.()
    return () => {}
  }
  if (!scroller || scroller.box !== box) {
    scroller?.follow.cancel()
    scroller = { box, follow: createJumpScroller(() => box) }
  }
  const current = scroller.follow
  current.to(
    () => {
      const el = find()
      return el ? targetScrollTop(box, el, align) : null
    },
    () => {
      settleJump(token)
      onDone?.()
    },
  )
  return () => {
    current.cancel()
    onDone?.()
  }
}
