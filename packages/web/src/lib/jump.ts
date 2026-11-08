/**
 * 跨路由定位：搜索、收件箱、上下文面板导航到会话后，轮询等目标消息/工具卡挂载再滚动高亮。
 * 事件由 MessageList 监听；消息可能还没加载，监听方会按需补窗口。
 */
function pollJump(detail: { messageId?: string; toolUseId?: string }, deadline = Date.now() + 12_000): void {
  const fire = () => window.dispatchEvent(new CustomEvent('tandem-jump-message', { detail }))
  const selector = detail.toolUseId
    ? `[data-tool-use-id="${CSS.escape(detail.toolUseId)}"]`
    : detail.messageId
      ? `[data-message-id="${CSS.escape(detail.messageId)}"]`
      : ''
  const tick = () => {
    fire()
    if (selector && document.querySelector(selector)) {
      // DOM 已挂载但 MessageList 的 effect 可能还没注册监听：补两次事件。
      window.setTimeout(fire, 220)
      window.setTimeout(fire, 650)
      return
    }
    if (Date.now() > deadline) return
    window.setTimeout(tick, 300)
  }
  tick()
}

/** 跳到某条消息并高亮（轮次/搜索/收件箱回合行）。 */
export function focusMessage(messageId: string | undefined): void {
  if (messageId) pollJump({ messageId })
}

/** 跳到某张工具卡并高亮（收件箱明细里的命令/审批）。 */
export function focusTool(toolUseId: string | undefined): void {
  if (toolUseId) pollJump({ toolUseId })
}
