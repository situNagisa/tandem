/**
 * 会话定位的跳转总线：轮次大纲、会话图、搜索、收件箱、上下文面板共用这一个入口。
 *
 * 这里只负责「一次跳转只派发一次」的 token 语义：新一次跳转直接替换上一次，15 秒挂不上目标
 * 自动失效，MessageList 挂载时领取尚未完成的那一次。滚动动画（弹簧 / 远距离瞬移 / 落点复核）
 * 由消息区滚动控制器负责（lib/scroll/chatScrollController.ts），这里不再写 scrollTop。
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
