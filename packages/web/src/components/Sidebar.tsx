import { useState } from 'react'
import { Moon, PanelLeftClose, Plus, Search, Settings, Sun, X } from 'lucide-react'
import { useUiStore } from '../store/useUiStore'
import { modLabel } from '../lib/format'
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
  const [query, setQuery] = useState('')
  const setNewSessionOpen = useUiStore((s) => s.setNewSessionOpen)
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed)
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)
  const openSettings = useUiStore((s) => s.openSettings)
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-2.5 px-3.5 pb-2 pt-4">
        <BrandMark size={26} />
        <span className="font-serif text-[20px] font-medium tracking-tight">Tandem</span>
        <span className="mt-1 text-[10.5px] text-muted">多端协同工作台</span>
        <span className="flex-1" />
        {inDrawer ? (
          <button
            onClick={() => setMobileSidebar(false)}
            aria-label="关闭侧栏"
            className="flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text md:size-9"
          >
            <X size={17} />
          </button>
        ) : (
          <button
            onClick={() => setSidebarCollapsed(true)}
            aria-label="收起侧栏"
            title="收起侧栏 (Ctrl+B)"
            className="hidden size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text md:flex"
          >
            <PanelLeftClose size={16} />
          </button>
        )}
      </div>

      <div className="px-3 pt-1">
        <HostSwitcher onNavigate={onNavigate} />
      </div>

      <div className="px-3 pb-1.5 pt-2.5">
        <button
          onClick={() => {
            setNewSessionOpen(true)
            onNavigate?.()
          }}
          className="flex min-h-11 w-full items-center gap-2 rounded-xl bg-accent md:min-h-10 px-3 text-[13.5px] font-medium text-on-accent shadow-[0_1px_2px_rgba(80,40,20,0.2)] transition-colors duration-150 hover:bg-accent-hover"
        >
          <Plus size={16} />
          新会话
          <kbd className="ml-auto hidden rounded border border-white/25 px-1.5 text-[10px] font-normal opacity-80 md:block">
            {modLabel} N
          </kbd>
        </button>
      </div>

      <div className="px-3 pb-1">
        <div className="group relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
            className="h-10 w-full rounded-lg border border-transparent md:h-9 bg-surface-2/50 pl-8 pr-3 text-[12.5px] md:pr-12 text-text outline-none transition-colors placeholder:text-muted focus:border-border-strong/60 focus:bg-surface"
          />
          <button
            onClick={() => setSearchOpen(true)}
            title="搜索全部 Host 的会话 (Ctrl+K)"
            className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] leading-4 text-muted transition-colors hover:text-text md:block"
          >
            {modLabel} K
          </button>
        </div>
      </div>

      <SessionList query={query} onNavigate={onNavigate} />

      <div className="flex items-center gap-1 border-t border-border/80 px-2.5 py-2">
        <button
          onClick={() => openSettings()}
          className="flex min-h-11 flex-1 items-center gap-2 rounded-lg px-2 md:min-h-9 text-[12.5px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
        >
          <Settings size={15} className="text-muted" />
          设置
        </button>
        <button
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          title={isDark ? '切换到浅色' : '切换到深色'}
          aria-label={isDark ? '切换到浅色主题' : '切换到深色主题'}
          className="flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text md:size-9"
        >
          {isDark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </aside>
  )
}
