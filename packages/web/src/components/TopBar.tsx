import { Menu, PanelLeft, PanelRight, Plus, RefreshCw, Settings } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useIsMobile } from '../lib/hooks'
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
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">
        <span className="size-1.5 rounded-full bg-danger" />
        离线
      </span>
    )
  }
  if (connecting) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning">
        <span className="size-1.5 rounded-full bg-warning running-dot" />
        连接中
      </span>
    )
  }
  if (status === 'waiting_permission') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning">
        <span className="size-1.5 rounded-full bg-warning running-dot" />
        待审批
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">
        <span className="size-1.5 rounded-full bg-danger" />
        出错
      </span>
    )
  }
  if (running || status === 'running') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
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
  const title = useAppStore((s) => s.active?.summary?.title ?? null)
  const model = useAppStore((s) => s.active?.summary?.model ?? null)
  const status = useAppStore((s) => s.active?.summary?.status)
  const running = useAppStore((s) => s.active?.running ?? false)

  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const panelOpen = useUiStore((s) => s.panelOpen)
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed)
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)
  const togglePanel = useUiStore((s) => s.togglePanel)
  const setMobilePanel = useUiStore((s) => s.setMobilePanel)
  const setNewSessionOpen = useUiStore((s) => s.setNewSessionOpen)
  const openSettings = useUiStore((s) => s.openSettings)
  const retryHost = useAppStore((s) => s.retryHost)

  const offline = runtime?.status === 'offline'
  const connecting = runtime?.status === 'connecting'
  const heading = hasSession ? title || '新会话' : host?.name || 'Tandem'

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/80 bg-bg/85 px-2.5 backdrop-blur-md md:px-3">
      <button
        onClick={() => {
          if (isMobile) setMobileSidebar(true)
          else setSidebarCollapsed(!sidebarCollapsed)
        }}
        aria-label={isMobile ? '打开侧栏' : '切换侧栏'}
        title={isMobile ? '打开侧栏' : '切换侧栏 (Ctrl+B)'}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text md:size-10"
      >
        {isMobile ? <Menu size={19} /> : <PanelLeft size={18} />}
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="truncate text-[14px] font-medium leading-5">{heading}</h1>
        {hasSession && (
          <StatePill
            running={running}
            status={status}
            offline={offline}
            connecting={connecting}
          />
        )}
        {!hasSession && !isMobile && host && (
          <span className="hidden items-center gap-1.5 text-[11.5px] text-muted sm:flex">
            <ConnectionDot state={runtime?.status ?? 'connecting'} />
            {runtime?.status === 'online' ? '在线' : runtime?.status === 'connecting' ? '连接中…' : '离线'}
          </span>
        )}
        {hasSession && model && (
          <span className="hidden max-w-[220px] truncate rounded-md border border-border/70 bg-surface-2/50 px-1.5 py-0.5 text-[10.5px] text-muted lg:block">
            {model}
          </span>
        )}
      </div>

      {offline && (
        <button
          onClick={() => activeHostId && retryHost(activeHostId)}
          className="hidden h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[11.5px] text-text-soft transition-colors hover:bg-surface-2 sm:flex"
        >
          <RefreshCw size={13} /> 重连
        </button>
      )}

      <button
        onClick={() => setNewSessionOpen(true)}
        aria-label="新会话"
        title="新会话"
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text md:size-10',
          sidebarCollapsed ? 'md:flex' : 'md:hidden',
        )}
      >
        <Plus size={19} />
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
            'flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors md:size-10',
            !isMobile && panelOpen
              ? 'bg-surface-2 text-text'
              : 'text-muted hover:bg-surface-2 hover:text-text',
          )}
        >
          <PanelRight size={18} />
        </button>
      )}

      <button
        onClick={() => openSettings()}
        aria-label="设置"
        title="设置"
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text md:size-10',
          sidebarCollapsed ? 'md:flex' : 'md:hidden',
        )}
      >
        <Settings size={18} />
      </button>
    </header>
  )
}
