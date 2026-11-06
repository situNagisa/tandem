import { Check, RefreshCw, Server } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { Popover } from './ui/Popover'
import { ConnectionDot } from './StatusDot'
import { Button, IconButton } from './ui/Button'

export function HostSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const activateHost = useAppStore((s) => s.activateHost)
  const retryHost = useAppStore((s) => s.retryHost)
  const active = hosts.find((h) => h.id === activeHostId) ?? null
  const runtime = active ? runtimes[active.id] : undefined
  const platform = runtime?.info?.platform

  return (
    <Popover
      side="top"
      align="left"
      padded={false}
      panelClassName="w-[272px] max-w-[calc(100vw-1rem)] rounded-[10px] p-[5px]"
      trigger={({ open, toggle }) => (
        <Button
          variant="ghost"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          tooltip={active ? `${active.name} · ${active.url.replace(/^https?:\/\//, '')}` : '选择 Host'}
          tooltipSide="top"
          className={cn(
            'min-w-0 max-w-[150px] justify-start gap-1.5 px-1.5 text-muted max-sm:min-h-11',
            open && 'bg-[var(--t-bg-active)] text-text',
          )}
        >
          <Server size={12} className="shrink-0 opacity-70" />
          <span className="min-w-0 truncate text-[11.5px]">
            {active ? active.name : '选择 Host'}
            {active && platform ? <span className="text-muted"> · {platform}</span> : null}
          </span>
          {runtime && <ConnectionDot state={runtime.status} className="size-1" />}
        </Button>
      )}
    >
      {(close) => (
        <div>
          <div className="menu-section">Hosts</div>
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
                    'flex items-center gap-1 rounded-md transition-colors hover:bg-[var(--t-bg-hover)]',
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
                    className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left"
                  >
                    <ConnectionDot state={rt?.status ?? 'connecting'} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{h.name}</span>
                      <span className="block truncate text-[10.5px] text-muted">
                        {rt?.info?.platform ? `${rt.info.platform} · ` : ''}
                        {h.url.replace(/^https?:\/\//, '')}
                      </span>
                    </span>
                    {isActive && <Check size={13} className="shrink-0 text-text" />}
                  </button>
                  {rt?.status === 'offline' && (
                    <IconButton
                      size="sm"
                      onClick={() => retryHost(h.id)}
                      label="立即重连"
                      className="mr-1 size-7 [&_svg]:size-3"
                    >
                      <RefreshCw size={12} />
                    </IconButton>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Popover>
  )
}
