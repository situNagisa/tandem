import { useEffect, useRef, useState } from 'react'
import type { BackgroundTask, RetryInfo } from '@tandem/protocol'
import {
  Bot,
  Columns2,
  FileDiff,
  FlaskConical,
  FolderTree,
  GitPullRequest,
  Globe2,
  Menu,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
  Pencil,
  Search,
  SquareTerminal,
  X,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useTurnNavStore } from '../store/useTurnNavStore'
import { useTaskStore } from '../store/useTaskStore'
import { useIsMobile, useNow } from '../lib/hooks'
import { useSessionChanges } from '../lib/useChanges'
import { formatElapsed, firstLine } from '../lib/format'
import { clearRunning, runningSince } from '../lib/runClock'
import { navigate, useRoute } from '../lib/router'
import { cn } from '../lib/cn'
import { clearSplitWorkspace } from '../lib/splitActions'
import { isDesktop, isMacDesktop, isWindowsDesktop } from '../lib/desktop'
import { HOST_NOT_ON_WORKSTATION } from '../lib/relay'
import { ConnectionDot } from './StatusDot'
import { Button, IconButton } from './ui/Button'
import { Menu as UiMenu } from './ui/Menu'
import { Input } from './ui/Controls'
import { useSubagentRows } from './chat/SessionHeaderTools'
import { PrPanel } from './PrPanel'
import { PanelGroupsMenu } from './right-panel/PanelMenu'

function StatePill({
  running,
  status,
  offline,
  connecting,
  elapsed,
  retryInfo,
  retrySeconds,
  resumePaused,
  onRetryNow,
  onStop,
  onResume,
}: {
  running: boolean
  status?: string
  offline: boolean
  connecting: boolean
  elapsed?: string
  retryInfo?: RetryInfo
  retrySeconds?: number
  resumePaused?: boolean
  onRetryNow?: () => void
  onStop?: () => void
  onResume?: () => void
}) {
  const pill = 'flex shrink-0 items-center gap-1.5 text-[12px] text-text-secondary'
  if (offline) return null
  if (connecting) {
    return (
      <span className={pill}>
        <span className="size-1.5 rounded-full bg-text-secondary/80 running-dot" />
        连接中
      </span>
    )
  }
  if (status === 'retrying' || retryInfo) {
    return (
      <span className={cn(pill, 'rounded-full border border-border bg-surface px-2 py-1')}>
        <span className="size-1.5 rounded-full bg-warning running-dot" />
        <span className="whitespace-nowrap">
          {retrySeconds && retrySeconds > 0
            ? `网络中断，${retrySeconds} 秒后重试`
            : '网络中断，正在重试…'}
        </span>
        <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[12px]" onClick={onRetryNow}>
          立即重试
        </Button>
        <span className="text-border-strong">·</span>
        <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[12px]" onClick={onStop}>
          停止
        </Button>
      </span>
    )
  }
  if (resumePaused) {
    return (
      <span className={cn(pill, 'rounded-full border border-border bg-surface px-2 py-1')}>
        <span className="size-1.5 rounded-full bg-text-tertiary" />
        <span className="whitespace-nowrap">重启后已暂停</span>
        <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[12px]" onClick={onResume}>
          继续运行
        </Button>
      </span>
    )
  }
  if (status === 'waiting_permission') {
    return (
      <span className={pill}>
        <span className="size-1.5 shrink-0 rounded-full bg-accent" />
        <span className="truncate whitespace-nowrap">
          待审批{elapsed ? ` · ${elapsed}` : ''}
        </span>
      </span>
    )
  }
  if (status === 'error') {
    return <span className={cn(pill, 'text-danger')}>出错</span>
  }
  if (running || status === 'running') {
    return (
      <span className={pill}>
        <span className="size-1.5 shrink-0 rounded-full bg-text-secondary running-dot" />
        <span className="truncate whitespace-nowrap">
          运行中{elapsed ? ` · ${elapsed}` : ''}
        </span>
      </span>
    )
  }
  return null
}

const EMPTY_BACKGROUND_TASKS: BackgroundTask[] = []

function taskStatusText(task: BackgroundTask, now: number): string {
  const label =
    task.status === 'running'
      ? '运行中'
      : task.status === 'exited'
        ? '已结束'
        : task.status === 'killed'
          ? '已终止'
          : '已丢失'
  return `${label} · ${formatElapsed((task.endedAt ?? now) - task.startedAt)}`
}

function MoreMenu() {
  const active = useAppStore((s) => s.active)
  const tasks = useTaskStore((s) =>
    active ? (s.byHost[active.hostId] ?? EMPTY_BACKGROUND_TASKS) : EMPTY_BACKGROUND_TASKS,
  )
  const taskCount = active
    ? tasks.filter((task) => task.sessionId === active.sessionId && task.status === 'running').length
    : 0
  const sessionTasks = active
    ? tasks
        .filter((task) => task.sessionId === active.sessionId)
        .sort(
          (a, b) =>
            Number(b.status === 'running') - Number(a.status === 'running') ||
            b.startedAt - a.startedAt,
        )
        .slice(0, 8)
    : []
  const rows = useSubagentRows()
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  useEffect(() => {
    if (host) void useTaskStore.getState().refresh(host)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, active?.sessionId])
  const focusAgent = useUiStore((s) => s.focusAgent)
  const openBackgroundTasks = useUiStore((s) => s.openBackgroundTasks)
  const openBrowserPanel = useUiStore((s) => s.openBrowserPanel)
  const openPreviewPanel = useUiStore((s) => s.openPreviewPanel)
  const openFileBrowser = useAppStore((s) => s.openFileBrowser)
  const openPrPanel = useUiStore((s) => s.openPrPanel)
  const openSettings = useUiStore((s) => s.openSettings)
  const splitPanes = useUiStore((s) => s.splitPanes)
  const layout = useUiStore((s) => s.splitLayout)
  const setSplitLayout = useUiStore((s) => s.setSplitLayout)
  const setSplitPickerOpen = useUiStore((s) => s.setSplitPickerOpen)
  const split = splitPanes.length >= 2

  return (
    <UiMenu
      side="bottom"
      align="end"
      aria-label="更多操作"
      className="w-[200px]"
      trigger={({ open }) => (
        <IconButton
          label="更多"
          tooltip="更多操作"
          data-tour-target="more"
          aria-expanded={open}
          className={cn('text-text! max-sm:size-11', open && 'bg-[var(--t-bg-active)]')}
        >
          <MoreHorizontal size={17} />
        </IconButton>
      )}
    >
      <UiMenu.Sub>
        <UiMenu.SubTrigger
          icon={<SquareTerminal size={14} />}
          trailing={taskCount > 0 ? taskCount : undefined}
          disabled={!active}
        >
          后台任务
        </UiMenu.SubTrigger>
        <UiMenu.SubContent aria-label="后台任务">
          {sessionTasks.length === 0 ? (
            <UiMenu.Item
              onSelect={() => {
                if (active) openBackgroundTasks(active.hostId, active.sessionId)
              }}
            >
              暂无后台任务
            </UiMenu.Item>
          ) : (
            sessionTasks.map((task) => (
              <UiMenu.Item
                key={task.id}
                title={task.command}
                trailing={taskStatusText(task, Date.now())}
                onSelect={() => {
                  if (active) openBackgroundTasks(active.hostId, active.sessionId, task.id)
                }}
              >
                {firstLine(task.command, 36) || task.id}
              </UiMenu.Item>
            ))
          )}
        </UiMenu.SubContent>
      </UiMenu.Sub>
      <UiMenu.Sub>
        <UiMenu.SubTrigger icon={<Bot size={14} />} trailing={rows.length > 0 ? rows.length : undefined}>
          子代理
        </UiMenu.SubTrigger>
        <UiMenu.SubContent aria-label="子代理">
          {rows.length === 0 ? (
            <UiMenu.Label>本会话还没有子代理</UiMenu.Label>
          ) : (
            rows.map((row) => (
              <UiMenu.Item
                key={row.id}
                className={row.depth > 1 ? 'pl-2' : undefined}
                trailing={
                  row.status === 'error'
                    ? '出错'
                    : row.status === 'waiting_permission'
                      ? '待审批'
                      : row.running
                        ? '运行中'
                        : '已结束'
                }
                onSelect={() => focusAgent(row.id)}
              >
                {row.title}
              </UiMenu.Item>
            ))
          )}
        </UiMenu.SubContent>
      </UiMenu.Sub>
      <UiMenu.Item
        icon={<PanelsTopLeft size={14} />}
        disabled={!active}
        onSelect={() => {
          if (active) openPreviewPanel(active.hostId, active.sessionId)
        }}
      >
        应用预览
      </UiMenu.Item>
      <UiMenu.Item
        icon={<Globe2 size={14} />}
        disabled={!active}
        onSelect={() => {
          if (active) openBrowserPanel(active.hostId, active.sessionId)
        }}
      >
        浏览器
      </UiMenu.Item>
      <UiMenu.Item icon={<FolderTree size={14} />} onSelect={() => openFileBrowser()}>
        文件
      </UiMenu.Item>
      <UiMenu.Item icon={<GitPullRequest size={14} />} onSelect={() => openPrPanel()}>
        PR 与 CI
      </UiMenu.Item>
      <UiMenu.Item icon={<FlaskConical size={14} />} onSelect={() => openSettings('evals')}>
        评测与轨迹
      </UiMenu.Item>
      <UiMenu.Separator />
      <UiMenu.Sub>
        <UiMenu.SubTrigger
          icon={<Columns2 size={14} />}
          trailing={split ? `${splitPanes.length} 窗格` : undefined}
        >
          分屏
        </UiMenu.SubTrigger>
        <UiMenu.SubContent aria-label="分屏">
          <UiMenu.Item onSelect={() => setSplitPickerOpen(true)}>分屏打开会话…</UiMenu.Item>
          {split && (
            <>
              <UiMenu.Separator />
              <UiMenu.Item
                selected={layout === 'cols2'}
                disabled={splitPanes.length > 2}
                onSelect={() => setSplitLayout('cols2')}
              >
                2 列
              </UiMenu.Item>
              <UiMenu.Item
                selected={layout === 'cols3'}
                disabled={splitPanes.length > 3}
                onSelect={() => setSplitLayout('cols3')}
              >
                3 列
              </UiMenu.Item>
              <UiMenu.Item
                selected={layout === 'grid2x2'}
                onSelect={() => setSplitLayout('grid2x2')}
              >
                2×2 网格
              </UiMenu.Item>
              <UiMenu.Separator />
              <UiMenu.Item icon={<X size={14} />} onSelect={clearSplitWorkspace}>
                合并为单窗格
              </UiMenu.Item>
            </>
          )}
        </UiMenu.SubContent>
      </UiMenu.Sub>
    </UiMenu>
  )
}

export function TopBar() {
  const isMobile = useIsMobile()
  const activeHostId = useAppStore((s) => s.activeHostId)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const runtime = useAppStore((s) => (activeHostId ? s.runtimes[activeHostId] : undefined))
  const hasSession = useAppStore((s) => !!s.active)
  const route = useRoute()
  const externalRoute = route.kind === 'external'
  const externalTitle = useAppStore((s) => {
    if (route.kind !== 'external') return null
    return (
      s.externalSessions[route.hostId]?.find(
        (x) => x.source === route.source && x.id === route.id,
      )?.title ??
      s.runtimes[route.hostId]?.externalSessions.find(
        (x) => x.source === route.source && x.id === route.id,
      )?.title ??
      null
    )
  })
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const status = summary?.status
  const retrying = status === 'retrying' || !!summary?.retryInfo
  const running = useAppStore((s) => s.active?.running ?? false)
  const ticking = running || status === 'waiting_permission' || status === 'retrying'
  const now = useNow(ticking)
  const retrySeconds = summary?.retryInfo
    ? Math.max(0, Math.ceil((summary.retryInfo.nextAt - now) / 1000))
    : undefined
  const retryNow = useAppStore((s) => s.retryNow)
  const interrupt = useAppStore((s) => s.interrupt)
  const resumePaused = useAppStore((s) => s.resumePaused)
  const runKey = summary ? `${activeHostId ?? ''}:${summary.id}` : null
  const elapsed =
    ticking && summary && runKey
      ? formatElapsed(now - runningSince(runKey, summary.updatedAt))
      : undefined

  useEffect(() => {
    if (runKey && !ticking) clearRunning(runKey)
  }, [runKey, ticking])
  const updateSession = useAppStore((s) => s.updateSession)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const changesNonce = useAppStore((s) => s.changesNonce)
  const { changes } = useSessionChanges(host, sessionId, changesNonce, !!sessionId)
  const fileCount = changes?.files.length ?? 0
  const additions = changes?.files.reduce((n, f) => n + f.additions, 0) ?? 0
  const deletions = changes?.files.reduce((n, f) => n + f.deletions, 0) ?? 0

  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const panelOpen = useUiStore((s) => s.panelOpen)
  const changesOpen = useUiStore((s) => s.changesOpen)
  const setChangesOpen = useUiStore((s) => s.setChangesOpen)
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed)
  const setMobileSidebar = useUiStore((s) => s.setMobileSidebar)
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const togglePanel = useUiStore((s) => s.togglePanel)
  const setMobilePanel = useUiStore((s) => s.setMobilePanel)
  const retryHost = useAppStore((s) => s.retryHost)
  const turnTotal = useTurnNavStore((s) => s.total)
  const turnActive = useTurnNavStore((s) => s.active)
  const setTurnSheetOpen = useTurnNavStore((s) => s.setSheetOpen)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const committingRef = useRef(false)
  const cancelEditRef = useRef(false)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  useEffect(() => {
    setEditing(false)
  }, [summary?.id])

  const offline = runtime?.status === 'offline'
  const connecting = runtime?.status === 'connecting'
  const hostUnreachable = offline && runtime?.error === HOST_NOT_ON_WORKSTATION
  const title = summary?.title || '未命名会话'

  const commit = async () => {
    if (committingRef.current) return
    committingRef.current = true
    const next = draft.trim()
    setEditing(false)
    if (!summary || !activeHostId || !next || next === summary.title) {
      committingRef.current = false
      return
    }
    try {
      await updateSession(activeHostId, summary.id, { title: next })
    } finally {
      committingRef.current = false
    }
  }

  return (
    <>
    <header
      className={cn(
        'relative z-20 flex shrink-0 items-center gap-1.5 bg-bg px-2 md:px-3',
        // Windows 自绘标题栏高 36px（titleBarOverlay.height），顶栏与之对齐。
        isWindowsDesktop ? 'h-9' : 'h-12',
        isDesktop && 'desktop-drag',
        isWindowsDesktop && 'pr-[140px]',
        isMacDesktop && sidebarCollapsed && 'pl-[72px]',
        // 手机：标题/状态占一行，轮次与工具图标落到第二行，避免 360px 下互相挤压。
        'max-md:h-auto max-md:min-h-12 max-md:flex-wrap max-md:pb-0.5',
      )}
      style={isWindowsDesktop ? { paddingRight: 140 } : undefined}
    >
      <IconButton
        onClick={() => {
          if (isMobile) setMobileSidebar(true)
          else setSidebarCollapsed(!sidebarCollapsed)
        }}
        label={isMobile ? '打开侧栏' : '切换侧栏'}
        tooltip={isMobile ? '打开侧栏' : '切换侧栏 (Ctrl+B)'}
        className="max-sm:size-11"
      >
        {isMobile ? <Menu size={18} /> : <PanelLeft size={17} />}
      </IconButton>

      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {hasSession ? (
          editing ? (
            <Input
              ref={inputRef}
              size="sm"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (cancelEditRef.current) {
                  cancelEditRef.current = false
                  return
                }
                void commit()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelEditRef.current = true
                  setEditing(false)
                }
              }}
              className="max-w-[320px] flex-1 border-border-strong font-medium md:w-[min(320px,40vw)] md:flex-none"
              aria-label="重命名会话"
            />
          ) : (
            <button data-raw-button
              onClick={() => {
                committingRef.current = false
                cancelEditRef.current = false
                setDraft(summary?.title ?? '')
                setEditing(true)
              }}
              data-tip="点击重命名"
              className="group flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-[var(--t-bg-hover)] max-md:min-h-11"
            >
              <h1 className="truncate text-[14px] font-medium leading-5" data-tip={title}>{title}</h1>
              {__TANDEM_DEBUG__ && summary?.demo && (
                <span
                  className="shrink-0 rounded bg-[#F97316]/12 px-1.5 py-0.5 text-[10px] font-medium text-[#F97316]"
                  data-tip="演示数据：不计入真实用量，可在设置 → 关于 → 演示工作区清除"
                >
                  演示数据
                </span>
              )}
              <Pencil
                size={11}
                className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
              />
            </button>
          )
        ) : route.kind === 'external' ? (
          <div className="flex min-w-0 items-center gap-1.5 px-1">
            <h1 className="truncate text-[14px] font-medium leading-5" data-tip={externalTitle || '外部会话'}>
              {externalTitle || '外部会话'}
            </h1>
            <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[12px] leading-4 text-muted">
              只读
            </span>
          </div>
        ) : (
          <h1 className="truncate px-1 text-[14px] font-medium leading-5">
            {host?.name || 'Tandem'}
          </h1>
        )}

        {hasSession && !(isMobile && retrying) ? (
          <StatePill
            running={running}
            status={status}
            offline={offline}
            connecting={connecting}
            elapsed={elapsed}
            retryInfo={summary?.retryInfo}
            retrySeconds={retrySeconds}
            resumePaused={summary?.resumePaused}
            onRetryNow={() => retryNow()}
            onStop={() => interrupt()}
            onResume={() => void resumePaused()}
          />
        ) : (
          !isMobile &&
          host && (
            <span className="hidden items-center gap-1.5 text-[12px] text-muted sm:flex">
              <ConnectionDot state={runtime?.status ?? 'connecting'} />
              {runtime?.status === 'online' ? '在线' : runtime?.status === 'connecting' ? '连接中…' : '离线'}
            </span>
          )
        )}
      </div>

      {isMobile && (
        <IconButton
          onClick={() => setSearchOpen(true)}
          label="搜索"
          tooltip="搜索会话、命令与设置"
          className="max-sm:size-11"
        >
          <Search size={17} />
        </IconButton>
      )}

      {hasSession && changes && !isMobile && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setChangesOpen(!changesOpen)}
          aria-label={
            fileCount > 0
              ? `改动+${additions}−${deletions}，打开改动审阅`
              : '改动，打开改动审阅'
          }
          tooltip="改动审阅"
          aria-pressed={changesOpen}
          className={cn(
            'gap-1 px-1.5 font-mono text-text! max-md:h-8',
            changesOpen && 'bg-[var(--t-bg-active)] text-text',
          )}
        >
          <FileDiff size={13.5} className="shrink-0 text-text!" />
          <span className="hidden font-sans text-[12px] sm:inline">改动</span>
          {fileCount > 0 && !changesOpen && (
            <>
              <span className="hidden text-[var(--t-git-plus)] sm:inline">+{additions}</span>
              <span className="hidden text-[var(--t-git-minus)] sm:inline">−{deletions}</span>
            </>
          )}
        </Button>
      )}

      {hasSession && !isMobile && <MoreMenu />}

      {hasSession && panelOpen && !isMobile && <PanelGroupsMenu />}

      {(hasSession || (!isMobile && externalRoute)) && (
        <IconButton
          onClick={() => {
            setChangesOpen(false)
            if (isMobile) setMobilePanel(true)
            else togglePanel()
          }}
          label="切换信息面板"
          tooltip="会话信息"
          aria-pressed={!isMobile && panelOpen}
          className={cn(
            'text-text! max-sm:size-11',
            !isMobile && panelOpen && 'bg-[var(--t-bg-active)] text-text',
          )}
        >
          <PanelRight size={17} />
        </IconButton>
      )}

      <PrPanel />

      {isMobile && hasSession && (
        <div className="flex w-full min-w-0 items-center gap-0.5 md:hidden">
          {turnTotal >= 2 && (
            <button data-raw-button
              type="button"
              onClick={() => setTurnSheetOpen(true)}
              aria-label="打开轮次大纲"
              className="flex h-11 shrink-0 items-center px-0.5"
            >
              <span className="rounded-full bg-[var(--t-bg-hover)] px-2 py-1 text-[12px] tabular-nums leading-4 text-text-soft transition-colors active:bg-[var(--t-bg-active)]">
                第 {turnActive}/{turnTotal} 轮
              </span>
            </button>
          )}
          <span className="min-w-0 flex-1" />
          <MoreMenu />
          {changes && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setChangesOpen(!changesOpen)}
              aria-label="改动审阅"
              tooltip="改动审阅"
              aria-pressed={changesOpen}
              className={cn(
                'size-11! justify-center gap-1 px-0 font-mono text-text! sm:size-8! sm:px-1.5',
                changesOpen && 'bg-[var(--t-bg-active)] text-text',
              )}
            >
              <FileDiff size={15} className="shrink-0 text-text!" />
              <span className="hidden text-[var(--t-git-plus)] sm:inline">+{additions}</span>
              <span className="hidden text-[var(--t-git-minus)] sm:inline">−{deletions}</span>
            </Button>
          )}
        </div>
      )}

      {offline && (
        <div className="pointer-events-none absolute inset-x-0 top-full z-20 flex h-6 items-center justify-center gap-1.5 border-b border-border/60 bg-bg/95 text-[12px] text-muted backdrop-blur-sm">
          <span className={cn('size-1.5 rounded-full bg-muted/60', !hostUnreachable && 'running-dot')} />
          <span>{hostUnreachable ? HOST_NOT_ON_WORKSTATION : '重新连接中…'}</span>
          <button data-raw-button
            onClick={() => activeHostId && retryHost(activeHostId)}
            className="pointer-events-auto ml-1 rounded px-1 text-[12px] text-text-soft underline-offset-2 transition-colors hover:text-text hover:underline"
          >
            立即重试
          </button>
        </div>
      )}
    </header>
    {isMobile && hasSession && retrying && (
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface px-3 py-1.5 text-[12px] text-text-secondary">
        <span className="size-1.5 shrink-0 rounded-full bg-warning running-dot" />
        <span className="min-w-0 flex-1 truncate">
          {retrySeconds && retrySeconds > 0
            ? `网络中断，${retrySeconds} 秒后重试`
            : '网络中断，正在重试…'}
        </span>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[12px]" onClick={() => retryNow()}>
          立即重试
        </Button>
        <span className="text-border-strong">·</span>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[12px]" onClick={() => interrupt()}>
          停止
        </Button>
      </div>
    )}
    </>
  )
}
