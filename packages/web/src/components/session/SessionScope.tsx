import { createContext, useContext, type ReactNode } from 'react'
import type { ActiveSession, SessionTarget } from '../../lib/types'
import { paneKey } from '../../lib/split'
import { useAppStore } from '../../store/useAppStore'

const SessionScopeContext = createContext<SessionTarget | null>(null)

/** 让一棵子树绑定到某个分屏窗格的会话；不包 Provider 时读取当前聚焦会话。 */
export function SessionScopeProvider({
  target,
  children,
}: {
  target: SessionTarget
  children: ReactNode
}) {
  return (
    <SessionScopeContext.Provider value={target}>{children}</SessionScopeContext.Provider>
  )
}

export function useSessionTarget(): SessionTarget | null {
  return useContext(SessionScopeContext)
}

/** 作用域会话是否正聚焦；没有 Provider 时视为聚焦（单窗格）。 */
export function isTargetFocused(target: SessionTarget | null): boolean {
  if (!target) return true
  const active = useAppStore.getState().active
  return (
    !!active && active.hostId === target.hostId && active.sessionId === target.sessionId
  )
}

/** 订阅作用域内的会话视图；没有 Provider 时等价于 s.active。 */
export function useSessionView<T>(selector: (view: ActiveSession | null) => T): T {
  const target = useContext(SessionScopeContext)
  return useAppStore((state) => {
    if (!target) return selector(state.active)
    const key = paneKey(target.hostId, target.sessionId)
    const view =
      state.sessionViews[key] ??
      (state.active &&
      state.active.hostId === target.hostId &&
      state.active.sessionId === target.sessionId
        ? state.active
        : null)
    return selector(view)
  })
}

/** 作用域会话；没有 Provider 时返回 null。 */
export function useScopedSession(): ActiveSession | null {
  return useSessionView((view) => view)
}
