import { useEffect, useRef, useState } from 'react'
import type { RetryInfo } from '@tandem/protocol'
import {
  FileDiff,
  Menu,
  PanelLeft,
  PanelRight,
  Pencil,
  Search,
  Send,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useTurnNavStore } from '../store/useTurnNavStore'
import { useTaskStore } from '../store/useTaskStore'
import { useIsMobile, useNow } from '../lib/hooks'
import { useSessionChanges } from '../lib/useChanges'
import { formatElapsed } from '../lib/format'
import { clearRunning, runningSince } from '../lib/runClock'
import { navigate, useRoute } from '../lib/router'
import { cn } from '../lib/cn'
import { isDesktop, isMacDesktop, isWindowsDesktop } from '../lib/desktop'
import { ConnectionDot } from './StatusDot'
import { Button, IconButton } from './ui/Button'
import { Input } from './ui/Controls'
import { BackgroundTasksButton, BrowserButton, FilesButton, SubagentsButton } from './chat/SessionHeaderTools'
import { EvalRunsButton } from './evals/EvalRunsButton'
import { PrButton, PrPanel } from './PrPanel'

function StatePill({
  running,
  status,
  offline,
  connecting,
  elapsed,
  retryInfo,
  retrySeconds,
  resumePaused,
  onRetryNow,
  onStop,
  onResume,
}: {
  running: boolean
  status?: string
  offline: boolean
  connecting: boolean
  elapsed?: string
  retryInfo?: RetryInfo
  retrySeconds?: number
  resumePaused?: boolean
  onRetryNow?: () => void
  onStop?: () => void
  onResume?: () => void
}) {
  const pill = 'flex shrink-0 items-center gap-1.5 text-[12px] text-text-secondary'
  if (offline) return null
  if (connecting) {
    return (
      <span className={pill}>
        <span className="size-1.5 rounded-full bg-text-secondary/80 running-dot" />
        连接中
      </span>
    )
  }
  if (status === 'retrying' || retryInfo) {
    return (
      <span className={cn(pill, 'rounded-full border border-border bg-surface px-2 py-1')}>
        <span className="size-1.5 rounded-full bg-warning running-dot" />
        <span className="whitespace-nowrap">
          {retrySeconds && retrySeconds > 0
            ? `网络中断，${retrySeconds} 秒后重试`
            : '网络中断，正在重试…'}
        </span>
        <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[12px]" onClick={onRetryNow}>
          立即重试
        </Button>
        <span className="text-border-strong">·</span>
        <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[12px]" onClick={onStop}>
          停止
        </Button>
      </span>
    )
  }
  if (resumePaused) {
    return (
      <span className={cn(pill, 'rounded-full border border-border bg-surface px-2 py-1')}>
        <span className="size-1.5 rounded-full bg-text-tertiary" />
        <span className="whitespace-nowrap">重启后已暂停</span>
        <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[12px]" onClick={onResume}>
          继续运行
        </Button>
      </span>
    )
  }
  if (status === 'waiting_permission') {
    return (
      <span className={pill}>
        <span className="size-1.5 shrink-0 rounded-full bg-accent" />
        <span className="truncate whitespace-nowrap">
          待审批{elapsed ? ` · ${elapsed}` : ''}
        </span>
      </span>
    )
  }
  if (status === 'error') {
    return <span className={cn(pill, 'text-danger')}>出错</span>
  }
  if (running || status === 'running') {
    return (
      <span className={pill}>
        <span className="size-1.5 shrink-0 rounded-full bg-text-secondary running-dot" />
        <span className="truncate whitespace-nowrap">
          运行中{elapsed ? ` · ${elapsed}` : ''}
        </span>
      </span>
    )
  }
  return null
}

export function TopBar() {
  const isMobile = useIsMobile()
  const activeHostId = useAppStore((s) => s.activeHostId)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const runtime = useAppStore((s) => (activeHostId ? s.runtimes[activeHostId] : undefined))
  const hasSession = useAppStore((s) => !!s.active)
  const route = useRoute()
  const externalTitle = useAppStore((s) => {
    if (route.kind !== 'external') return null
    return (
      s.externalSessions[route.hostId]?.find(
        (x) => x.source === route.source && x.id === route.id,
      )?.title ??
      s.runtimes[route.hostId]?.externalSessions.find(
        (x) => x.source === route.source && x.id === route.id,
      )?.title ??
      null
    )
  })
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const status = summary?.status
  const retrying = status === 'retrying' || !!summary?.retryInfo
  const running = useAppStore((s) => s.active?.running ?? false)
  const activeSessionHostId = useAppStore((s) => s.active?.hostId ?? null)
  const activeSessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const hasBackgroundTasks = useTaskStore((s) =>
    activeSessionHostId && activeSessionId
      ? (s.byHost[activeSessionHostId] ?? []).some((task) => task.sessionId === activeSessionId)
      : false,
  )
  const ticking = running || status === 'waiting_permission' || status === 'retrying'
  const now = useNow(ticking)
  const retrySeconds = summary?.retryInfo
    ? Math.max(0, Math.ceil((summary.retryInfo.nextAt - now) / 1000))
    : undefined
  const retryNow = useAppStore((s) => s.retryNow)
  const interrupt = useAppStore((s) => s.interrupt)
  const resumePaused = useAppStore((s) => s.resumePaused)
  const runKey = summary ? `${activeHostId ?? ''}:${summary.id}` : null
  const elapsed =
    ticking && summary && runKey
      ? formatElapsed(now - runningSince(runKey, summary.updatedAt))
      : undefined

  useEffect(() => {
    if (runKey && !ticking) clearRunning(runKey)
  }, [runKey, ticking])
  const updateSession = useAppStore((s) => s.updateSession)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const changesNonce = useAppStore((s) => s.changesNonce)
  const { changes } = useSessionChanges(host, sessionId, changesNonce, !!sessionId)
  const fileCount = changes?.files.length ?? 0
  const additions = changes?.files.reduce((n, f) => n + f.additions, 0) ?? 0
  const deletions = changes?.files.reduce((n, f) => n + f.deletions, 0) ?? 0

  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const panelOpen = useUiStore((s) => s.panelOpen)
  const changesOpen = useUiStore((s) => s.changesOpen)
  const setChangesOpen = useUiStore((s) => s.setChangesOpen)
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed)
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)
  const setDispatchOpen = useUiStore((s) => s.setDispatchOpen)
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const togglePanel = useUiStore((s) => s.togglePanel)
  const setMobilePanel = useUiStore((s) => s.setMobilePanel)
  const retryHost = useAppStore((s) => s.retryHost)
  const turnTotal = useTurnNavStore((s) => s.total)
  const turnActive = useTurnNavStore((s) => s.active)
  const setTurnSheetOpen = useTurnNavStore((s) => s.setSheetOpen)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const committingRef = useRef(false)
  const cancelEditRef = useRef(false)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  useEffect(() => {
    setEditing(false)
  }, [summary?.id])

  const offline = runtime?.status === 'offline'
  const connecting = runtime?.status === 'connecting'
  const title = summary?.title || '未命名会话'

  const commit = async () => {
    if (committingRef.current) return
    committingRef.current = true
    const next = draft.trim()
    setEditing(false)
    if (!summary || !activeHostId || !next || next === summary.title) {
      committingRef.current = false
      return
    }
    try {
      await updateSession(activeHostId, summary.id, { title: next })
    } finally {
      committingRef.current = false
    }
  }

  return (
    <>
    <header
      className={cn(
        'relative z-20 flex shrink-0 items-center gap-1.5 bg-bg px-2 md:px-3',
        // Windows 自绘标题栏高 36px（titleBarOverlay.height），顶栏与之对齐。
        isWindowsDesktop ? 'h-9' : 'h-12',
        isDesktop && 'desktop-drag',
        isWindowsDesktop && 'pr-[140px]',
        isMacDesktop && sidebarCollapsed && 'pl-[72px]',
        // 手机：标题/状态占一行，轮次与工具图标落到第二行，避免 360px 下互相挤压。
        'max-md:h-auto max-md:min-h-12 max-md:flex-wrap max-md:pb-0.5',
      )}
      style={isWindowsDesktop ? { paddingRight: 140 } : undefined}
    >
      <IconButton
        onClick={() => {
          if (isMobile) setMobileSidebar(true)
          else setSidebarCollapsed(!sidebarCollapsed)
        }}
        label={isMobile ? '打开侧栏' : '切换侧栏'}
        tooltip={isMobile ? '打开侧栏' : '切换侧栏 (Ctrl+B)'}
        className="max-sm:size-11"
      >
        {isMobile ? <Menu size={18} /> : <PanelLeft size={17} />}
      </IconButton>

      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {hasSession ? (
          editing ? (
            <Input
              ref={inputRef}
              size="sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (cancelEditRef.current) {
                  cancelEditRef.current = false
                  return
                }
                void commit()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelEditRef.current = true
                  setEditing(false)
                }
              }}
              className="max-w-[320px] flex-1 border-border-strong font-medium md:w-[min(320px,40vw)] md:flex-none"
              aria-label="重命名会话"
            />
          ) : (
            <button
              onClick={() => {
                committingRef.current = false
                cancelEditRef.current = false
                setDraft(summary?.title ?? '')
                setEditing(true)
              }}
              title="点击重命名"
              className="group flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[var(--t-bg-hover)] max-md:min-h-11"
            >
              <h1 className="truncate text-[14px] font-medium leading-5">{title}</h1>
              <Pencil
                size={11}
                className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
              />
            </button>
          )
        ) : route.kind === 'external' ? (
          <div className="flex min-w-0 items-center gap-1.5 px-1">
            <h1 className="truncate text-[14px] font-medium leading-5">
              {externalTitle || '外部会话'}
            </h1>
            <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[12px] leading-4 text-muted">
              只读
            </span>
          </div>
        ) : (
          <h1 className="truncate px-1 text-[14px] font-medium leading-5">
            {host?.name || 'Tandem'}
          </h1>
        )}

        {hasSession && !(isMobile && retrying) ? (
          <StatePill
            running={running}
            status={status}
            offline={offline}
            connecting={connecting}
            elapsed={elapsed}
            retryInfo={summary?.retryInfo}
            retrySeconds={retrySeconds}
            resumePaused={summary?.resumePaused}
            onRetryNow={retryNow}
            onStop={interrupt}
            onResume={() => void resumePaused()}
          />
        ) : (
          !isMobile &&
          host && (
            <span className="hidden items-center gap-1.5 text-[12px] text-muted sm:flex">
              <ConnectionDot state={runtime?.status ?? 'connecting'} />
              {runtime?.status === 'online' ? '在线' : runtime?.status === 'connecting' ? '连接中…' : '离线'}
            </span>
          )
        )}
      </div>

      {isMobile && (
        <IconButton
          onClick={() => setSearchOpen(true)}
          label="搜索"
          tooltip="搜索会话、命令与设置"
          className="max-sm:size-11"
        >
          <Search size={17} />
        </IconButton>
      )}

      {(!isMobile || !hasSession) && <EvalRunsButton />}

      {hasSession && !isMobile && (
        <>
          <BackgroundTasksButton />
          <SubagentsButton />
          <BrowserButton />
          <FilesButton />
          <PrButton />
        </>
      )}

      {hasSession && changes && !isMobile && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setChangesOpen(!changesOpen)}
          aria-label={
            fileCount > 0
              ? `改动+${additions}−${deletions}，打开改动审阅`
              : '改动，打开改动审阅'
          }
          tooltip="改动审阅"
          aria-pressed={changesOpen}
          className={cn(
            'gap-1 px-1.5 font-mono text-text! max-md:h-8',
            changesOpen && 'bg-[var(--t-bg-active)] text-text',
          )}
        >
          <FileDiff size={13.5} className="shrink-0 text-text!" />
          <span className="hidden font-sans text-[12px] sm:inline">改动</span>
          {fileCount > 0 && !changesOpen && (
            <>
              <span className="hidden text-[var(--t-git-plus)] sm:inline">+{additions}</span>
              <span className="hidden text-[var(--t-git-minus)] sm:inline">−{deletions}</span>
            </>
          )}
        </Button>
      )}

      {route.kind === 'home' && !isMobile && (
        <IconButton
          onClick={() => setDispatchOpen(true, activeHostId ?? undefined)}
          label="派单到其他 Host"
          tooltip="派单到其他 Host"
          className="max-sm:size-11"
        >
          <Send size={16} />
        </IconButton>
      )}

      {hasSession && (
        <IconButton
          onClick={() => {
            setChangesOpen(false)
            if (isMobile) setMobilePanel(true)
            else togglePanel()
          }}
          label="切换信息面板"
          tooltip="会话信息"
          aria-pressed={!isMobile && panelOpen}
          className={cn(
            'text-text! max-sm:size-11',
            !isMobile && panelOpen && 'bg-[var(--t-bg-active)] text-text',
          )}
        >
          <PanelRight size={17} />
        </IconButton>
      )}

      <PrPanel />

      {isMobile && hasSession && (
        <div className="flex w-full min-w-0 items-center gap-0.5 md:hidden">
          {turnTotal >= 2 && (
            <button
              type="button"
              onClick={() => setTurnSheetOpen(true)}
              aria-label="打开轮次大纲"
              className="flex h-11 shrink-0 items-center px-0.5"
            >
              <span className="rounded-full bg-[var(--t-bg-hover)] px-2 py-1 text-[12px] tabular-nums leading-4 text-text-soft transition-colors active:bg-[var(--t-bg-active)]">
                第 {turnActive}/{turnTotal} 轮
              </span>
            </button>
          )}
          <span className="min-w-0 flex-1" />
          <EvalRunsButton />
          <BackgroundTasksButton />
          <BrowserButton />
          {!hasBackgroundTasks && <PrButton />}
          {changes && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setChangesOpen(!changesOpen)}
              aria-label="改动审阅"
              tooltip="改动审阅"
              aria-pressed={changesOpen}
              className={cn(
                'size-11! justify-center gap-1 px-0 font-mono text-text! sm:size-8! sm:px-1.5',
                changesOpen && 'bg-[var(--t-bg-active)] text-text',
              )}
            >
              <FileDiff size={15} className="shrink-0 text-text!" />
              <span className="hidden text-[var(--t-git-plus)] sm:inline">+{additions}</span>
              <span className="hidden text-[var(--t-git-minus)] sm:inline">−{deletions}</span>
            </Button>
          )}
        </div>
      )}

      {offline && (
        <div className="pointer-events-none absolute inset-x-0 top-full z-20 flex h-6 items-center justify-center gap-1.5 border-b border-border/60 bg-bg/95 text-[12px] text-muted backdrop-blur-sm">
          <span className="size-1.5 rounded-full bg-muted/60 running-dot" />
          <span>重新连接中…</span>
          <button
            onClick={() => activeHostId && retryHost(activeHostId)}
            className="pointer-events-auto ml-1 rounded px-1 text-[12px] text-text-soft underline-offset-2 transition-colors hover:text-text hover:underline"
          >
            立即重试
          </button>
        </div>
      )}
    </header>
    {isMobile && hasSession && retrying && (
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface px-3 py-1.5 text-[12px] text-text-secondary">
        <span className="size-1.5 shrink-0 rounded-full bg-warning running-dot" />
        <span className="min-w-0 flex-1 truncate">
          {retrySeconds && retrySeconds > 0
            ? `网络中断，${retrySeconds} 秒后重试`
            : '网络中断，正在重试…'}
        </span>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[12px]" onClick={retryNow}>
          立即重试
        </Button>
        <span className="text-border-strong">·</span>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[12px]" onClick={interrupt}>
          停止
        </Button>
      </div>
    )}
    </>
  )
}
