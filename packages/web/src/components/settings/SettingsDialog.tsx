import { Monitor, Palette, RefreshCw, Server, Sparkles } from 'lucide-react'
import type { SettingsTab } from '../../lib/types'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { ProfilesSection } from './ProfilesSection'
import { HostsSection } from './HostsSection'
import { AppearanceSection } from './AppearanceSection'
import { SyncSection } from './SyncSection'

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Server }> = [
  { id: 'profiles', label: '账号与模型', icon: Sparkles },
  { id: 'hosts', label: 'Host 管理', icon: Server },
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
      description="Host、账号与模型、配置迁移，以及界面外观。"
      className="max-w-3xl"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
    >
      <div className="flex h-[min(76dvh,640px)] min-h-[420px] max-h-full flex-col sm:flex-row">
        <nav className="grid shrink-0 grid-cols-2 gap-1 border-b border-border bg-bg/40 p-2 sm:flex sm:w-44 sm:flex-col sm:border-b-0 sm:border-r sm:p-3">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] transition-colors duration-100 sm:min-h-9',
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
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-5">
          {tab === 'profiles' && <ProfilesSection />}
          {tab === 'hosts' && <HostsSection />}
          {tab === 'sync' && <SyncSection />}
          {tab === 'appearance' && <AppearanceSection />}
        </div>
      </div>
    </Modal>
  )
}
