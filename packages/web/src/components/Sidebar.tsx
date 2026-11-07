import { Inbox, PanelLeftClose, Plus, Search, Send, Settings, SlidersHorizontal, X } from 'lucide-react'
import { useUiStore } from '../store/useUiStore'
import { useAppStore } from '../store/useAppStore'
import { modLabel } from '../lib/format'
import { navigate, parseHash } from '../lib/router'
import { cn } from '../lib/cn'
import { isDesktop, isMacDesktop } from '../lib/desktop'
import { HostSwitcher } from './HostSwitcher'
import { Button, IconButton } from './ui/Button'
import { Menu } from './ui/Menu'
import { SessionList } from './SessionList'
import { useInboxCount } from './inbox/InboxView'

const EXTERNAL_SOURCES = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
] as const

export function Sidebar({
  inDrawer = false,
  onNavigate,
}: {
  inDrawer?: boolean
  onNavigate?: () => void
}) {
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed)
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)
  const openSettings = useUiStore((s) => s.openSettings)
  const showArchived = useUiStore((s) => s.showArchived)
  const setShowArchived = useUiStore((s) => s.setShowArchived)
  const showExternalSessions = useUiStore((s) => s.showExternalSessions)
  const setShowExternalSessions = useUiStore((s) => s.setShowExternalSessions)
  const hiddenExternalSources = useUiStore((s) => s.hiddenExternalSources)
  const setExternalSourceVisible = useUiStore((s) => s.setExternalSourceVisible)
  const resetComposer = useUiStore((s) => s.resetComposer)
  const setInboxOpen = useUiStore((s) => s.setInboxOpen)
  const setDispatchOpen = useUiStore((s) => s.setDispatchOpen)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const teamRole = useAppStore((s) =>
    s.activeHostId ? s.runtimes[s.activeHostId]?.team?.role : undefined,
  )
  const readOnly = teamRole === 'observer' || teamRole === 'approver'
  const inboxCount = useInboxCount()
  const archivedCount = useAppStore((s) =>
    Object.values(s.runtimes).reduce(
      (n, rt) => n + rt.sessions.filter((x) => x.archived && !x.parentId).length,
      0,
    ),
  )

  const row = 'group w-full min-h-11 justify-start gap-2 px-2.5 md:min-h-8'

  const startNewSession = () => {
    // 已经在新会话页时导航不会重新挂载，需要显式清空输入并聚焦。
    if (parseHash().kind === 'home') resetComposer()
    setShowArchived(false)
    navigate({ kind: 'home' })
    onNavigate?.()
  }

  const filter = (
    <Menu
      side="right"
      align="start"
      aria-label="筛选会话"
      className="w-[210px]"
      trigger={({ open }) => (
        <IconButton
          size="sm"
          label="筛选会话"
          tooltip={open ? '' : '筛选'}
          tooltipSide="bottom"
          aria-expanded={open}
          aria-haspopup="menu"
          className={cn('max-sm:size-11', open && 'bg-[var(--t-bg-active)] text-text')}
        >
          <SlidersHorizontal size={14} />
        </IconButton>
      )}
    >
      {EXTERNAL_SOURCES.map((source) => {
        const visible = showExternalSessions && !hiddenExternalSources.includes(source.value)
        return (
          <Menu.CheckItem
            key={source.value}
            checked={visible}
            onCheckedChange={() => {
              if (!showExternalSessions) {
                setShowExternalSessions(true)
                return
              }
              setExternalSourceVisible(source.value, !visible)
            }}
          >
            {source.label}
          </Menu.CheckItem>
        )
      })}
      <Menu.Separator />
      <Menu.CheckItem
        checked={showArchived}
        onCheckedChange={() => setShowArchived(!showArchived)}
        trailing={archivedCount > 0 ? archivedCount : undefined}
      >
        已归档会话
      </Menu.CheckItem>
    </Menu>
  )

  return (
    <div className="flex h-full w-full shrink-0 flex-col overflow-x-hidden border-r border-border bg-sidebar dark:[--t-text-secondary:#cfcfcf] dark:[--t-text-tertiary:#9a9a9a]">
      <div
        className={cn('flex items-center gap-2 px-3.5 pb-2 pt-3.5', isDesktop && 'desktop-drag')}
        style={isMacDesktop ? { paddingLeft: 72 } : undefined}
      >
        <span className="font-serif text-[17px] font-medium leading-none tracking-tight">Tandem</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            setInboxOpen(true)
            onNavigate?.()
          }}
          aria-label={inboxCount > 0 ? `收件箱，${inboxCount} 条待处理` : '收件箱'}
          title={inboxCount > 0 ? `收件箱（${inboxCount} 条待处理）` : '收件箱'}
          className={cn(
            'relative inline-flex size-8 items-center justify-center rounded-md text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text max-sm:size-11',
            inboxCount > 0 && 'text-text',
          )}
        >
          <Inbox size={16} />
          {inboxCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-strong px-1 text-[11px] font-semibold leading-none text-on-accent">
              {inboxCount > 99 ? '99+' : inboxCount}
            </span>
          )}
        </button>
        {inDrawer ? (
          <IconButton
            onClick={() => setMobileSidebar(false)}
            label="关闭侧栏"
            tooltipSide="bottom"
            className="max-sm:size-11"
          >
            <X size={16} />
          </IconButton>
        ) : (
          <IconButton
            onClick={() => setSidebarCollapsed(true)}
            label="收起侧栏"
            tooltip={`收起侧栏 (${modLabel} B)`}
            className="hidden md:inline-flex"
          >
            <PanelLeftClose size={15} />
          </IconButton>
        )}
      </div>

      <div className="px-2 pb-1">
        {!readOnly && (
        <Button variant="ghost" onClick={startNewSession} className={row}>
          <Plus size={15} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">新会话</span>
          <kbd className="hidden shrink-0 text-[10px] font-normal text-muted md:inline">
            {modLabel} N
          </kbd>
        </Button>
        )}
        {!readOnly && (
        <Button
          variant="ghost"
          onClick={() => {
            setDispatchOpen(true, activeHostId ?? undefined)
            onNavigate?.()
          }}
          className={row}
          tooltip="向任意在线 Host 派单"
          tooltipSide="bottom"
        >
          <Send size={15} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">派单</span>
        </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            setSearchOpen(true)
            onNavigate?.()
          }}
          className={row}
          tooltip={`搜索全部 Host 的会话 (${modLabel} K)`}
          tooltipSide="bottom"
        >
          <Search size={15} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">搜索</span>
          <kbd className="hidden shrink-0 text-[10px] font-normal text-muted md:inline">
            {modLabel} K
          </kbd>
        </Button>
      </div>

      <SessionList
        query=""
        onNavigate={onNavigate}
        headerActions={
          <>
            <HostSwitcher onNavigate={onNavigate} />
            {filter}
          </>
        }
      />

      <div className="border-t border-border px-2 py-1.5">
        <Button
          variant="ghost"
          onClick={() => {
            openSettings()
            onNavigate?.()
          }}
          className={cn(row, 'text-[12.5px] text-text-tertiary')}
        >
          <Settings size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">设置</span>
        </Button>
      </div>
    </div>
  )
}
