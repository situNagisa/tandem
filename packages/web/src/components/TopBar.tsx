import { useEffect, useRef, useState } from 'react'
import {
  FileDiff,
  GitBranch,
  GitFork,
  Menu,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  Settings,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useIsMobile, useNow } from '../lib/hooks'
import { useSessionChanges } from '../lib/useChanges'
import { basename, formatElapsed } from '../lib/format'
import { clearRunning, runningSince } from '../lib/runClock'
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { isDesktop, isMacDesktop, isWindowsDesktop } from '../lib/desktop'
import { ConnectionDot } from './StatusDot'

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
  const pill = 'flex shrink-0 items-center gap-1.5 text-[10.5px] text-text-secondary'
  if (offline) return null
  if (connecting) {
    return (
      <span className={pill}>
        <span className="size-1.5 rounded-full bg-accent/80 running-dot" />
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
    return (
      <span className={pill}>
        <span className="size-1.5 rounded-full bg-danger/80" />
        出错
      </span>
    )
  }
  if (running || status === 'running') {
    return (
      <span className={pill}>
        <span className="size-1.5 rounded-full bg-accent running-dot" />
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
  const hasHosts = useAppStore((s) => s.hosts.length > 0)
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
  const openSettings = useUiStore((s) => s.openSettings)

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

  const project = summary?.env?.repoName || basename(summary?.cwd ?? '')
  const branch = summary?.env?.branch
  const worktree = summary?.worktree

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
      <button
        onClick={() => {
          if (isMobile) setMobileSidebar(true)
          else setSidebarCollapsed(!sidebarCollapsed)
        }}
        aria-label={isMobile ? '打开侧栏' : '切换侧栏'}
        title={isMobile ? '打开侧栏' : '切换侧栏 (Ctrl+B)'}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text md:size-9"
      >
        {isMobile ? <Menu size={18} /> : <PanelLeft size={17} />}
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {hasSession ? (
          editing ? (
            <input
              ref={inputRef}
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
              className="h-7 min-w-0 max-w-[320px] flex-1 rounded-md border border-border-strong bg-surface px-2 text-[13px] font-medium outline-none md:flex-none md:w-[min(320px,40vw)]"
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
        ) : (
          <h1 className="truncate px-1 text-[14px] font-medium leading-5">
            {host?.name || 'Tandem'}
          </h1>
        )}

        {hasSession && (
          <span
            className="hidden min-w-0 shrink items-center gap-1 rounded-md bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[10.5px] leading-4 text-text-soft sm:flex"
            title={
              worktree
                ? `隔离分支（worktree）${worktree.branch}，基于 ${worktree.baseBranch}`
                : undefined
            }
          >
            <span className="max-w-[90px] truncate">{host?.name ?? 'Host'}</span>
            {project && (
              <>
                <span className="text-muted">·</span>
                <span className="max-w-[110px] truncate">{project}</span>
              </>
            )}
            {(worktree?.branch || branch) && (
              <>
                <span className="hidden text-muted sm:inline">·</span>
                <span className="hidden min-w-0 items-center gap-0.5 sm:flex">
                  {worktree ? (
                    <GitFork size={10} className="shrink-0 text-accent/80" />
                  ) : (
                    <GitBranch size={10} className="shrink-0 text-muted" />
                  )}
                  <span className="max-w-[110px] truncate">{worktree?.branch || branch}</span>
                  {worktree && <span className="text-[9px] text-muted">worktree</span>}
                </span>
              </>
            )}
          </span>
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
            <span className="hidden items-center gap-1.5 text-[10.5px] text-muted sm:flex">
              <ConnectionDot state={runtime?.status ?? 'connecting'} />
              {runtime?.status === 'online' ? '在线' : runtime?.status === 'connecting' ? '连接中…' : '离线'}
            </span>
          )
        )}
      </div>

      {hasSession && changes && (
        <button
          onClick={() => setChangesOpen(!changesOpen)}
          aria-label="改动审阅"
          title="改动审阅"
          aria-pressed={changesOpen}
          className={cn(
            'flex h-8 shrink-0 items-center gap-1 rounded-lg px-1.5 font-mono text-[11px] transition-colors md:h-7',
            changesOpen
              ? 'bg-accent-soft/70 text-text'
              : 'text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text',
          )}
        >
          <FileDiff size={13.5} className={cn('shrink-0', changesOpen ? 'text-accent' : 'text-muted')} />
          <span className="hidden font-sans text-[11px] sm:inline">改动</span>
          {fileCount > 0 && !changesOpen && (
            <>
              <span className="text-success">+{additions}</span>
              <span className="text-danger">−{deletions}</span>
            </>
          )}
        </button>
      )}

      {hasHosts && (
        <button
          onClick={() => {
            navigate({ kind: 'home' })
            useUiStore.getState().setShowArchived(false)
          }}
          aria-label="新会话"
          title="新会话"
          className={cn(
            'size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:size-9',
            hasSession && isMobile ? 'hidden' : 'flex',
            sidebarCollapsed ? 'md:flex' : 'md:hidden',
          )}
        >
          <Plus size={18} />
        </button>
      )}

      {hasSession && (
        <button
          onClick={() => {
            setChangesOpen(false)
            if (isMobile) setMobilePanel(true)
            else togglePanel()
          }}
          aria-label="切换信息面板"
          title="会话信息"
          aria-pressed={!isMobile && panelOpen}
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors md:size-9',
            !isMobile && panelOpen
              ? 'text-accent hover:bg-[var(--t-bg-hover)]'
              : 'text-muted hover:bg-[var(--t-bg-hover)] hover:text-text',
          )}
        >
          <PanelRight size={17} />
        </button>
      )}

      {hasSession && (
        <button
          onClick={() => openSettings()}
          aria-label="设置"
          title="设置"
          className={cn(
            'size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:size-9',
            hasSession && isMobile ? 'hidden' : 'flex',
          )}
        >
          <Settings size={17} />
        </button>
      )}

      {offline && (
        <div className="pointer-events-none absolute inset-x-0 top-full z-20 flex h-6 items-center justify-center gap-1.5 border-b border-border/60 bg-bg/95 text-[10.5px] text-muted backdrop-blur-sm">
          <span className="size-1.5 rounded-full bg-warning/70 running-dot" />
          <span>重新连接中…</span>
          <button
            onClick={() => activeHostId && retryHost(activeHostId)}
            className="pointer-events-auto ml-1 rounded px-1 text-[10.5px] text-text-soft underline-offset-2 transition-colors hover:text-text hover:underline"
          >
            立即重试
          </button>
        </div>
      )}
    </header>
  )
}
