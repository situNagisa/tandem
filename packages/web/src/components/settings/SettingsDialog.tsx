import { useEffect } from 'react'
import { BarChart3, Bell, BookOpen, Bot, Brain, CalendarClock, FlaskConical, Mic, Monitor, MousePointerClick, Network, Palette, Plug, RefreshCw, ScrollText, Server, Settings, Share2, ShieldCheck, SlidersHorizontal, Sparkles, Users, Wallet, Webhook } from 'lucide-react'
import type { SettingsTab } from '../../lib/types'
import { useUiStore } from '../../store/useUiStore'
import { useAppStore } from '../../store/useAppStore'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { ProfilesSection } from './ProfilesSection'
import { HostsSection } from './HostsSection'
import { TeamSection } from './TeamSection'
import { GatewaySection } from './GatewaySection'
import { AppearanceSection } from './AppearanceSection'
import { SyncSection } from './SyncSection'
import { PermissionsSection } from './PermissionsSection'
import { McpSection } from './McpSection'
import { SkillsSection } from './SkillsSection'
import { MemorySection } from './MemorySection'
import { SubagentsSection } from './SubagentsSection'
import { PromptsSection } from './PromptsSection'
import { HooksSection } from './HooksSection'
import { SharesSection } from './SharesSection'
import { UsageSection } from './UsageSection'
import { SchedulesSection } from './SchedulesSection'
import { BudgetsSection } from './BudgetsSection'
import { NotificationsSection } from './NotificationsSection'
import { GeneralSettings } from './GeneralSettings'
import { VoiceSection } from './VoiceSection'
import { BrowserSection } from './BrowserSection'
import { EvalsSection } from './EvalsSection'

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Server }> = [
  { id: 'general', label: '通用', icon: SlidersHorizontal },
  { id: 'voice', label: '语音', icon: Mic },
  { id: 'browser', label: '浏览器', icon: MousePointerClick },
  { id: 'profiles', label: '账号与模型', icon: Sparkles },
  { id: 'hosts', label: 'Host 管理', icon: Server },
  { id: 'team', label: '成员', icon: Users },
  { id: 'gateway', label: '网关', icon: Network },
  { id: 'permissions', label: '权限', icon: ShieldCheck },
  { id: 'hooks', label: 'Hooks', icon: Webhook },
  { id: 'mcp', label: 'MCP', icon: Plug },
  { id: 'skills', label: 'Skills', icon: BookOpen },
  { id: 'memory', label: '记忆', icon: Brain },
  { id: 'subagents', label: '子代理', icon: Bot },
  { id: 'prompts', label: '提示词', icon: ScrollText },
  { id: 'evals', label: '评测', icon: FlaskConical },
  { id: 'schedules', label: '定时任务', icon: CalendarClock },
  { id: 'budgets', label: '预算', icon: Wallet },
  { id: 'usage', label: '用量', icon: BarChart3 },
  { id: 'notifications', label: '通知', icon: Bell },
  { id: 'shares', label: '分享', icon: Share2 },
  { id: 'sync', label: '同步与备份', icon: RefreshCw },
  { id: 'appearance', label: '外观', icon: Palette },
]

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen)
  const tab = useUiStore((s) => s.settingsTab)
  const setTab = useUiStore((s) => s.setSettingsTab)
  const close = useUiStore((s) => s.closeSettings)
  const role = useAppStore((s) =>
    s.activeHostId ? s.runtimes[s.activeHostId]?.team?.role : undefined,
  )
  // 成员连接只保留客户端自己的设置页；Host 级设置由服务端 403 兜底。
  const memberTabs = new Set<SettingsTab>(['hosts', 'appearance', 'notifications'])
  const tabs = role && role !== 'owner' ? TABS.filter((item) => memberTabs.has(item.id)) : TABS

  useEffect(() => {
    if (!open) return
    if (!tabs.some((item) => item.id === tab)) setTab(tabs[0]?.id ?? 'appearance')
  }, [open, tab, role, setTab, tabs])

  return (
    <Modal
      open={open}
      onClose={close}
      ariaLabel="设置"
      title={
        <span className="flex items-center gap-2">
          <Settings size={14} className="text-muted" />
          设置
        </span>
      }
      className="h-[clamp(600px,82vh,920px)] w-[min(94vw,clamp(880px,72vw,1320px))] max-w-none [&>div:first-child]:h-11 [&>div:first-child]:items-center [&>div:first-child]:py-0 max-sm:fixed max-sm:inset-0 max-sm:my-0 max-sm:h-auto max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
    >
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <nav aria-label="设置页签" className="grid shrink-0 grid-cols-3 gap-1 border-b border-border bg-bg/40 p-2 max-sm:max-h-[340px] max-sm:overflow-y-auto sm:flex sm:w-44 sm:flex-col sm:border-b-0 sm:border-r sm:p-3">
          {tabs.map((t) => {
            const Icon = t.icon
            return (
              <Button
                key={t.id}
                variant="ghost"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={cn(
                  'min-h-11 w-full min-w-0 justify-start gap-2 px-2.5 text-left text-[13px] font-normal sm:min-h-8',
                  tab === t.id && 'bg-[var(--t-bg-active)] text-text',
                )}
                icon={<Icon size={14} />}
              >
                {t.label}
              </Button>
            )
          })}
          <div className="mt-auto hidden items-center gap-1.5 px-2.5 pb-1 text-[13px] text-muted sm:flex">
            <Monitor size={11} /> Tandem 0.1 · Web
          </div>
        </nav>
        <div
          key={tab}
          className="min-h-0 min-w-0 flex-1 animate-[tandem-fade-in_120ms_ease-out_both] overflow-y-auto overscroll-contain p-4 motion-reduce:animate-none sm:p-5 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11 max-sm:[&_input]:min-h-11 max-sm:[&_select]:min-h-11"
        >
          <div className="mx-auto w-full max-w-[1100px]">
            {tab === 'general' && <GeneralSettings />}
            {tab === 'voice' && <VoiceSection />}
            {tab === 'browser' && <BrowserSection />}
            {tab === 'profiles' && <ProfilesSection />}
            {tab === 'hosts' && <HostsSection />}
            {tab === 'team' && <TeamSection />}
            {tab === 'gateway' && <GatewaySection />}
            {tab === 'permissions' && <PermissionsSection />}
            {tab === 'hooks' && <HooksSection />}
            {tab === 'mcp' && <McpSection />}
            {tab === 'skills' && <SkillsSection />}
            {tab === 'memory' && <MemorySection />}
            {tab === 'subagents' && <SubagentsSection />}
            {tab === 'prompts' && <PromptsSection />}
            {tab === 'evals' && <EvalsSection />}
            {tab === 'schedules' && <SchedulesSection />}
            {tab === 'shares' && <SharesSection />}
            {tab === 'budgets' && <BudgetsSection />}
            {tab === 'usage' && <UsageSection />}
            {(tab as string) === 'notifications' && <NotificationsSection />}
            {tab === 'sync' && <SyncSection />}
            {tab === 'appearance' && <AppearanceSection />}
          </div>
        </div>
      </div>
    </Modal>
  )
}
