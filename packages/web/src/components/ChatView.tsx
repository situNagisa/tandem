import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, RefreshCw, ShieldAlert, TriangleAlert, WifiOff } from 'lucide-react'
import type { PermissionRequest } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { MessageList } from './MessageList'
import { SessionWelcome, HomeView } from './Welcome'
import { PermissionCard } from './PermissionCard'
import { Composer } from './Composer'

const EMPTY_PENDING: PermissionRequest[] = []
const SCROLL_THRESHOLD = 80

function StreamAutoScroll({
  scrollRef,
  pinnedRef,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  pinnedRef: React.RefObject<boolean>
}) {
  const messages = useAppStore((s) => s.active?.messages)
  useLayoutEffect(() => {
    if (!pinnedRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, scrollRef, pinnedRef])
  return null
}

export function ChatView() {
  const hasSession = useAppStore((s) => !!s.active)
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const loading = useAppStore((s) => s.active?.loading ?? false)
  const error = useAppStore((s) => s.active?.error)
  const turnError = useAppStore((s) => s.active?.turnError)
  const pending = useAppStore((s) => s.active?.pending ?? EMPTY_PENDING)
  const messageCount = useAppStore((s) => s.active?.messages.length ?? 0)
  const lastIsLocal = useAppStore(
    (s) => s.active?.messages[s.active.messages.length - 1]?.local ?? false,
  )
  const running = useAppStore((s) => s.active?.running ?? false)
  const hostStatus = useAppStore((s) =>
    hostId ? (s.runtimes[hostId]?.status ?? 'offline') : 'offline',
  )
  const authError = useAppStore((s) =>
    hostId ? s.runtimes[hostId]?.authError : undefined,
  )
  const hostName = useAppStore(
    (s) => s.hosts.find((h) => h.id === s.active?.hostId)?.name ?? 'Host',
  )
  const retryHost = useAppStore((s) => s.retryHost)
  const reloadActiveSession = useAppStore((s) => s.reloadActiveSession)
  const openSettings = useUiStore((s) => s.openSettings)

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setShowJump(false)
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }

  useEffect(() => {
    pinnedRef.current = true
    setShowJump(false)
    const id = window.requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
    return () => window.cancelAnimationFrame(id)
  }, [sessionId])

  useEffect(() => {
    if (!pinnedRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messageCount, loading, pending.length])

  useEffect(() => {
    if (!lastIsLocal) return
    pinnedRef.current = true
    setShowJump(false)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastIsLocal, messageCount])

  // 图片、代码高亮等异步撑高内容时保持贴底
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!pinnedRef.current) return
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!running) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.repeat) return
      const ui = useUiStore.getState()
      if (
        ui.settingsOpen ||
        ui.newSessionOpen ||
        ui.searchOpen ||
        ui.mobileSidebar ||
        ui.mobilePanel
      ) {
        return
      }
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      useAppStore.getState().interrupt()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [running])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedRef.current = distance < SCROLL_THRESHOLD
    const next = distance > 240
    setShowJump((prev) => (prev === next ? prev : next))
  }

  if (!hasSession) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <HomeView />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {authError && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-danger/25 bg-danger-soft/50 px-4 py-1.5 text-[11.5px] text-danger">
          <ShieldAlert size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">Host 认证失败：{authError}</span>
          <button
            onClick={() => openSettings('hosts')}
            className="shrink-0 rounded-md border border-danger/30 px-2 py-0.5 text-[11px] transition-colors hover:bg-danger/10"
          >
            检查设置
          </button>
        </div>
      )}
      {!authError && hostStatus === 'offline' && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/25 bg-warning-soft/50 px-4 py-1.5 text-[11.5px] text-warning">
          <WifiOff size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">
            与 {hostName} 的连接已断开，正在自动重连…
          </span>
          <button
            onClick={() => hostId && retryHost(hostId)}
            className="flex shrink-0 items-center gap-1 rounded-md border border-warning/30 px-2 py-0.5 text-[11px] transition-colors hover:bg-warning/10"
          >
            <RefreshCw size={11} /> 立即重试
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full w-full overflow-y-auto overscroll-contain"
        >
          <div ref={contentRef} className="mx-auto flex min-h-full w-full max-w-[860px] flex-col px-4 pb-5 pt-2 md:px-8 md:pt-4">
            <div className="flex flex-1 flex-col">
              {loading && messageCount === 0 ? (
                <MessageList showSkeleton />
              ) : messageCount === 0 ? (
                <SessionWelcome />
              ) : (
                <MessageList />
              )}
              {error && (
                <div className="mb-3 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft/50 px-3 py-2 text-[12px] text-danger">
                  <TriangleAlert size={14} className="shrink-0" />
                  <span className="min-w-0 flex-1">{error}</span>
                  <button
                    onClick={reloadActiveSession}
                    className="shrink-0 rounded-md border border-danger/30 px-2 py-0.5 text-[11px] transition-colors hover:bg-danger/10"
                  >
                    重新加载
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {showJump && (
          <button
            onClick={() => scrollToBottom(true)}
            className="anim-fade-in absolute bottom-3 left-1/2 flex min-h-11 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-4 py-2 text-[11.5px] text-text-soft shadow-lg transition-colors hover:bg-surface-2 md:min-h-0 md:px-3 md:py-1.5"
          >
            <ChevronDown size={13} /> 回到底部
          </button>
        )}
        <StreamAutoScroll scrollRef={scrollRef} pinnedRef={pinnedRef} />
      </div>

      <div className="shrink-0 bg-bg px-3 pb-[max(0.65rem,env(safe-area-inset-bottom))] pt-1.5 md:px-8 md:pb-4 md:pt-2">
        <div className="mx-auto w-full max-w-[860px]">
          {turnError && (
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft/50 px-3 py-2 text-[12px] text-danger">
              <TriangleAlert size={14} className="shrink-0" />
              <span className="min-w-0 flex-1">回合出错：{turnError}</span>
            </div>
          )}
          {pending.length > 0 && (
            <PermissionCard request={pending[0]} more={pending.length - 1} />
          )}
          <Composer />
        </div>
      </div>
    </div>
  )
}
