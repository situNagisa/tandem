import { Check, ChevronsUpDown, Plus, RefreshCw, Server, Settings2 } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { ConnectionDot } from './StatusDot'
import { Popover } from './ui/Popover'

export function HostSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const activateHost = useAppStore((s) => s.activateHost)
  const retryHost = useAppStore((s) => s.retryHost)
  const openSettings = useUiStore((s) => s.openSettings)
  const active = hosts.find((h) => h.id === activeHostId) ?? null
  const runtime = active ? runtimes[active.id] : undefined

  return (
    <Popover
      className="w-full"
      panelClassName="w-[288px] max-w-[calc(100vw-1.5rem)]"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          className={cn(
            'flex w-full items-center gap-2.5 rounded-xl border border-border bg-surface px-2.5 py-2 text-left transition-colors hover:bg-surface-2/60',
            open && 'bg-surface-2/60',
          )}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Server size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium leading-5">
              {active?.name ?? '选择 Host'}
            </span>
            <span className="block truncate text-[11px] leading-4 text-muted">
              {active ? active.url.replace(/^https?:\/\//, '') : '尚未添加任何 Host'}
            </span>
          </span>
          {runtime && <ConnectionDot state={runtime.status} className="mr-0.5" />}
          <ChevronsUpDown size={14} className="shrink-0 text-muted" />
        </button>
      )}
    >
      {(close) => (
        <div>
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
                  className="flex items-center gap-1 rounded-lg transition-colors hover:bg-surface-2"
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
                    className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
                  >
                    <ConnectionDot state={rt?.status ?? 'connecting'} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{h.name}</span>
                      <span className="block truncate text-[11px] text-muted">
                        {rt?.info?.platform ? `${rt.info.platform} · ` : ''}
                        {h.url.replace(/^https?:\/\//, '')}
                      </span>
                    </span>
                    {isActive && <Check size={14} className="shrink-0 text-accent" />}
                  </button>
                  {rt?.status === 'offline' && (
                    <button
                      onClick={() => retryHost(h.id)}
                      title="立即重连"
                      aria-label="立即重连"
                      className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-border/50 hover:text-text"
                    >
                      <RefreshCw size={13} />
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
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
            >
              <Plus size={14} /> 添加远程 Host
            </button>
            <button
              role="menuitem"
              onClick={() => {
                close()
                openSettings('hosts')
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
            >
              <Settings2 size={14} /> 管理 Host
            </button>
          </div>
        </div>
      )}
    </Popover>
  )
}
