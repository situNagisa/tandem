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
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { isDesktop, isMacDesktop } from '../lib/desktop'
import { BrandMark } from './BrandMark'
import { HostSwitcher } from './HostSwitcher'
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
  const archivedCount = useAppStore((s) =>
    Object.values(s.runtimes).reduce(
      (n, rt) => n + rt.sessions.filter((x) => x.archived).length,
      0,
    ),
  )

  const row =
    'group flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-text-soft transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text md:min-h-8'

  const startNewSession = () => {
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
          <button
            onClick={() => setMobileSidebar(false)}
            aria-label="关闭侧栏"
            className="flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:size-8"
          >
            <X size={16} />
          </button>
        ) : (
          <button
            onClick={() => setSidebarCollapsed(true)}
            aria-label="收起侧栏"
            title={`收起侧栏 (${modLabel} B)`}
            className="hidden size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:flex"
          >
            <PanelLeftClose size={15} />
          </button>
        )}
      </div>

      <div className="px-2 pb-1">
        <button onClick={startNewSession} className={row}>
          <Plus size={15} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">新会话</span>
          <kbd className="hidden shrink-0 text-[10px] font-normal text-muted md:inline">
            {modLabel} N
          </kbd>
        </button>
        <button
          onClick={() => {
            setSearchOpen(true)
            onNavigate?.()
          }}
          className={row}
          title={`搜索全部 Host 的会话 (${modLabel} K)`}
        >
          <Search size={15} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">搜索</span>
          <kbd className="hidden shrink-0 text-[10px] font-normal text-muted md:inline">
            {modLabel} K
          </kbd>
        </button>
      </div>

      <SessionList query="" onNavigate={onNavigate} />

      <div className="px-2 pb-1">
        <button
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
        </button>
      </div>

      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <HostSwitcher onNavigate={onNavigate} />
        <span className="flex-1" />
        <button
          onClick={() => openSettings()}
          aria-label="设置"
          title="设置"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
        >
          <Settings size={15} />
        </button>
      </div>
    </aside>
  )
}
