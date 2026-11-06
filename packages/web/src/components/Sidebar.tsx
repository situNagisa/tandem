import { useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  History,
  Moon,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Sun,
  X,
} from 'lucide-react'
import { useUiStore } from '../store/useUiStore'
import { useAppStore } from '../store/useAppStore'
import { modLabel } from '../lib/format'
import { navigate } from '../lib/router'
import { BrandMark } from './BrandMark'
import { HostSwitcher } from './HostSwitcher'
import { SessionList } from './SessionList'
import { ExternalSessionsDialog } from './ExternalSessionsDialog'

export function Sidebar({
  inDrawer = false,
  onNavigate,
}: {
  inDrawer?: boolean
  onNavigate?: () => void
}) {
  const [query, setQuery] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed)
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)
  const openSettings = useUiStore((s) => s.openSettings)
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const showArchived = useUiStore((s) => s.showArchived)
  const setShowArchived = useUiStore((s) => s.setShowArchived)
  const archivedCount = useAppStore((s) =>
    Object.values(s.runtimes).reduce(
      (n, rt) => n + rt.sessions.filter((x) => x.archived).length,
      0,
    ),
  )
  const hasHosts = useAppStore((s) => s.hosts.length > 0)
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  const startNewSession = () => {
    setShowArchived(false)
    navigate({ kind: 'home' })
    onNavigate?.()
  }

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-2 px-3.5 pb-1 pt-3.5">
        <BrandMark size={22} />
        <span className="font-serif text-[18px] font-medium leading-none tracking-tight">Tandem</span>
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

      <div className="px-2.5 pt-1.5">
        <HostSwitcher onNavigate={onNavigate} />
      </div>

      <div className="px-2.5 pb-1.5 pt-2">
        <button
          onClick={startNewSession}
          className="group flex min-h-11 w-full items-center gap-2 rounded-lg border border-border bg-surface/70 px-2.5 text-[13px] font-medium text-text-soft transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text md:min-h-9"
        >
          <Plus size={15} className="text-accent" />
          新会话
          <kbd className="ml-auto hidden rounded border border-border px-1.5 py-px text-[9.5px] font-normal text-muted md:block">
            {modLabel} N
          </kbd>
        </button>
      </div>

      <div className="px-2.5 pb-1">
        <div className="group relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
            className="h-11 w-full rounded-lg border border-transparent bg-transparent pl-8 pr-14 text-[12.5px] text-text outline-none transition-colors placeholder:text-muted hover:bg-[var(--t-bg-hover)] focus:border-border focus:bg-surface md:h-8"
          />
          <button
            onClick={() => setSearchOpen(true)}
            title={`搜索全部 Host 的会话 (${modLabel} K)`}
            className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-surface px-1.5 py-0.5 text-[9.5px] leading-4 text-muted transition-colors hover:text-text md:block"
          >
            {modLabel} K
          </button>
        </div>
      </div>

      <SessionList query={query} onNavigate={onNavigate} />

      {hasHosts && (
        <>
          <div className="px-2.5 pb-1">
            <button
              onClick={() => setImportOpen(true)}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-[12px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:min-h-8"
            >
              <History size={14} />
              导入会话
              <span className="ml-auto hidden text-[9.5px] text-muted md:inline">CC / Codex</span>
            </button>
          </div>

          <div className="px-2.5 pb-1">
            <button
              onClick={() => setShowArchived(!showArchived)}
              aria-pressed={showArchived}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-[12px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:min-h-8"
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
        </>
      )}

      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <button
          onClick={() => openSettings()}
          className="flex min-h-11 flex-1 items-center gap-2 rounded-lg px-2 text-[12.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:min-h-8"
        >
          <Settings size={14} className="text-muted" />
          设置
        </button>
        <button
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          title={isDark ? '切换到浅色' : '切换到深色'}
          aria-label={isDark ? '切换到浅色主题' : '切换到深色主题'}
          className="flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text md:size-8"
        >
          {isDark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>

      <ExternalSessionsDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </aside>
  )
}
