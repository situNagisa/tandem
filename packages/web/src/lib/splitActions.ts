import { navigate } from './router'
import type { SessionTarget } from './types'
import { isBoardPane, paneKey } from './split'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'

export function focusedTarget(): SessionTarget | null {
  const active = useAppStore.getState().active
  return active ? { hostId: active.hostId, sessionId: active.sessionId } : null
}

export function sameTarget(a: SessionTarget | null, b: SessionTarget | null): boolean {
  return !!a && !!b && paneKey(a.hostId, a.sessionId) === paneKey(b.hostId, b.sessionId)
}

function go(target: SessionTarget): void {
  navigate({ kind: 'session', hostId: target.hostId, sessionId: target.sessionId })
}

/** 侧栏 ⋯ / Ctrl+点击 / 命令面板：把会话放进分屏并聚焦。 */
export function openSplitSession(target: SessionTarget): void {
  const current = focusedTarget()
  if (!current || sameTarget(current, target)) {
    go(target)
    return
  }
  useUiStore.getState().openSplitPane(current, target)
  useAppStore.getState().openSessionView(target.hostId, target.sessionId)
  go(target)
}

/** 侧栏拖拽到主区左/右/下半边。 */
export function openSplitSessionAt(
  target: SessionTarget,
  zone: 'left' | 'right' | 'bottom',
): void {
  const current = focusedTarget()
  if (!current || sameTarget(current, target)) {
    go(target)
    return
  }
  useUiStore.getState().openSplitPaneAt(current, target, zone)
  useAppStore.getState().openSessionView(target.hostId, target.sessionId)
  go(target)
}

/** 点击/快捷键切换聚焦窗格：立即更新 active，让右栏与改动审阅跟上。 */
export function focusSplitPane(target: SessionTarget): void {
  // 看板窗格没有 active 会话；保持当前会话焦点，避免路由切走看板。
  if (isBoardPane(target)) return
  const store = useAppStore.getState()
  store.focusSessionView(target.hostId, target.sessionId)
  go(target)
}

/** 关闭指定窗格；若它正聚焦则把焦点交给相邻窗格。 */
export function closeSplitPaneAt(target: SessionTarget): void {
  const ui = useUiStore.getState()
  const store = useAppStore.getState()
  const panes = ui.splitPanes
  const index = panes.findIndex(
    (pane) => pane.hostId === target.hostId && pane.sessionId === target.sessionId,
  )
  if (index < 0) return
  const wasFocused = sameTarget(focusedTarget(), target)
  const remaining = panes.filter(
    (pane) => !(pane.hostId === target.hostId && pane.sessionId === target.sessionId),
  )
  ui.closeSplitPane(target.hostId, target.sessionId)
  if (!isBoardPane(target)) store.closeSessionView(target.hostId, target.sessionId)
  if (!wasFocused) return
  const next = remaining[Math.max(0, Math.min(index, remaining.length - 1))]
  if (next) go(next)
  else navigate({ kind: 'host', hostId: target.hostId })
}

/** 合并为单窗格：保留聚焦会话，关掉其余窗格视图。 */
export function clearSplitWorkspace(): void {
  const ui = useUiStore.getState()
  const store = useAppStore.getState()
  const active = focusedTarget()
  for (const pane of ui.splitPanes) {
    if (isBoardPane(pane)) continue
    if (!sameTarget(pane, active)) store.closeSessionView(pane.hostId, pane.sessionId)
  }
  ui.clearSplit()
}

/** Ctrl/Cmd+W：关闭当前窗格；单窗格时关闭会话回到 Host 首页。 */
export function closeFocusedPane(): void {
  const active = useAppStore.getState().active
  if (!active) return
  const target = { hostId: active.hostId, sessionId: active.sessionId }
  if (useUiStore.getState().splitPanes.length < 2) {
    navigate({ kind: 'host', hostId: active.hostId })
    return
  }
  closeSplitPaneAt(target)
}
