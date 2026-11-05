import { useEffect, useRef, useState } from 'react'
import {
  GitBranch,
  Menu,
  PanelLeft,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useIsMobile } from '../lib/hooks'
import { basename } from '../lib/format'
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { ConnectionDot } from './StatusDot'

function StatePill({
  running,
  status,
  offline,
  connecting,
}: {
  running: boolean
  status?: string
  offline: boolean
  connecting: boolean
}) {
  if (offline) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-danger-soft px-2 py-0.5 text-[10.5px] font-medium text-danger">
        <span className="size-1.5 rounded-full bg-danger" />
        离线
      </span>
    )
  }
  if (connecting) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--t-bg-hover)] px-2 py-0.5 text-[10.5px] font-medium text-muted">
        <span className="size-1.5 rounded-full bg-accent running-dot" />
        连接中
      </span>
    )
  }
  if (status === 'waiting_permission') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-medium text-accent">
        <span className="size-1.5 rounded-full bg-accent" />
        待审批
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-danger-soft px-2 py-0.5 text-[10.5px] font-medium text-danger">
        <span className="size-1.5 rounded-full bg-danger" />
        出错
      </span>
    )
  }
  if (running || status === 'running') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-medium text-accent">
        <span className="size-1.5 rounded-full bg-accent running-dot" />
        运行中
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
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const status = summary?.status
  const running = useAppStore((s) => s.active?.running ?? false)
  const updateSession = useAppStore((s) => s.updateSession)

  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const panelOpen = useUiStore((s) => s.panelOpen)
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed)
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)
  const togglePanel = useUiStore((s) => s.togglePanel)
  const setMobilePanel = useUiStore((s) => s.setMobilePanel)
  const retryHost = useAppStore((s) => s.retryHost)
  const openSettings = useUiStore((s) => s.openSettings)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

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
    const next = draft.trim()
    setEditing(false)
    if (!summary || !activeHostId || !next || next === summary.title) return
    await updateSession(activeHostId, summary.id, { title: next })
  }

  const project = summary?.env?.repoName || basename(summary?.cwd ?? '')
  const branch = summary?.env?.branch

  return (
    <header className="flex h-12 shrink-0 items-center gap-1.5 bg-bg px-2 md:px-3">
      <button
        onClick={() => {
          if (isMobile) setMobileSidebar(true)
          else setSidebarCollapsed(!sidebarCollapsed)
        }}
        aria-label={isMobile ? '打开侧栏' : '切换侧栏'}
        title={isMobile ? '打开侧栏' : '切换侧栏 (Ctrl+B)'}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-100 hover:bg-[var(--t-bg-hover)] hover:text-text md:size-9"
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
              onBlur={() => void commit()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditing(false)
                }
              }}
              className="h-7 min-w-0 max-w-[320px] flex-1 rounded-md border border-border-strong bg-surface px-2 text-[13px] font-medium outline-none md:flex-none md:w-[min(320px,40vw)]"
              aria-label="重命名会话"
            />
          ) : (
            <button
              onClick={() => {
                setDraft(summary?.title ?? '')
                setEditing(true)
              }}
              title="点击重命名"
              className="group flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
            >
              <h1 className="truncate text-[13.5px] font-medium leading-5">{title}</h1>
              <Pencil
                size={11}
                className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
              />
            </button>
          )
        ) : (
          <h1 className="truncate px-1 text-[13.5px] font-medium leading-5">
            {host?.name || 'Tandem'}
          </h1>
        )}

        {hasSession && (
          <span className="hidden min-w-0 shrink items-center gap-1 rounded-md bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[10.5px] leading-4 text-text-soft sm:flex">
            <span className="max-w-[90px] truncate">{host?.name ?? 'Host'}</span>
            {project && (
              <>
                <span className="text-muted">·</span>
                <span className="max-w-[110px] truncate">{project}</span>
              </>
            )}
            {branch && (
              <>
                <span className="hidden text-muted sm:inline">·</span>
                <span className="hidden min-w-0 items-center gap-0.5 sm:flex">
                  <GitBranch size={10} className="shrink-0 text-muted" />
                  <span className="max-w-[110px] truncate">{branch}</span>
                </span>
              </>
            )}
          </span>
        )}

        {hasSession ? (
          <StatePill running={running} status={status} offline={offline} connecting={connecting} />
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

      {offline && (
        <button
          onClick={() => activeHostId && retryHost(activeHostId)}
          className="hidden h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-[11px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] sm:flex"
        >
          <RefreshCw size={11} /> 重连
        </button>
      )}

      <button
        onClick={() => {
          navigate({ kind: 'home' })
          useUiStore.getState().setShowArchived(false)
        }}
        aria-label="新会话"
        title="新会话"
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:size-9',
          sidebarCollapsed ? 'md:flex' : 'md:hidden',
        )}
      >
        <Plus size={18} />
      </button>

      {hasSession && (
        <button
          onClick={() => {
            if (isMobile) setMobilePanel(true)
            else togglePanel()
          }}
          aria-label="切换信息面板"
          title="会话信息"
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors md:size-9',
            !isMobile && panelOpen
              ? 'bg-[var(--t-bg-active)] text-text'
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
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:size-9"
        >
          <Settings size={17} />
        </button>
      )}

    </header>
  )
}
