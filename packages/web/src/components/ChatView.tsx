import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, GitFork, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { PermissionRequest, TeamPresence } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useDevicesStore } from '../store/useDevicesStore'
import { useUiStore } from '../store/useUiStore'
import { api } from '../lib/api'
import { navigate } from '../lib/router'
import { isLocalHostUrl, isSameOrigin } from '../lib/hostUrl'
import { useElementWidth, useIsMobile } from '../lib/hooks'
import { cn } from '../lib/cn'
import { MessageList } from './MessageList'
import { HandoffCard } from './chat/HandoffCard'
import { SessionWelcome, HomeView } from './Welcome'
import { PermissionCard } from './PermissionCard'
import { PlanCard } from './PlanCard'
import { Button, IconButton } from './ui/Button'
import { Composer } from './Composer'
import { CompactConfirmDialog } from './chat/CompactConfirmDialog'
import { EnvBar } from './EnvBar'
import { TurnRail } from './chat/TurnRail'
import { TurnErrorNotice } from './chat/TurnErrorNotice'
import { SubagentSessionView } from './chat/SubagentSessionView'
import { DemoDeviceStage } from './workstation/DemoDeviceStage'
import { isTargetFocused, useSessionTarget, useSessionView } from './session/SessionScope'
import '../styles/chat.css'

const EMPTY_PENDING: PermissionRequest[] = []
const EMPTY_VIEWERS: TeamPresence[] = []
const EMPTY_MOUNTS: import('@tandem/protocol').DeviceMount[] = []
const PIN_THRESHOLD = 80
const JUMP_THRESHOLD = 160

export function ChatView() {
  const sessionTarget = useSessionTarget() ?? undefined
  const [rootRef, width] = useElementWidth<HTMLDivElement>()
  const isMobile = useIsMobile()
  const compact = width > 0 && width < 440
  // 表格 / 代码块等宽内容可以突破正文阅读宽度，铺满对话列（反馈 #7-02）。
  const chatWide = width > 0 ? Math.max(0, width - (compact ? 20 : 48) - (width > 900 ? 12 : 0)) : 0
  const hasSession = useSessionView((s) => !!s)
  const hostId = useSessionView((s) => s?.hostId ?? null)
  const sessionId = useSessionView((s) => s?.sessionId ?? null)
  const loading = useSessionView((s) => s?.loading ?? false)
  const sessionMounts = useDevicesStore((s) =>
    hostId && sessionId ? s.sessionMounts[`${hostId}:${sessionId}`] ?? EMPTY_MOUNTS : EMPTY_MOUNTS,
  )
  const error = useSessionView((s) => s?.error)
  const turnError = useSessionView((s) => s?.turnError)
  const summary = useSessionView((s) => s?.summary ?? null)
  const pending = useSessionView((s) => s?.pending ?? EMPTY_PENDING)
  const messageCount = useSessionView((s) => s?.messages.length ?? 0)
  const lastIsLocal = useSessionView(
    (s) => s?.messages[s.messages.length - 1]?.local ?? false,
  )
  const running = useSessionView((s) => s?.running ?? false)
  const authError = useAppStore((s) =>
    hostId ? s.runtimes[hostId]?.authError : undefined,
  )
  const team = useAppStore((s) => (hostId ? s.runtimes[hostId]?.team : undefined))
  const activeHost = useAppStore((s) =>
    hostId ? s.hosts.find((item) => item.id === hostId) : undefined,
  )
  const openDoctor = useUiStore((s) => s.openDoctor)
  const agentSession = useUiStore((s) => s.agentSession)
  const closeAgentSession = useUiStore((s) => s.closeAgentSession)
  const canDoctor =
    !!activeHost && (isLocalHostUrl(activeHost.url) || isSameOrigin(activeHost.url))
  const viewers = useSessionView((s) => s?.viewers ?? EMPTY_VIEWERS)
  const reloadActiveSession = useAppStore((s) => s.reloadActiveSession)
  const hostSessions = useAppStore((s) =>
    hostId ? s.runtimes[hostId]?.sessions : undefined,
  )
  const forkedFrom = summary?.forkedFrom
  const parentSession = forkedFrom
    ? hostSessions?.find((s) => s.id === forkedFrom.sessionId)
    : undefined
  const parentTitle = parentSession?.title ?? forkedFrom?.title

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
  // 读屏播报：新审批出现、流式回复结束。
  const [announcement, setAnnouncement] = useState('')
  const pendingCountRef = useRef(pending.length)
  const runningRef = useRef(running)
  useEffect(() => {
    const before = pendingCountRef.current
    pendingCountRef.current = pending.length
    if (pending.length > before) {
      const latest = pending[pending.length - 1]
      setAnnouncement(
        `新的审批请求：${latest?.description || latest?.toolName || '需要确认'}。共 ${pending.length} 项待处理`,
      )
    }
  }, [pending])
  useEffect(() => {
    if (runningRef.current && !running) setAnnouncement('回复已完成')
    runningRef.current = running
  }, [running])

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

  // 切到另一个会话时退出子代理只读视图，避免回来时还停在子会话。
  const prevSessionRef = useRef(sessionId)
  useEffect(() => {
    if (prevSessionRef.current !== sessionId) {
      prevSessionRef.current = sessionId
      if (agentSession) closeAgentSession()
    }
  }, [sessionId, agentSession, closeAgentSession])

  const retryTurn = () => {
    const state = useAppStore.getState()
    const view = sessionTarget
      ? state.sessionViews[`${sessionTarget.hostId}:${sessionTarget.sessionId}`]
      : state.active
    if (!view || view.running) return
    const last = view.messages.slice().reverse().find((m) => m.role === 'user')
    if (last) state.send(last.content, sessionTarget)
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
      if (!isTargetFocused(sessionTarget ?? null)) return
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
      useAppStore.getState().interrupt(sessionTarget)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [running, sessionTarget])

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

  const myId = team?.role === 'owner' ? 'owner' : team?.member?.id
  const otherViewers: TeamPresence[] = viewers.filter((viewer) => viewer.id !== myId)
  const readOnly = team?.role === 'observer' || team?.role === 'approver'

  if (!hasSession) {
    return (
      <div ref={rootRef} className="min-h-0 flex-1 overflow-y-auto">
        <HomeView />
      </div>
    )
  }

  // 反馈12#05：打开子代理会话的只读视图（面包屑可逐层返回主会话）。
  if (agentSession && hostId && agentSession.hostId === hostId) {
    return (
      <SubagentSessionView
        key={`${agentSession.id}:${agentSession.nonce}`}
        hostId={hostId}
        id={agentSession.id}
      />
    )
  }

  return (
    <div ref={rootRef} data-compact={compact ? 'true' : undefined} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      {authError && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-danger/25 bg-danger-soft/50 px-4 py-1.5 text-[13px] text-danger">
          <ShieldAlert size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">
            主机认证失败：{authError}（请在设置 → 主机中检查 Token）
          </span>
          {canDoctor && hostId && (
            <Button
              onClick={() => openDoctor(hostId)}
              className="min-h-7 shrink-0 px-2 text-[12px]"
            >
              运行诊断
            </Button>
          )}
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
            style={chatWide > 0 ? { ['--chat-wide' as string]: `${chatWide}px` } : undefined}
            className={cn(
              'mx-auto flex min-h-full w-full max-w-[808px] flex-col pb-8',
              compact ? 'px-2.5 pt-2' : 'px-4 pt-3 md:px-6 md:pt-5',
            )}
          >
            <div className="flex flex-1 flex-col">
              {otherViewers.length > 0 && (
                <div className="mb-2 flex items-center justify-end gap-1.5 px-1 text-[12px] text-muted">
                  <span className="mr-0.5">正在查看</span>
                  <div className="flex -space-x-1.5">
                    {otherViewers.slice(0, 4).map((viewer) => (
                      <span
                        key={viewer.id}
                        data-tip={`${viewer.name} · ${viewer.role === 'owner' ? '所有者' : viewer.role === 'observer' ? '观察者' : viewer.role === 'approver' ? '审批者' : '协作者'}`}
                        className="flex size-5 items-center justify-center rounded-full border border-bg bg-[var(--t-bg-active)] text-[11px] font-medium text-text-soft"
                      >
                        {viewer.name.slice(0, 1).toUpperCase()}
                      </span>
                    ))}
                  </div>
                  {otherViewers.length > 4 && <span>+{otherViewers.length - 4}</span>}
                </div>
              )}
              {forkedFrom && !loading && (
                <div className="mb-3 flex min-w-0 items-center gap-1.5 px-1 text-[12px] leading-4 text-muted">
                  <GitFork size={12} className="shrink-0 opacity-70" />
                  <span className="min-w-0 truncate" data-tip={parentTitle}>
                    分叉自 {parentTitle || '父会话'}
                  </span>
                  {parentSession && hostId && (
                    <>
                      <span className="shrink-0 opacity-60">·</span>
                      <button
                        type="button"
                        onClick={() =>
                          navigate({
                            kind: 'session',
                            hostId: hostId,
                            sessionId: parentSession.id,
                          })
                        }
                        className="shrink-0 rounded px-0.5 text-text-tertiary underline-offset-2 transition-colors hover:text-text hover:underline"
                      >
                        查看
                      </button>
                    </>
                  )}
                </div>
              )}
              {loading && messageCount === 0 ? (
                <MessageList showSkeleton />
              ) : messageCount === 0 ? (
                <>
                  <SessionWelcome />
                  <HandoffCard />
                </>
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
                    onClick={() => reloadActiveSession(sessionTarget)}
                    className="border-danger/30 px-2 text-[12px]"
                  >
                    重新加载
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>

        {(!compact || isMobile) && (
          <TurnRail
            scrollRef={scrollRef}
            sessionId={sessionId}
            onBeforeJump={() => {
              pinnedRef.current = false
              programmaticUntil.current = 0
              setShowJump(false)
            }}
          />
        )}

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

      <div
        data-composer-anchor
        className={cn(
          'shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1.5 md:pb-5 md:pt-2',
          compact ? 'px-2' : 'px-4 md:px-6',
        )}
      >
        <div className="mx-auto w-full max-w-[760px]">
          {summary && hostId && (
            <EnvBar
              variant="session"
              hostId={hostId}
              cwd={summary.cwd}
              env={summary.env}
              worktree={summary.worktree}
              compact={compact}
            />
          )}
          <DemoDeviceStage mounts={sessionMounts} />
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
          {readOnly ? (
            <div className="mb-2 rounded-xl border border-border bg-bg/50 px-3 py-2.5 text-center text-[12px] leading-5 text-muted">
              {team?.role === 'observer'
                ? '只读观察者：可以查看会话内容，不能发消息或审批。'
                : '审批者：可以处理审批请求，不能发消息或新建会话。'}
            </div>
          ) : (
            <Composer compact={compact} />
          )}
        </div>
      </div>
      <CompactConfirmDialog />
    </div>
  )
}
