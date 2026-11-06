import { ChevronDown } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { Popover } from './ui/Popover'
import { MenuDivider, MenuItem, MenuList } from './ui/Menu'

export function HostSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const activateHost = useAppStore((s) => s.activateHost)
  const openSettings = useUiStore((s) => s.openSettings)
  const active = hosts.find((h) => h.id === activeHostId) ?? null

  return (
    <Popover
      side="bottom"
      align="right"
      padded={false}
      panelClassName="w-[210px] rounded-[10px] p-[5px]"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          className={cn(
            'flex h-6 max-w-[110px] min-w-0 items-center gap-0.5 rounded-md px-1.5 text-[11.5px] text-text-tertiary transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text',
            open && 'bg-[var(--t-bg-active)] text-text',
          )}
        >
          <span className="min-w-0 truncate">{active ? active.name : '选择主机'}</span>
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      )}
    >
      {(close) => (
        <MenuList aria-label="切换主机">
          {hosts.length === 0 && (
            <p className="px-2 py-2 text-[12.5px] text-text-tertiary">
              还没有主机，先添加一台吧。
            </p>
          )}
          {hosts.map((h) => {
            const rt = runtimes[h.id]
            const isActive = h.id === activeHostId
            const online = rt?.status === 'online'
            const platform = rt?.info?.platform
            return (
              <MenuItem
                key={h.id}
                selected={isActive}
                trailing={platform}
                hint={online ? undefined : '离线，暂时无法连接'}
                className={online ? '!text-text' : '!text-text-tertiary'}
                onSelect={() => {
                  close()
                  if (isActive) return
                  activateHost(h.id)
                  navigate({ kind: 'host', hostId: h.id })
                  onNavigate?.()
                }}
              >
                {h.name}
              </MenuItem>
            )
          })}
          <MenuDivider />
          <MenuItem
            onSelect={() => {
              close()
              openSettings('hosts')
              onNavigate?.()
            }}
          >
            管理主机…
          </MenuItem>
        </MenuList>
      )}
    </Popover>
  )
}
