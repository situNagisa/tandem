import { useEffect, useRef, useState } from 'react'
import { Check, ChevronsUpDown, Plus, RefreshCw, Server, Settings2 } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { navigate } from '../lib/router'
import { useClickOutside } from '../lib/hooks'
import { cn } from '../lib/cn'
import { ConnectionDot } from './StatusDot'

export function HostSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const activateHost = useAppStore((s) => s.activateHost)
  const retryHost = useAppStore((s) => s.retryHost)
  const openSettings = useUiStore((s) => s.openSettings)
  const active = hosts.find((h) => h.id === activeHostId) ?? null
  const runtime = active ? runtimes[active.id] : undefined
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, () => setOpen(false), open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const close = () => setOpen(false)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'flex min-h-11 w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-[var(--t-bg-hover)] md:min-h-0',
          open && 'bg-[var(--t-bg-active)]',
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--t-bg-active)] text-text-soft">
          <Server size={13} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium leading-4 text-text">
            {active?.name ?? '选择 Host'}
          </span>
          <span className="block truncate text-[10.5px] leading-4 text-muted">
            {active ? active.url.replace(/^https?:\/\//, '') : '尚未添加任何 Host'}
          </span>
        </span>
        {runtime && <ConnectionDot state={runtime.status} />}
        <ChevronsUpDown size={13} className="shrink-0 text-muted" />
      </button>

      {open && (
        <div
          role="menu"
          className="anim-pop absolute left-0 top-full z-50 mt-1.5 w-[272px] max-w-[calc(100vw-1.25rem)] origin-top-left rounded-xl border border-border bg-surface p-1.5 shadow-[var(--t-shadow-md)]"
        >
          <div className="px-2.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
            Hosts
          </div>
          <div className="max-h-64 overflow-y-auto">
            {hosts.length === 0 && (
              <p className="px-2.5 py-3 text-[12.5px] text-muted">还没有 Host，先添加一台吧。</p>
            )}
            {hosts.map((h) => {
              const rt = runtimes[h.id]
              const isActive = h.id === activeHostId
              return (
                <div
                  key={h.id}
                  className={cn(
                    'flex items-center gap-1 rounded-lg transition-colors hover:bg-[var(--t-bg-hover)]',
                    isActive && 'bg-[var(--t-bg-active)]',
                  )}
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      close()
                      if (isActive) return
                      activateHost(h.id)
                      navigate({ kind: 'host', hostId: h.id })
                      onNavigate?.()
                    }}
                    className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left"
                  >
                    <ConnectionDot state={rt?.status ?? 'connecting'} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">{h.name}</span>
                      <span className="block truncate text-[10.5px] text-muted">
                        {rt?.info?.platform ? `${rt.info.platform} · ` : ''}
                        {h.url.replace(/^https?:\/\//, '')}
                      </span>
                    </span>
                    {isActive && <Check size={13} className="shrink-0 text-accent" />}
                  </button>
                  {rt?.status === 'offline' && (
                    <button
                      onClick={() => retryHost(h.id)}
                      title="立即重连"
                      aria-label="立即重连"
                      className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-[var(--t-bg-hover)] hover:text-text"
                    >
                      <RefreshCw size={12} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="mt-1 border-t border-border pt-1">
            <button
              role="menuitem"
              onClick={() => {
                close()
                openSettings('hosts')
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
            >
              <Plus size={13} /> 添加远程 Host
            </button>
            <button
              role="menuitem"
              onClick={() => {
                close()
                openSettings('hosts')
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
            >
              <Settings2 size={13} /> 管理 Host
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
