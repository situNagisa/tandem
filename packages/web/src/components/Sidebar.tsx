import {
  Archive,
  ArchiveRestore,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  X,
} from 'lucide-react'
import { useUiStore } from '../store/useUiStore'
import { useAppStore } from '../store/useAppStore'
import { modLabel } from '../lib/format'
import { navigate, parseHash } from '../lib/router'
import { cn } from '../lib/cn'
import { isDesktop, isMacDesktop } from '../lib/desktop'
import { BrandMark } from './BrandMark'
import { HostSwitcher } from './HostSwitcher'
import { Button, IconButton } from './ui/Button'
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
  const resetComposer = useUiStore((s) => s.resetComposer)
  const archivedCount = useAppStore((s) =>
    Object.values(s.runtimes).reduce(
      (n, rt) => n + rt.sessions.filter((x) => x.archived).length,
      0,
    ),
  )

  const row = 'group w-full min-h-9 justify-start gap-2 px-2.5 md:min-h-8'

  const startNewSession = () => {
    // 已经在新会话页时导航不会重新挂载，需要显式清空输入并聚焦。
    if (parseHash().kind === 'home') resetComposer()
    setShowArchived(false)
    navigate({ kind: 'home' })
    onNavigate?.()
  }

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-border bg-sidebar">
      <div
        className={cn('flex items-center gap-2 px-3.5 pb-2 pt-3.5', isDesktop && 'desktop-drag')}
        style={isMacDesktop ? { paddingLeft: 72 } : undefined}
      >
        <BrandMark size={20} />
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

      <SessionList query="" onNavigate={onNavigate} />

      <div className="px-2 pb-1">
        <Button
          variant="ghost"
          onClick={() => setShowArchived(!showArchived)}
          aria-pressed={showArchived}
          className={cn(row, 'text-[12px] text-muted')}
        >
          {showArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          {showArchived ? '返回全部会话' : '已归档'}
          {archivedCount > 0 && (
            <span className="ml-auto rounded-full bg-[var(--t-bg-active)] px-1.5 text-[10px] tabular-nums text-text-soft">
              {archivedCount}
            </span>
          )}
        </Button>
      </div>

      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <HostSwitcher onNavigate={onNavigate} />
        <span className="flex-1" />
        <IconButton onClick={() => openSettings()} label="设置" tooltipSide="top">
          <Settings size={15} />
        </IconButton>
      </div>
    </aside>
  )
}
