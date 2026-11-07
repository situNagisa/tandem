import { useFeedbackStore } from '../store/useFeedbackStore'
import { getCommandShortcut } from './commands'
import { matchShortcut } from './shortcut'

let installed = false

/**
 * 反馈模式热键：在 window capture 阶段、应用渲染之前注册，
 * 保证先于搜索/Composer 等所有 keydown 处理，避免其它控件抢先消费或关闭。
 */
export function installFeedbackHotkey(): void {
  if (installed) return
  installed = true
  const onKey = (e: KeyboardEvent) => {
    const shortcut = getCommandShortcut('app.feedback')
    if (!shortcut || !matchShortcut(e, shortcut)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const store = useFeedbackStore.getState()
    if (store.active) store.exit()
    else store.enter()
  }
  window.addEventListener('keydown', onKey, true)
}
