import { BarChart3, Monitor, Palette, Plug, RefreshCw, Server, ShieldCheck, Sparkles } from 'lucide-react'
import type { SettingsTab } from '../../lib/types'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { ProfilesSection } from './ProfilesSection'
import { HostsSection } from './HostsSection'
import { AppearanceSection } from './AppearanceSection'
import { SyncSection } from './SyncSection'
import { PermissionsSection } from './PermissionsSection'
import { McpSection } from './McpSection'
import { UsageSection } from './UsageSection'

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Server }> = [
  { id: 'profiles', label: '账号与模型', icon: Sparkles },
  { id: 'hosts', label: 'Host 管理', icon: Server },
  { id: 'permissions', label: '权限', icon: ShieldCheck },
  { id: 'mcp', label: 'MCP', icon: Plug },
  { id: 'usage', label: '用量', icon: BarChart3 },
  { id: 'sync', label: '同步与备份', icon: RefreshCw },
  { id: 'appearance', label: '外观', icon: Palette },
]

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen)
  const tab = useUiStore((s) => s.settingsTab)
  const setTab = useUiStore((s) => s.setSettingsTab)
  const close = useUiStore((s) => s.closeSettings)

  return (
    <Modal
      open={open}
      onClose={close}
      title="设置"
      description="Host、账号与模型、MCP、用量、配置迁移，以及界面外观。"
      className="h-[min(640px,86dvh)] max-w-[min(880px,92vw)] max-sm:fixed max-sm:inset-0 max-sm:my-0 max-sm:h-auto max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
    >
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <nav className="grid shrink-0 grid-cols-2 gap-1 border-b border-border bg-bg/40 p-2 sm:flex sm:w-44 sm:flex-col sm:border-b-0 sm:border-r sm:p-3">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] transition-colors duration-[120ms] sm:min-h-9',
                  tab === t.id
                    ? 'bg-surface text-text shadow-[var(--t-shadow-sm)] ring-1 ring-border'
                    : 'text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text',
                )}
              >
                <Icon size={14} className={tab === t.id ? 'text-accent' : 'text-muted'} />
                {t.label}
              </button>
            )
          })}
          <div className="mt-auto hidden items-center gap-1.5 px-2.5 pb-1 text-[10px] text-muted sm:flex">
            <Monitor size={11} /> Tandem 0.1 · Web
          </div>
        </nav>
        <div
          key={tab}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 motion-reduce:animate-none sm:p-5 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]"
          style={{ animation: 'tandem-fade-in 120ms var(--t-ease-out) both' }}
        >
          {tab === 'profiles' && <ProfilesSection />}
          {tab === 'hosts' && <HostsSection />}
          {tab === 'permissions' && <PermissionsSection />}
          {tab === 'mcp' && <McpSection />}
          {tab === 'usage' && <UsageSection />}
          {tab === 'sync' && <SyncSection />}
          {tab === 'appearance' && <AppearanceSection />}
        </div>
      </div>
    </Modal>
  )
}
