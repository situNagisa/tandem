import { useMemo } from 'react'
import { Inbox, PanelLeftClose, Plus, Search, Send, Settings, SlidersHorizontal, X } from 'lucide-react'
import { useUiStore } from '../store/useUiStore'
import { useAppStore } from '../store/useAppStore'
import { basename, modLabel } from '../lib/format'
import { navigate, parseHash } from '../lib/router'
import { cn } from '../lib/cn'
import { isSessionFilterActive, type SessionFilter } from '../lib/types'
import { isDesktop, isMacDesktop } from '../lib/desktop'
import { HostSwitcher } from './HostSwitcher'
import { Button, IconButton } from './ui/Button'
import { Menu } from './ui/Menu'
import { SessionList, sessionProjectName } from './SessionList'
import { useInboxCount } from './inbox/InboxView'

const EXTERNAL_SOURCES = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
] as const

export function Sidebar({
  inDrawer = false,
  onNavigate,
}: {
  inDrawer?: boolean
  onNavigate?: () => void
}) {
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed)
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)
  const openSettings = useUiStore((s) => s.openSettings)
  const showArchived = useUiStore((s) => s.showArchived)
  const setShowArchived = useUiStore((s) => s.setShowArchived)
  const showExternalSessions = useUiStore((s) => s.showExternalSessions)
  const setShowExternalSessions = useUiStore((s) => s.setShowExternalSessions)
  const hiddenExternalSources = useUiStore((s) => s.hiddenExternalSources)
  const setExternalSourceVisible = useUiStore((s) => s.setExternalSourceVisible)
  const resetComposer = useUiStore((s) => s.resetComposer)
  const setInboxOpen = useUiStore((s) => s.setInboxOpen)
  const setDispatchOpen = useUiStore((s) => s.setDispatchOpen)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  const sessionFilter = useUiStore((s) => s.sessionFilter)
  const setSessionFilter = useUiStore((s) => s.setSessionFilter)
  const clearSessionFilter = useUiStore((s) => s.clearSessionFilter)
  const filterActive = isSessionFilterActive(sessionFilter)
  const teamRole = useAppStore((s) =>
    s.activeHostId ? s.runtimes[s.activeHostId]?.team?.role : undefined,
  )
  const readOnly = teamRole === 'observer' || teamRole === 'approver'
  const inboxCount = useInboxCount()
  const archivedCount = useAppStore((s) =>
    Object.values(s.runtimes).reduce(
      (n, rt) => n + rt.sessions.filter((x) => x.archived && !x.parentId).length,
      0,
    ),
  )

  const row = 'group w-full min-h-11 justify-start gap-2 px-2.5 md:min-h-8'
  const projectOptions = useMemo(() => {
    const names = new Set<string>()
    for (const host of hosts) {
      const rt = runtimes[host.id]
      for (const session of rt?.sessions ?? []) {
        if (!session.parentId) names.add(sessionProjectName(session))
      }
      for (const external of rt?.externalSessions ?? []) {
        if (!external.importedSessionId) names.add(basename(external.cwd) || '未命名项目')
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [hosts, runtimes])
  const hostLabel =
    sessionFilter.hostId === 'all'
      ? '全部'
      : (hosts.find((host) => host.id === sessionFilter.hostId)?.name ?? '全部')
  const sourceLabel =
    sessionFilter.source === 'all'
      ? '全部'
      : sessionFilter.source === 'tandem'
        ? 'Tandem'
        : sessionFilter.source === 'claude-code'
          ? 'Claude Code'
          : 'Codex'

  const startNewSession = () => {
    // 已经在新会话页时导航不会重新挂载，需要显式清空输入并聚焦。
    if (parseHash().kind === 'home') resetComposer()
    setShowArchived(false)
    navigate({ kind: 'home' })
    onNavigate?.()
  }

  const filter = (
    <Menu
      side="right"
      align="start"
      aria-label="筛选会话"
      className="w-[210px]"
      trigger={({ open }) => (
        <IconButton
          size="sm"
          label="筛选会话"
          tooltip={open ? '' : '筛选'}
          tooltipSide="bottom"
          aria-expanded={open}
          aria-haspopup="menu"
          className={cn(
            'max-sm:size-11',
            open && 'bg-[var(--t-bg-active)] text-text',
            filterActive && 'text-accent-text',
          )}
        >
          <SlidersHorizontal size={14} />
        </IconButton>
      )}
    >
      <Menu.Label>状态</Menu.Label>
      <Menu.RadioGroup
        value={sessionFilter.status}
        onValueChange={(value) =>
          setSessionFilter({ status: value as SessionFilter['status'] })
        }
      >
        <Menu.RadioItem value="all" keepOpen>
          全部状态
        </Menu.RadioItem>
        <Menu.RadioItem value="running" keepOpen>
          运行中
        </Menu.RadioItem>
        <Menu.RadioItem value="waiting_permission" keepOpen>
          待审批
        </Menu.RadioItem>
        <Menu.RadioItem value="error" keepOpen>
          出错
        </Menu.RadioItem>
        <Menu.RadioItem value="unread" keepOpen>
          已完成未读
        </Menu.RadioItem>
      </Menu.RadioGroup>
      <Menu.Separator />
      <Menu.Sub>
        <Menu.SubTrigger trailing={hostLabel}>主机</Menu.SubTrigger>
        <Menu.SubContent aria-label="按主机筛选">
          <Menu.RadioGroup
            value={sessionFilter.hostId}
            onValueChange={(value) => setSessionFilter({ hostId: value })}
          >
            <Menu.RadioItem value="all" keepOpen>
              全部主机
            </Menu.RadioItem>
            {hosts.map((host) => (
              <Menu.RadioItem key={host.id} value={host.id} keepOpen>
                {host.name}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.SubContent>
      </Menu.Sub>
      <Menu.Sub>
        <Menu.SubTrigger
          trailing={sessionFilter.project === 'all' ? '全部' : sessionFilter.project}
        >
          项目
        </Menu.SubTrigger>
        <Menu.SubContent aria-label="按项目筛选">
          <Menu.RadioGroup
            value={sessionFilter.project}
            onValueChange={(value) => setSessionFilter({ project: value })}
          >
            <Menu.RadioItem value="all" keepOpen>
              全部项目
            </Menu.RadioItem>
            {projectOptions.map((name) => (
              <Menu.RadioItem key={name} value={name} keepOpen>
                {name}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.SubContent>
      </Menu.Sub>
      <Menu.Sub>
        <Menu.SubTrigger trailing={sourceLabel}>来源</Menu.SubTrigger>
        <Menu.SubContent aria-label="按来源筛选">
          <Menu.RadioGroup
            value={sessionFilter.source}
            onValueChange={(value) =>
              setSessionFilter({ source: value as SessionFilter['source'] })
            }
          >
            <Menu.RadioItem value="all" keepOpen>
              全部来源
            </Menu.RadioItem>
            <Menu.RadioItem value="tandem" keepOpen>
              Tandem
            </Menu.RadioItem>
            <Menu.RadioItem value="claude-code" keepOpen>
              Claude Code
            </Menu.RadioItem>
            <Menu.RadioItem value="codex" keepOpen>
              Codex
            </Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.SubContent>
      </Menu.Sub>
      {filterActive && (
        <>
          <Menu.Separator />
          <Menu.Item onSelect={clearSessionFilter}>清除筛选</Menu.Item>
        </>
      )}
      <Menu.Separator />
      <Menu.Label>显示</Menu.Label>
      {EXTERNAL_SOURCES.map((source) => {
        const visible = showExternalSessions && !hiddenExternalSources.includes(source.value)
        return (
          <Menu.CheckItem
            key={source.value}
            checked={visible}
            onCheckedChange={() => {
              if (!showExternalSessions) {
                setShowExternalSessions(true)
                return
              }
              setExternalSourceVisible(source.value, !visible)
            }}
          >
            {source.label}
          </Menu.CheckItem>
        )
      })}
      <Menu.CheckItem
        checked={showArchived}
        onCheckedChange={() => setShowArchived(!showArchived)}
        trailing={archivedCount > 0 ? archivedCount : undefined}
      >
        已归档会话
      </Menu.CheckItem>
    </Menu>
  )

  return (
    <div className="flex h-full w-full shrink-0 flex-col overflow-x-hidden border-r border-border bg-sidebar dark:[--t-text-secondary:#cfcfcf] dark:[--t-text-tertiary:#9a9a9a]">
      <div
        className={cn('flex items-center gap-2 px-3.5 pb-2 pt-3.5', isDesktop && 'desktop-drag')}
        style={isMacDesktop ? { paddingLeft: 72 } : undefined}
      >
        <span className="font-serif text-[17px] font-medium leading-none tracking-tight">Tandem</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            setInboxOpen(true)
            onNavigate?.()
          }}
          aria-label={inboxCount > 0 ? `收件箱，${inboxCount} 条待处理` : '收件箱'}
          title={inboxCount > 0 ? `收件箱（${inboxCount} 条待处理）` : '收件箱'}
          className={cn(
            'relative inline-flex size-8 items-center justify-center rounded-md text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text max-sm:size-11',
            inboxCount > 0 && 'text-text',
          )}
        >
          <Inbox size={16} />
          {inboxCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-strong px-1 text-[11px] font-semibold leading-none text-on-accent">
              {inboxCount > 99 ? '99+' : inboxCount}
            </span>
          )}
        </button>
        {inDrawer ? (
          <IconButton
            onClick={() => setMobileSidebar(false)}
            label="关闭侧栏"
            tooltipSide="bottom"
            className="max-sm:size-11"
          >
            <X size={16} />
          </IconButton>
        ) : (
          <IconButton
            onClick={() => setSidebarCollapsed(true)}
            label="收起侧栏"
            tooltip={`收起侧栏 (${modLabel} B)`}
            className="hidden md:inline-flex"
          >
            <PanelLeftClose size={15} />
          </IconButton>
        )}
      </div>

      <div className="px-2 pb-1">
        {!readOnly && (
        <Button variant="ghost" onClick={startNewSession} className={row}>
          <Plus size={15} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">新会话</span>
          <kbd className="hidden shrink-0 text-[10px] font-normal text-muted md:inline">
            {modLabel} N
          </kbd>
        </Button>
        )}
        {!readOnly && (
        <Button
          variant="ghost"
          onClick={() => {
            setDispatchOpen(true, activeHostId ?? undefined)
            onNavigate?.()
          }}
          className={row}
          tooltip="向任意在线 Host 派单"
          tooltipSide="bottom"
        >
          <Send size={15} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">派单</span>
        </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            setSearchOpen(true)
            onNavigate?.()
          }}
          className={row}
          tooltip={`搜索全部 Host 的会话 (${modLabel} K)`}
          tooltipSide="bottom"
        >
          <Search size={15} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">搜索</span>
          <kbd className="hidden shrink-0 text-[10px] font-normal text-muted md:inline">
            {modLabel} K
          </kbd>
        </Button>
      </div>

      <SessionList
        query=""
        onNavigate={onNavigate}
        headerActions={
          <>
            <HostSwitcher onNavigate={onNavigate} />
            {filter}
          </>
        }
      />

      <div className="border-t border-border px-2 py-1.5">
        <Button
          variant="ghost"
          onClick={() => {
            openSettings()
            onNavigate?.()
          }}
          className={cn(row, 'text-[12.5px] text-text-tertiary')}
        >
          <Settings size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">设置</span>
        </Button>
      </div>
    </div>
  )
}
