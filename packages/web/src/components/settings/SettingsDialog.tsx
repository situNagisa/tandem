import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Bell, BookOpen, Bot, Brain, CalendarClock, ChevronDown, FlaskConical, GitFork, Info, KeyRound, Mic, MousePointerClick, Network, Palette, Plug, RefreshCw, ScrollText, Search, Server, Settings, Share2, ShieldCheck, SlidersHorizontal, Sparkles, Users, Webhook } from 'lucide-react'
import type { SettingsTab } from '../../lib/types'
import { useUiStore } from '../../store/useUiStore'
import { useAppStore } from '../../store/useAppStore'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { Input, SegmentedControl } from '../ui/Controls'
import {
  SETTINGS_GROUPS,
  SETTINGS_ITEMS,
  SETTINGS_PAGES,
  SETTINGS_PAGE_MAP,
  SETTINGS_TAB_LABELS,
  type SettingsPageId,
} from '../../lib/settingsRegistry'
import { textMatches } from '../../lib/pinyin'
import { ProfilesSection } from './ProfilesSection'
import { HostsSection } from './HostsSection'
import { TeamSection } from './TeamSection'
import { WorkstationSection } from '../workstation/WorkstationSection'
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
import { ModelRoutingSection } from './ModelRoutingSection'

const PAGE_ICONS: Record<SettingsPageId, typeof Server> = {
  general: SlidersHorizontal,
  hosts: Server,
  profiles: Sparkles,
  routing: GitFork,
  'usage-budgets': BarChart3,
  permissions: ShieldCheck,
  secrets: KeyRound,
  agent: Bot,
  schedules: CalendarClock,
  memory: Brain,
  'team-shares': Users,
  appearance: Palette,
  notifications: Bell,
  voice: Mic,
  browser: MousePointerClick,
  extensions: Plug,
  evals: FlaskConical,
  gateway: Network,
  sync: RefreshCw,
}

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
  const setAboutOpen = useUiStore((s) => s.setAboutOpen)
  // 成员连接只保留客户端自己的设置页；Host 级设置由服务端 403 兜底。
  const memberTabs = new Set<SettingsTab>(['hosts', 'accounts', 'appearance', 'notifications'])
  const visiblePages = useMemo(
    () =>
      SETTINGS_PAGES.map((page) => ({
        ...page,
        tabs:
          role && role !== 'owner'
            ? page.tabs.filter((item) => memberTabs.has(item))
            : page.tabs,
      })).filter((page) => page.tabs.length > 0),
    [role],
  )
  const visiblePageIds = useMemo(
    () => new Set(visiblePages.map((page) => page.id)),
    [visiblePages],
  )
  const visibleGroups = useMemo(
    () =>
      SETTINGS_GROUPS.map((group) => ({
        ...group,
        pages: group.pages.filter((id) => visiblePageIds.has(id)),
      })).filter((group) => group.pages.length > 0),
    [visiblePageIds],
  )
  const currentPage = visiblePages.find((page) => page.tabs.includes(tab)) ?? visiblePages[0]
  const pageTabs = currentPage?.tabs ?? []
  const [closedGroups, setClosedGroups] = useState<Set<string>>(
    () => new Set(SETTINGS_GROUPS.filter((group) => group.collapsed).map((group) => group.id)),
  )
  const [query, setQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !currentPage) return
    if (!currentPage.tabs.includes(tab)) setTab(currentPage.tabs[0])
  }, [open, currentPage, tab, setTab])

  // 命令面板定位到折叠组里的页面时，自动展开所属分组。
  useEffect(() => {
    if (!open || !currentPage) return
    const group = SETTINGS_GROUPS.find((item) => item.pages.includes(currentPage.id))
    if (!group) return
    setClosedGroups((prev) => {
      if (!prev.has(group.id)) return prev
      const next = new Set(prev)
      next.delete(group.id)
      return next
    })
  }, [open, currentPage?.id])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setSearchIndex(0)
    }
  }, [open])

  const searchMatches = useMemo(() => {
    const q = query.trim()
    if (!q) return []
    const allowed = new Set(visiblePages.flatMap((page) => page.tabs))
    return SETTINGS_ITEMS.filter(
      (item) =>
        allowed.has(item.tab) &&
        (textMatches(item.title, q) || item.keywords.some((word) => textMatches(word, q))),
    )
  }, [query, visiblePages])

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

  const renderSettingsGroup = (group: { id: string; label: string; pages: SettingsPageId[] }) => {
    const expanded = !closedGroups.has(group.id)
    return (
      <div key={group.id} data-settings-group={group.id} className="col-span-3 sm:col-span-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() =>
            setClosedGroups((prev) => {
              const next = new Set(prev)
              if (next.has(group.id)) next.delete(group.id)
              else next.add(group.id)
              return next
            })
          }
          className="flex h-11 w-full items-center gap-1 rounded-md px-2 text-left text-[12px] font-medium text-text-tertiary transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text-soft sm:h-7"
        >
          <span className="min-w-0 flex-1 truncate">{group.label}</span>
          {group.id === 'advanced' && (
            <span className="shrink-0 text-[11px] font-normal text-muted">低频</span>
          )}
          <ChevronDown
            size={12}
            className={cn('shrink-0 transition-transform', !expanded && '-rotate-90')}
          />
        </button>
        {expanded && (
          <div className="mt-0.5 grid grid-cols-3 gap-1 sm:block sm:space-y-0.5">
            {group.pages.map((pageId) => {
              const page = SETTINGS_PAGE_MAP.get(pageId)
              if (!page) return null
              const Icon = PAGE_ICONS[page.id]
              const active = currentPage?.id === page.id
              return (
                <Button
                  key={page.id}
                  variant="ghost"
                  data-settings-page={page.id}
                  onClick={() => setTab(page.tabs[0])}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'min-h-11 w-full min-w-0 justify-start gap-2 px-2.5 text-left text-[13px] font-normal sm:h-7 sm:min-h-7',
                    active && 'bg-[var(--t-bg-active)] text-text',
                  )}
                  icon={<Icon size={14} />}
                >
                  <span className="min-w-0 flex-1 truncate">{page.label}</span>
                </Button>
              )
            })}
          </div>
        )}
      </div>
    )
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
            <div className="col-span-3 min-h-0 space-y-1 overflow-y-auto sm:col-span-1 sm:flex-1">
              {visibleGroups.filter((group) => group.id !== 'advanced').map(renderSettingsGroup)}
            </div>
          )}
          {!query.trim() && visibleGroups.some((group) => group.id === 'advanced') && (
            <div className="col-span-3 shrink-0 border-t border-border/60 pt-1 sm:col-span-1">
              {visibleGroups.filter((group) => group.id === 'advanced').map(renderSettingsGroup)}
            </div>
          )}
          {!query.trim() && (
            <div className="col-span-3 mt-auto pt-2 sm:col-span-1">
              <button
                type="button"
                onClick={() => {
                  close()
                  setAboutOpen(true)
                }}
                className="flex h-11 w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text-soft sm:h-auto"
              >
                <Info size={12} /> 关于 Tandem
              </button>
            </div>
          )}
        </nav>
        <div
          key={tab}
          ref={contentRef}
          data-settings-page-content={currentPage?.id}
          className="min-h-0 min-w-0 flex-1 animate-[tandem-fade-in_120ms_ease-out_both] overflow-y-auto overscroll-contain p-4 motion-reduce:animate-none sm:p-5 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11 max-sm:[&_input]:min-h-11 max-sm:[&_select]:min-h-11"
        >
          <div className="mx-auto w-full max-w-[1100px]">
            {currentPage && pageTabs.length > 1 && (
              <div
                data-settings-subtabs={currentPage.id}
                className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-3"
              >
                <SegmentedControl
                  size="sm"
                  aria-label={`${currentPage.label}子页`}
                  value={tab}
                  onChange={(value) => setTab(value as SettingsTab)}
                  options={pageTabs.map((item) => ({
                    value: item,
                    label: SETTINGS_TAB_LABELS[item],
                  }))}
                />
                <span className="text-[12px] text-muted">
                  同一组设置，只保留一个入口
                </span>
              </div>
            )}
            {tab === 'general' && <GeneralSettings />}
            {tab === 'voice' && <VoiceSection />}
            {tab === 'browser' && <BrowserSection />}
            {tab === 'profiles' && <ProfilesSection />}
            {tab === 'routing' && <ModelRoutingSection />}
            {tab === 'hosts' && <HostsSection />}
            {tab === 'team' && <TeamSection />}
            {tab === 'accounts' && <WorkstationSection />}
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
