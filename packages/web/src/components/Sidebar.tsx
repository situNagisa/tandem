import { Check, PanelLeftClose, Plus, Search, Settings, SlidersHorizontal, X } from 'lucide-react'
import { useUiStore } from '../store/useUiStore'
import { useAppStore } from '../store/useAppStore'
import { modLabel } from '../lib/format'
import { navigate, parseHash } from '../lib/router'
import { cn } from '../lib/cn'
import { isDesktop, isMacDesktop } from '../lib/desktop'
import { BrandMark } from './BrandMark'
import { HostSwitcher } from './HostSwitcher'
import { Popover } from './ui/Popover'
import { Button, IconButton } from './ui/Button'
import { SessionList } from './SessionList'

function FilterItem({
  checked,
  label,
  onClick,
}: {
  checked: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      className="menu-item"
    >
      <span
        className={cn(
          'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors',
          checked ? 'border-text-tertiary/60 bg-[var(--t-bg-active)]' : 'border-border-strong',
        )}
      >
        {checked && <Check size={10} className="text-text" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

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
  const showSubagents = useUiStore((s) => s.showSubagents)
  const setShowSubagents = useUiStore((s) => s.setShowSubagents)
  const resetComposer = useUiStore((s) => s.resetComposer)
  const archivedCount = useAppStore((s) =>
    Object.values(s.runtimes).reduce(
      (n, rt) => n + rt.sessions.filter((x) => x.archived).length,
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
      side="bottom"
      align="right"
      padded={false}
      panelClassName="w-[210px] rounded-[10px] p-[5px]"
      trigger={({ open, toggle }) => (
        <IconButton
          size="sm"
          onClick={toggle}
          label="筛选会话"
          tooltip="筛选"
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
        <div>
          <FilterItem
            checked={showExternalSessions}
            label="Claude Code / Codex"
            onClick={() => setShowExternalSessions(!showExternalSessions)}
          />
          <FilterItem
            checked={showSubagents}
            label="子代理会话"
            onClick={() => setShowSubagents(!showSubagents)}
          />
          <div className="my-1 border-t border-border" />
          <FilterItem
            checked={showArchived}
            label={archivedCount > 0 ? `已归档会话（${archivedCount}）` : '已归档会话'}
            onClick={() => setShowArchived(!showArchived)}
          />
        </div>
      )}
    </Popover>
  )

  return (
    <aside className="flex h-full w-full shrink-0 flex-col overflow-x-hidden border-r border-border bg-sidebar">
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
