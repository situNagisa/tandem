import { PanelLeftClose, Plus, Search, Settings, SlidersHorizontal, X } from 'lucide-react'
import { useUiStore } from '../store/useUiStore'
import { useAppStore } from '../store/useAppStore'
import { modLabel } from '../lib/format'
import { navigate, parseHash } from '../lib/router'
import { cn } from '../lib/cn'
import { isDesktop, isMacDesktop } from '../lib/desktop'
import { HostSwitcher } from './HostSwitcher'
import { Popover } from './ui/Popover'
import { Button, IconButton } from './ui/Button'
import { MenuDivider, MenuItem, MenuList } from './ui/Menu'
import { SessionList } from './SessionList'

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
  const resetComposer = useUiStore((s) => s.resetComposer)
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
    <Popover
      side="right"
      align="left"
      padded={false}
      panelClassName="w-[210px] rounded-[10px] p-[5px]"
      trigger={({ open, toggle }) => (
        <IconButton
          size="sm"
          onClick={toggle}
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
      {() => (
        <MenuList aria-label="筛选会话">
          <MenuItem
            role="menuitemcheckbox"
            ariaChecked={showExternalSessions}
            selected={showExternalSessions}
            onSelect={() => setShowExternalSessions(!showExternalSessions)}
          >
            Claude Code / Codex
          </MenuItem>
          <MenuDivider />
          <MenuItem
            role="menuitemcheckbox"
            ariaChecked={showArchived}
            selected={showArchived}
            trailing={archivedCount > 0 ? archivedCount : undefined}
            onSelect={() => setShowArchived(!showArchived)}
          >
            已归档会话
          </MenuItem>
        </MenuList>
      )}
    </Popover>
  )

  return (
    <aside className="flex h-full w-full shrink-0 flex-col overflow-x-hidden border-r border-border bg-sidebar">
      <div
        className={cn('flex items-center gap-2 px-3.5 pb-2 pt-3.5', isDesktop && 'desktop-drag')}
        style={isMacDesktop ? { paddingLeft: 72 } : undefined}
      >
        <span className="font-serif text-[17px] font-medium leading-none tracking-tight">Tandem</span>
        <span className="flex-1" />
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
        <Button variant="ghost" onClick={startNewSession} className={row}>
          <Plus size={15} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">新会话</span>
          <kbd className="hidden shrink-0 text-[10px] font-normal text-muted md:inline">
            {modLabel} N
          </kbd>
        </Button>
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
    </aside>
  )
}
