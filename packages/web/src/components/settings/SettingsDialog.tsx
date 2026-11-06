import { BarChart3, Monitor, Palette, Plug, RefreshCw, Server, ShieldCheck, Sparkles } from 'lucide-react'
import type { SettingsTab } from '../../lib/types'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
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
              <Button
                key={t.id}
                variant="ghost"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={cn(
                  'min-h-11 w-full min-w-0 justify-start gap-2 px-2.5 text-left sm:min-h-[32px]',
                  tab === t.id && 'bg-[var(--t-bg-active)] text-text',
                )}
                icon={<Icon size={14} />}
              >
                {t.label}
              </Button>
            )
          })}
          <div className="mt-auto hidden items-center gap-1.5 px-2.5 pb-1 text-[10px] text-muted sm:flex">
            <Monitor size={11} /> Tandem 0.1 · Web
          </div>
        </nav>
        <div
          key={tab}
          className="min-h-0 min-w-0 flex-1 animate-[tandem-fade-in_120ms_ease-out_both] overflow-y-auto overscroll-contain p-4 motion-reduce:animate-none sm:p-5 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]"
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
