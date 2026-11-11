/**
 * 会话定位：轮次大纲、会话图、搜索、收件箱、上下文面板共用这一个实现。
 *
 * - 一次跳转只派发一次：目标消息未加载时只取它所在的片段，挂载后在当前帧实际定位，
 *   随后只在布局还没稳定时（≤0.3s）逐帧收敛落点，稳定即停；
 * - 用户滚轮 / 触摸 / 拖动滚动条 / 按键滚动会立即取消这次跳转剩下的定位与补正，
 *   不会在用户滚动时把视口拉回去（反馈0220#03 / R68）；
 * - 不再用定时轮询反复派发事件：新一次跳转直接替换上一次，MessageList 挂载时领取尚未完成的跳转。
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
let detachCancel: (() => void) | null = null
let expireTimer = 0
const listeners = new Set<JumpListener>()

const CANCEL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])
const CANCEL_EVENTS = ['wheel', 'touchstart', 'touchmove', 'pointerdown'] as const

function disarm(): void {
  detachCancel?.()
  detachCancel = null
  window.clearTimeout(expireTimer)
  expireTimer = 0
}

function cancelActive(): void {
  if (!active) return
  seq += 1
  active = null
  disarm()
}

/** 用户接管滚动：取消当前跳转剩下的定位/补正。程序写入 scrollTop 不会派发这些事件。 */
function armCancel(): void {
  if (detachCancel) return
  const cancel = () => cancelActive()
  const onKey = (event: KeyboardEvent) => {
    if (!CANCEL_KEYS.has(event.key)) return
    const target = event.target as HTMLElement | null
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return
    }
    cancel()
  }
  for (const type of CANCEL_EVENTS) window.addEventListener(type, cancel, { passive: true, capture: true })
  window.addEventListener('keydown', onKey, true)
  detachCancel = () => {
    for (const type of CANCEL_EVENTS) window.removeEventListener(type, cancel, true)
    window.removeEventListener('keydown', onKey, true)
  }
}

/** 跳转请求是否仍然有效（用户还没接管滚动、也没有发起新的跳转）。 */
export function isJumpCurrent(token: number): boolean {
  return active?.token === token
}

/** 定位完成（或放弃）：释放取消监听。 */
export function settleJump(token: number): void {
  if (!isJumpCurrent(token)) return
  active = null
  disarm()
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
  cancelActive()
  const token = ++seq
  active = {
    token,
    ...(target.messageId ? { messageId: target.messageId } : {}),
    ...(target.toolUseId ? { toolUseId: target.toolUseId } : {}),
    ...(target.align ? { align: target.align } : {}),
  }
  armCancel()
  // 目标一直没挂载（网络失败/视图已切走）时自动失效，避免下一次挂载的无关注释去领取旧跳转。
  expireTimer = window.setTimeout(() => cancelActive(), 15_000)
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

/** 目标相对视口该落的位置：贴顶（大纲逐轮切换）或居中；比视口还高时都贴顶。 */
function targetOffset(box: HTMLElement, el: HTMLElement, align: JumpTarget['align']): number {
  const view = box.getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  const gap =
    align === 'start' || rect.height >= box.clientHeight - 32
      ? 16
      : (box.clientHeight - rect.height) / 2
  return rect.top - view.top - gap
}

/**
 * 把目标放到滚动区指定落点（中线 / 贴顶）。content-visibility 的行在绘制后才变成真实高度，
 * 所以落点稳定前逐帧收敛几次（≤20 帧），稳定三帧就收尾；不会在稳定后继续写。
 * `find` 每次重新取元素（目标可能刚挂载）；`shouldWrite` 在用户接管滚动后返回 false。
 */
export function placeElement(
  box: HTMLElement,
  find: () => HTMLElement | null,
  options: { shouldWrite?: () => boolean; done?: () => void; align?: JumpTarget['align'] } = {},
): () => void {
  let raf = 0
  let stopped = false
  let steady = 0
  let frames = 0
  const allowed = () => !stopped && (options.shouldWrite?.() ?? true)
  const finish = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
    options.done?.()
  }
  const step = () => {
    raf = 0
    if (!allowed()) return finish()
    const el = find()
    if (!el) return finish()
    const delta = targetOffset(box, el, options.align)
    if (Math.abs(delta) > 4) {
      const max = Math.max(0, box.scrollHeight - box.clientHeight)
      box.scrollTop = Math.min(max, Math.max(0, box.scrollTop + delta))
      steady = 0
    } else if (++steady >= 3 && frames >= 4) {
      return finish()
    }
    // content-visibility 的行在绘制后才变成真实高度：落点稳定前逐帧收敛（≤20 帧、约 0.3s），
    // 连续几帧不再变化就收尾；用户一滚动 allowed 变 false，立即停止，不再把视口拉回去。
    if (++frames >= 20) return finish()
    raf = requestAnimationFrame(step)
  }
  step()
  return () => {
    cancelAnimationFrame(raf)
    stopped = true
  }
}
