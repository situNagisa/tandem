import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { PermissionRequest } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import { MessageList } from './MessageList'
import { SessionWelcome, HomeView } from './Welcome'
import { PermissionCard } from './PermissionCard'
import { PlanCard } from './PlanCard'
import { Button, IconButton } from './ui/Button'
import { Composer } from './Composer'
import { EnvBar } from './EnvBar'
import { TurnRail } from './chat/TurnRail'
import { TurnErrorNotice } from './chat/TurnErrorNotice'
import '../styles/chat.css'

const EMPTY_PENDING: PermissionRequest[] = []
const PIN_THRESHOLD = 80
const JUMP_THRESHOLD = 160

export function ChatView() {
  const hasSession = useAppStore((s) => !!s.active)
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const loading = useAppStore((s) => s.active?.loading ?? false)
  const error = useAppStore((s) => s.active?.error)
  const turnError = useAppStore((s) => s.active?.turnError)
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const pending = useAppStore((s) => s.active?.pending ?? EMPTY_PENDING)
  const messageCount = useAppStore((s) => s.active?.messages.length ?? 0)
  const lastIsLocal = useAppStore(
    (s) => s.active?.messages[s.active.messages.length - 1]?.local ?? false,
  )
  const running = useAppStore((s) => s.active?.running ?? false)
  const authError = useAppStore((s) =>
    hostId ? s.runtimes[hostId]?.authError : undefined,
  )
  const reloadActiveSession = useAppStore((s) => s.reloadActiveSession)

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const frameRef = useRef<number | null>(null)
  // 平滑滚动到顶前，避免 ResizeObserver 在同一帧插入瞬移
  const programmaticUntil = useRef(0)
  // 打开会话后的贴底校准：content-visibility 的预估高度会让首次 scrollHeight 偏小。
  const initialScrollFor = useRef<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  // 消息操作条用：用户消息 id → 检查点 id。回合结束后刷新。
  const [checkpoints, setCheckpoints] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    if (!hostId || !sessionId || running) return
    const host = useAppStore.getState().hosts.find((h) => h.id === hostId)
    if (!host) return
    let cancelled = false
    api
      .checkpoints(host, sessionId)
      .then((list) => {
        if (!cancelled) setCheckpoints(new Map(list.map((cp) => [cp.messageId, cp.id])))
      })
      .catch(() => {
        if (!cancelled) setCheckpoints(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [hostId, sessionId, running, messageCount])

  const retryTurn = () => {
    const state = useAppStore.getState()
    const active = state.active
    if (!active || active.running) return
    const last = active.messages.slice().reverse().find((m) => m.role === 'user')
    if (last) state.send(last.content)
  }

  const stickToBottom = useCallback(() => {
    if (!pinnedRef.current) return
    if (frameRef.current != null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      if (!pinnedRef.current) return
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setShowJump(false)
    if (smooth) {
      programmaticUntil.current = Date.now() + 600
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  useLayoutEffect(() => {
    pinnedRef.current = true
    setShowJump(false)
    initialScrollFor.current = sessionId
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionId])

  // 消息挂载后高度仍会变化（代码高亮、content-visibility 回收），在最初几百毫秒内多次校准。
  useEffect(() => {
    if (!sessionId || loading || initialScrollFor.current !== sessionId) return
    const timers = [0, 80, 240, 600].map((delay) =>
      window.setTimeout(() => {
        if (initialScrollFor.current !== sessionId || !pinnedRef.current) return
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
        if (delay === 600) initialScrollFor.current = null
      }, delay),
    )
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [sessionId, loading, messageCount])

  useLayoutEffect(() => {
    stickToBottom()
  }, [messageCount, loading, pending.length, stickToBottom])

  useEffect(() => {
    if (!lastIsLocal) return
    scrollToBottom()
  }, [lastIsLocal, messageCount, scrollToBottom])

  // 文本流式增长、图片加载、代码高亮都会撑高内容，用 ResizeObserver 保持贴底。
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const content = contentRef.current
    const box = scrollRef.current
    if (!content || !box) return
    const ro = new ResizeObserver(() => stickToBottom())
    ro.observe(content)
    ro.observe(box)
    return () => ro.disconnect()
  }, [stickToBottom])

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
    if (programmaticUntil.current > Date.now()) {
      pinnedRef.current = true
      setShowJump(false)
      if (distance < 2) programmaticUntil.current = 0
      return
    }
    programmaticUntil.current = 0
    pinnedRef.current = distance < PIN_THRESHOLD
    const next = distance > JUMP_THRESHOLD
    setShowJump((prev) => (prev === next ? prev : next))
  }

  const cancelProgrammatic = () => {
    programmaticUntil.current = 0
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
          <span className="min-w-0 flex-1">
            Host 认证失败：{authError}（请在设置的 Host 管理中检查 Token）
          </span>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={cancelProgrammatic}
          onTouchMove={cancelProgrammatic}
          className="chat-scroll h-full w-full overflow-y-auto overscroll-contain"
        >
          <div
            ref={contentRef}
            className="mx-auto flex min-h-full w-full max-w-[808px] flex-col px-4 pb-8 pt-3 md:px-6 md:pt-5"
          >
            <div className="flex flex-1 flex-col">
              {loading && messageCount === 0 ? (
                <MessageList showSkeleton />
              ) : messageCount === 0 ? (
                <SessionWelcome />
              ) : (
                <MessageList checkpoints={checkpoints} />
              )}
              {turnError && (
                <TurnErrorNotice error={turnError} running={running} onRetry={retryTurn} />
              )}
              {error && (
                <div className="mb-3 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft/50 px-3 py-2 text-[12px] text-danger">
                  <TriangleAlert size={14} className="shrink-0" />
                  <span className="min-w-0 flex-1">{error}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={reloadActiveSession}
                    className="border-danger/30 px-2 text-[11px]"
                  >
                    重新加载
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>

        <TurnRail
          scrollRef={scrollRef}
          sessionId={sessionId}
          onBeforeJump={() => {
            pinnedRef.current = false
            programmaticUntil.current = 0
            setShowJump(false)
          }}
        />

        <IconButton
          onClick={() => scrollToBottom(true)}
          label="回到底部"
          tooltipSide="top"
          className={cn(
            'chat-jump absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-surface text-text-soft shadow-md hover:text-text max-md:size-11',
            showJump
              ? 'pointer-events-auto translate-y-0 opacity-100'
              : 'pointer-events-none opacity-0',
          )}
        >
          <ChevronDown size={16} />
        </IconButton>
      </div>

      <div className="shrink-0 bg-bg px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1.5 md:px-6 md:pb-5 md:pt-2">
        <div className="mx-auto w-full max-w-[760px]">
          {summary && hostId && (
            <EnvBar
              variant="session"
              hostId={hostId}
              cwd={summary.cwd}
              env={summary.env}
              worktree={summary.worktree}
            />
          )}
          {pending.length > 0 &&
            (pending[0].toolName === 'ExitPlanMode' ? (
              <PlanCard
                key={pending[0].id}
                request={pending[0]}
                more={pending.length - 1}
              />
            ) : (
              <PermissionCard
                key={pending[0].id}
                request={pending[0]}
                more={pending.length - 1}
              />
            ))}
          <Composer />
        </div>
      </div>
    </div>
  )
}
