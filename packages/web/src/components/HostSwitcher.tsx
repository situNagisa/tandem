import { ChevronDown } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { Menu } from './ui/Menu'

export function HostSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const activateHost = useAppStore((s) => s.activateHost)
  const openSettings = useUiStore((s) => s.openSettings)
  const active = hosts.find((h) => h.id === activeHostId) ?? null

  return (
    <Menu
      side="right"
      align="start"
      aria-label="切换主机"
      className="w-[210px]"
      trigger={({ open }) => (
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="menu"
          className={cn(
            'flex h-6 max-w-[110px] min-w-0 items-center gap-0.5 rounded-md px-1.5 text-[13px] text-text-tertiary transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text max-sm:h-11 max-sm:max-w-[140px] max-sm:px-2',
            open && 'bg-[var(--t-bg-active)] text-text',
          )}
        >
          <span className="min-w-0 truncate">{active ? active.name : '选择主机'}</span>
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      )}
    >
      {hosts.length === 0 && (
        <p className="px-2 py-2 text-[13px] text-text-tertiary">
          还没有主机，先添加一台吧。
        </p>
      )}
      {hosts.map((h) => {
        const rt = runtimes[h.id]
        const isActive = h.id === activeHostId
        const online = rt?.status === 'online'
        const detail = [
          h.url.replace(/^https?:\/\//, ''),
          rt?.info?.platform,
          h.mode === 'relay'
            ? '中继 · 加密'
            : h.mode === 'ssh'
              ? `SSH${rt?.latencyMs !== undefined ? ` · ${rt.latencyMs}ms` : ''}`
              : '直连',
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <Menu.Item
            key={h.id}
            selected={isActive}
            hint={online ? detail : `离线 · ${detail}`}
            className={online ? '!text-text' : '!text-text-tertiary'}
            onSelect={() => {
              if (isActive) return
              activateHost(h.id)
              navigate({ kind: 'host', hostId: h.id })
              onNavigate?.()
            }}
          >
            {h.name}
          </Menu.Item>
        )
      })}
      <Menu.Separator />
      <Menu.Item
        onSelect={() => {
          openSettings('hosts')
          onNavigate?.()
        }}
      >
        管理主机…
      </Menu.Item>
    </Menu>
  )
}
