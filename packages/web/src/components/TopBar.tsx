import { useEffect, useRef, useState } from 'react'
import {
  FileDiff,
  Menu,
  PanelLeft,
  PanelRight,
  Pencil,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useTurnNavStore } from '../store/useTurnNavStore'
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
import { BackgroundTasksButton, FilesButton, SubagentsButton } from './chat/SessionHeaderTools'

function StatePill({
  running,
  status,
  offline,
  connecting,
  elapsed,
}: {
  running: boolean
  status?: string
  offline: boolean
  connecting: boolean
  elapsed?: string
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
  if (status === 'waiting_permission') {
    return (
      <span className={pill}>
        <span className="size-1.5 rounded-full bg-accent" />
        待审批{elapsed ? ` · ${elapsed}` : ''}
      </span>
    )
  }
  if (status === 'error') {
    return <span className={cn(pill, 'text-danger')}>出错</span>
  }
  if (running || status === 'running') {
    return (
      <span className={pill}>
        <span className="size-1.5 rounded-full bg-text-secondary running-dot" />
        运行中{elapsed ? ` · ${elapsed}` : ''}
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
  const running = useAppStore((s) => s.active?.running ?? false)
  const ticking = running || status === 'waiting_permission'
  const now = useNow(ticking)
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
    <header
      className={cn(
        'relative z-20 flex shrink-0 items-center gap-1.5 bg-bg px-2 md:px-3',
        // Windows 自绘标题栏高 36px（titleBarOverlay.height），顶栏与之对齐。
        isWindowsDesktop ? 'h-9' : 'h-12',
        isDesktop && 'desktop-drag',
        isWindowsDesktop && 'pr-[140px]',
        isMacDesktop && sidebarCollapsed && 'pl-[72px]',
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

      <div className="flex min-w-0 flex-1 items-center gap-2">
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
              className="group flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
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
            <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[11px] leading-4 text-muted">
              只读
            </span>
          </div>
        ) : (
          <h1 className="truncate px-1 text-[14px] font-medium leading-5">
            {host?.name || 'Tandem'}
          </h1>
        )}

        {hasSession ? (
          <StatePill
            running={running}
            status={status}
            offline={offline}
            connecting={connecting}
            elapsed={elapsed}
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

      {hasSession && isMobile && turnTotal >= 2 && (
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

      {hasSession && !isMobile && (
        <>
          <BackgroundTasksButton />
          <SubagentsButton />
          <FilesButton />
        </>
      )}

      {hasSession && changes && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setChangesOpen(!changesOpen)}
          aria-label="改动审阅"
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
              <span className="text-[var(--t-git-plus)]">+{additions}</span>
              <span className="text-[var(--t-git-minus)]">−{deletions}</span>
            </>
          )}
        </Button>
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
  )
}
