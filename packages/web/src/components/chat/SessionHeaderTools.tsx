import { useEffect, useMemo } from 'react'
import { Bot, FolderTree, Globe2, SquareTerminal } from 'lucide-react'
import type { SubagentSession } from '../../lib/types'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { useTaskStore } from '../../store/useTaskStore'
import { useBrowserStore } from '../../store/useBrowserStore'
import { cn } from '../../lib/cn'
import { IconButton } from '../ui/Button'
import { Popover } from '../ui/Popover'

const EMPTY_SUBS: Record<string, SubagentSession> = {}
const EMPTY_TASKS: import('@tandem/protocol').BackgroundTask[] = []

/** 顶栏「后台任务」：打开本会话后台任务面板，角标为运行中数量。 */
export function BackgroundTasksButton() {
  const active = useAppStore((s) => s.active)
  const hosts = useAppStore((s) => s.hosts)
  const role = useAppStore((s) =>
    s.active?.hostId ? s.runtimes[s.active.hostId]?.team?.role : undefined,
  )
  const tasks = useTaskStore((s) => (active ? s.byHost[active.hostId] ?? EMPTY_TASKS : EMPTY_TASKS))
  const openBackgroundTasks = useUiStore((s) => s.openBackgroundTasks)
  const host = hosts.find((h) => h.id === active?.hostId)
  const count = active
    ? tasks.filter((task) => task.sessionId === active.sessionId && task.status === 'running').length
    : 0

  useEffect(() => {
    if (host && role === 'owner') void useTaskStore.getState().refresh(host)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, active?.sessionId])

  if (role !== 'owner') return null
  return (
    <IconButton
      onClick={() => {
        if (active) openBackgroundTasks(active.hostId, active.sessionId)
      }}
      disabled={!active}
      label="后台任务"
      tooltip="后台任务"
      className="relative text-text! max-sm:size-11"
    >
      <SquareTerminal size={16} />
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex size-[14px] items-center justify-center rounded-full bg-accent-strong text-[9px] font-medium tabular-nums text-on-accent">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </IconButton>
  )
}

export interface SubagentRow {
  id: string
  title: string
  depth: number
  status?: string
  running: boolean
}

/** 复用右侧栏代理卡的数据，供顶栏「更多」菜单与子代理弹层共用。 */
export function useSubagentRows(): SubagentRow[] {
  const subagents = useAppStore((s) => s.active?.subagents) ?? EMPTY_SUBS
  const activeSessionId = useAppStore((s) => s.active?.sessionId ?? null)

  return useMemo(() => {
    if (!activeSessionId) return []
    const children = new Map<string, string[]>()
    for (const sub of Object.values(subagents)) {
      const summary = sub.summary
      if (!summary?.parentId) continue
      const list = children.get(summary.parentId) ?? []
      list.push(summary.id)
      children.set(summary.parentId, list)
    }
    const out: SubagentRow[] = []
    const seen = new Set<string>()
    const walk = (parentId: string, depth: number) => {
      for (const id of children.get(parentId) ?? []) {
        if (seen.has(id)) continue
        seen.add(id)
        const sub = subagents[id]
        const summary = sub?.summary
        if (!sub || !summary) continue
        const running =
          sub.running ||
          summary.status === 'running' ||
          summary.status === 'waiting_permission' ||
          summary.status === 'retrying'
        out.push({
          id,
          title: summary.title || '未命名子代理',
          depth,
          status: summary.status,
          running,
        })
        walk(id, depth + 1)
      }
    }
    walk(activeSessionId, 1)
    return out
  }, [subagents, activeSessionId])
}

/** 顶栏「子代理」：复用右侧栏代理卡的数据，点行定位消息流里的 Task 卡片。 */
export function SubagentsButton() {
  const openAgentSession = useUiStore((s) => s.openAgentSession)
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const rows = useSubagentRows()

  return (
    <Popover
      align="right"
      padded={false}
      trigger={({ open, toggle }) => (
        <IconButton
          onClick={toggle}
          label="子代理"
          tooltip={open ? '' : '子代理'}
          aria-expanded={open}
          className={cn('text-text! max-sm:size-11', open && 'bg-[var(--t-bg-active)]')}
        >
          <Bot size={16} />
        </IconButton>
      )}
    >
      {(close) => (
        <div className="w-[300px] max-w-[calc(100vw-1.5rem)]">
          <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
            <Bot size={11} />
            子代理
            {rows.length > 0 && <span className="ml-auto tabular-nums">{rows.length}</span>}
          </div>
          {rows.length === 0 ? (
            <p className="px-2 pb-2 pt-1 text-[12px] leading-5 text-muted">本会话还没有子代理</p>
          ) : (
            <div className="max-h-[360px] overflow-y-auto pb-1">
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => {
                    close()
                    if (hostId) openAgentSession(hostId, row.id)
                  }}
                  className="flex min-h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12.5px] transition-colors hover:bg-[var(--t-bg-hover)]"
                  style={{ paddingLeft: 8 + Math.min(Math.max(0, row.depth - 1), 6) * 12 }}
                  data-tip={row.title}
                >
                  {row.depth > 6 && (
                    <span className="shrink-0 text-[9.5px] tabular-nums text-muted">L{row.depth}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-text">{row.title}</span>
                  <span
                    className={cn(
                      'shrink-0 text-[12px]',
                      row.status === 'error'
                        ? 'text-danger'
                        : row.running
                          ? 'text-text-secondary'
                          : 'text-muted',
                    )}
                  >
                    {row.status === 'error'
                      ? '出错'
                      : row.status === 'waiting_permission'
                        ? '待审批'
                        : row.status === 'retrying'
                          ? '等待网络'
                          : row.running
                            ? '运行中'
                            : '已结束'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Popover>
  )
}

/** 顶栏「浏览器」：查看当前会话在主机上打开的页面与最新截图。 */
export function BrowserButton() {
  const active = useAppStore((s) => s.active)
  const browserState = useBrowserStore((s) =>
    active ? s.states[active.sessionId] : undefined,
  )
  const openBrowserPanel = useUiStore((s) => s.openBrowserPanel)
  return (
    <IconButton
      onClick={() => {
        if (active) openBrowserPanel(active.hostId, active.sessionId)
      }}
      disabled={!active}
      label="浏览器"
      tooltip="浏览器"
      className="relative text-text! max-sm:size-11"
    >
      <Globe2 size={16} />
      {browserState?.active ? (
        <span className="absolute right-1 top-1 size-1.5 rounded-full bg-success" />
      ) : null}
    </IconButton>
  )
}

/**
 * 顶栏「文件」：调用文件浏览器的打开方法（预览面板左侧文件树）。
 * 具体实现由文件预览面板提供，这里只做入口。
 */
export function FilesButton() {
  const openFileBrowser = useAppStore((s) => s.openFileBrowser)
  return (
    <IconButton
      onClick={() => openFileBrowser()}
      label="文件"
      tooltip="文件"
      className="text-text! max-sm:size-11"
    >
      <FolderTree size={16} />
    </IconButton>
  )
}
