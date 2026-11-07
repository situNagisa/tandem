import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Bell, BookOpen, Bot, Brain, CalendarClock, FlaskConical, KeyRound, Mic, Monitor, MousePointerClick, Network, Palette, Plug, RefreshCw, ScrollText, Search, Server, Settings, Share2, ShieldCheck, SlidersHorizontal, Sparkles, Users, Wallet, Webhook } from 'lucide-react'
import type { SettingsTab } from '../../lib/types'
import { useUiStore } from '../../store/useUiStore'
import { useAppStore } from '../../store/useAppStore'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input } from '../ui/Controls'
import { SETTINGS_ITEMS, SETTINGS_TAB_LABELS } from '../../lib/settingsRegistry'
import { textMatches } from '../../lib/pinyin'
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
import { SecretsSection } from './SecretsSection'
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
  { id: 'general', label: SETTINGS_TAB_LABELS.general, icon: SlidersHorizontal },
  { id: 'voice', label: SETTINGS_TAB_LABELS.voice, icon: Mic },
  { id: 'browser', label: SETTINGS_TAB_LABELS.browser, icon: MousePointerClick },
  { id: 'profiles', label: SETTINGS_TAB_LABELS.profiles, icon: Sparkles },
  { id: 'hosts', label: SETTINGS_TAB_LABELS.hosts, icon: Server },
  { id: 'team', label: SETTINGS_TAB_LABELS.team, icon: Users },
  { id: 'gateway', label: SETTINGS_TAB_LABELS.gateway, icon: Network },
  { id: 'permissions', label: SETTINGS_TAB_LABELS.permissions, icon: ShieldCheck },
  { id: 'hooks', label: SETTINGS_TAB_LABELS.hooks, icon: Webhook },
  { id: 'mcp', label: SETTINGS_TAB_LABELS.mcp, icon: Plug },
  { id: 'secrets', label: SETTINGS_TAB_LABELS.secrets, icon: KeyRound },
  { id: 'skills', label: SETTINGS_TAB_LABELS.skills, icon: BookOpen },
  { id: 'memory', label: SETTINGS_TAB_LABELS.memory, icon: Brain },
  { id: 'subagents', label: SETTINGS_TAB_LABELS.subagents, icon: Bot },
  { id: 'prompts', label: SETTINGS_TAB_LABELS.prompts, icon: ScrollText },
  { id: 'evals', label: SETTINGS_TAB_LABELS.evals, icon: FlaskConical },
  { id: 'schedules', label: SETTINGS_TAB_LABELS.schedules, icon: CalendarClock },
  { id: 'budgets', label: SETTINGS_TAB_LABELS.budgets, icon: Wallet },
  { id: 'usage', label: SETTINGS_TAB_LABELS.usage, icon: BarChart3 },
  { id: 'notifications', label: SETTINGS_TAB_LABELS.notifications, icon: Bell },
  { id: 'shares', label: SETTINGS_TAB_LABELS.shares, icon: Share2 },
  { id: 'sync', label: SETTINGS_TAB_LABELS.sync, icon: RefreshCw },
  { id: 'appearance', label: SETTINGS_TAB_LABELS.appearance, icon: Palette },
]

export function SettingsDialog() {
  const open = useUiStore((s) => s.settingsOpen)
  const tab = useUiStore((s) => s.settingsTab)
  const setTab = useUiStore((s) => s.setSettingsTab)
  const close = useUiStore((s) => s.closeSettings)
  const role = useAppStore((s) =>
    s.activeHostId ? s.runtimes[s.activeHostId]?.team?.role : undefined,
  )
  const focusSetting = useUiStore((s) => s.focusSetting)
  const focus = useUiStore((s) => s.settingsFocus)
  // 成员连接只保留客户端自己的设置页；Host 级设置由服务端 403 兜底。
  const memberTabs = new Set<SettingsTab>(['hosts', 'appearance', 'notifications'])
  const tabs = role && role !== 'owner' ? TABS.filter((item) => memberTabs.has(item.id)) : TABS
  const [query, setQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    if (!tabs.some((item) => item.id === tab)) setTab(tabs[0]?.id ?? 'appearance')
  }, [open, tab, role, setTab, tabs])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setSearchIndex(0)
    }
  }, [open])

  const searchMatches = useMemo(() => {
    const q = query.trim()
    if (!q) return []
    const allowed = new Set(tabs.map((item) => item.id))
    return SETTINGS_ITEMS.filter(
      (item) =>
        allowed.has(item.tab) &&
        (textMatches(item.title, q) || item.keywords.some((word) => textMatches(word, q))),
    )
  }, [query, tabs])

  // 命令面板选中设置项后：等目标页渲染出来，滚动到中间并短暂高亮。
  useEffect(() => {
    if (!open || !focus) return
    let timer = 0
    let attempts = 0
    const locate = () => {
      const root = contentRef.current
      const target = root?.querySelector<HTMLElement>(
        `[data-setting-id="${CSS.escape(focus.id)}"]`,
      )
      if (!target) {
        if (attempts++ < 40) timer = window.setTimeout(locate, 50)
        return
      }
      target.scrollIntoView({ block: 'center', behavior: 'auto' })
      target.classList.remove('setting-highlight')
      void target.getBoundingClientRect()
      target.classList.add('setting-highlight')
      window.setTimeout(() => target.classList.remove('setting-highlight'), 1800)
    }
    timer = window.setTimeout(locate, 30)
    return () => window.clearTimeout(timer)
  }, [open, focus, tab])

  const pickSetting = (id: string, targetTab: SettingsTab) => {
    focusSetting(targetTab, id)
    setQuery('')
    setSearchIndex(0)
  }

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
        <nav aria-label="设置页签" className="grid shrink-0 grid-cols-3 gap-1 overflow-y-auto border-b border-border bg-bg/40 p-2 max-sm:max-h-[340px] sm:flex sm:min-h-0 sm:w-52 sm:flex-col sm:border-b-0 sm:border-r sm:p-3">
          <div className="col-span-3 shrink-0 sm:col-span-1">
            <div className="relative">
              <Search
                size={13}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
              />
              <Input
                size="sm"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setSearchIndex(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSearchIndex((i) => Math.min(searchMatches.length - 1, Math.max(0, i + 1)))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSearchIndex((i) => Math.max(0, i - 1))
                  } else if (e.key === 'Enter') {
                    const item = searchMatches[searchIndex]
                    if (item) {
                      e.preventDefault()
                      pickSetting(item.id, item.tab)
                    }
                  }
                }}
                placeholder="搜索设置项"
                aria-label="搜索设置项"
                className="pl-7"
              />
            </div>
          </div>
          {query.trim() ? (
            <div className="col-span-3 min-h-0 space-y-0.5 overflow-y-auto sm:col-span-1 sm:flex-1">
              {searchMatches.length === 0 ? (
                <p className="px-2 py-3 text-[12px] text-muted">没有匹配的设置项</p>
              ) : (
                searchMatches.map((item, i) => (
                  <button
                    key={item.id}
                    type="button"
                    onMouseEnter={() => setSearchIndex(i)}
                    onClick={() => pickSetting(item.id, item.tab)}
                    className={cn(
                      'flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[120ms]',
                      i === searchIndex
                        ? 'bg-[var(--t-bg-active)] text-text'
                        : 'text-text-soft hover:bg-[var(--t-bg-hover)]',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
                    <span className="shrink-0 text-[12px] text-muted">
                      {SETTINGS_TAB_LABELS[item.tab]}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : (
          tabs.map((t) => {
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
          }))}
          {!query.trim() && (
            <div className="mt-auto hidden items-center gap-1.5 px-2.5 pb-1 text-[13px] text-muted sm:flex">
              <Monitor size={11} /> Tandem 0.1 · Web
            </div>
          )}
        </nav>
        <div
          key={tab}
          ref={contentRef}
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
        {tab === 'secrets' && <SecretsSection />}
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
