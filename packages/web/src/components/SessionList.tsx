import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  FolderGit2,
  GitBranch,
  GitMerge,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type { SessionSummary } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { api, ApiError } from '../lib/api'
import { useUiStore } from '../store/useUiStore'
import { useNow } from '../lib/hooks'
import { clearRunning, runningSince } from '../lib/runClock'
import { basename, formatElapsed, formatRelative } from '../lib/format'
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { ConnectionDot, SessionStatusDot } from './StatusDot'
import { Modal } from './ui/Modal'

const EMPTY: SessionSummary[] = []

interface ProjectGroup {
  key: string
  name: string
  branch?: string
  items: SessionSummary[]
  children: Record<string, SessionSummary[]>
}

interface HostGroup {
  id: string
  name: string
  online: boolean
  projects: ProjectGroup[]
  count: number
}

interface MenuState {
  hostId: string
  session: SessionSummary
  x: number
  y: number
}

/** 服务端把 worktree 放在 ~/.tandem/worktrees/<repo>/<branch>，从中还原项目名以便与主仓库归组。 */
function worktreeRepoName(s: SessionSummary): string | undefined {
  const p = s.worktree?.path
  if (!p) return undefined
  const m = p.replace(/\\/g, '/').match(/\/worktrees\/([^/]+)\//)
  return m?.[1]
}

function projectName(s: SessionSummary): string {
  return worktreeRepoName(s) || s.env?.repoName || basename(s.cwd) || '未命名项目'
}

function isRunningStatus(status: SessionSummary['status']): boolean {
  return status === 'running' || status === 'waiting_permission'
}

function buildGroups(
  hosts: Array<{ id: string; name: string }>,
  runtimes: ReturnType<typeof useAppStore.getState>['runtimes'],
  query: string,
  showArchived: boolean,
  showSubagents: boolean,
): { pinned: Array<{ hostId: string; session: SessionSummary }>; hosts: HostGroup[] } {
  const q = query.trim().toLowerCase()
  const pinned: Array<{ hostId: string; session: SessionSummary }> = []
  const groups: HostGroup[] = []

  for (const h of hosts) {
    const rt = runtimes[h.id]
    const all = rt?.sessions ?? EMPTY
    const matched = all.filter((s) => {
      if (showArchived) {
        if (!s.archived) return false
      } else if (s.archived) {
        return false
      }
      if (!q) return true
      return (
        s.title.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.model.toLowerCase().includes(q) ||
        (s.env?.repoName ?? '').toLowerCase().includes(q) ||
        (s.env?.branch ?? '').toLowerCase().includes(q) ||
        h.name.toLowerCase().includes(q)
      )
    })

    const tops = matched.filter((s) => !s.parentId)
    const children = matched.filter((s) => s.parentId)
    const topIds = new Set(tops.map((s) => s.id))
    const regular: SessionSummary[] = []
    for (const s of tops) {
      if (s.pinned && !showArchived) pinned.push({ hostId: h.id, session: s })
      else regular.push(s)
    }
    if (regular.length === 0) continue

    const map = new Map<string, ProjectGroup>()
    for (const s of regular) {
      const name = projectName(s)
      const key = `${h.id}:${name}`
      let group = map.get(key)
      if (!group) {
        group = {
          key,
          name,
          branch: s.worktree ? undefined : s.env?.branch,
          items: [],
          children: {},
        }
        map.set(key, group)
      }
      if (!group.branch && s.env?.branch && !s.worktree) group.branch = s.env.branch
      group.items.push(s)
    }
    if (showSubagents) {
      for (const child of children) {
        if (!child.parentId || !topIds.has(child.parentId)) continue
        const parent = tops.find((s) => s.id === child.parentId)
        if (!parent) continue
        const group = map.get(`${h.id}:${projectName(parent)}`)
        if (!group) continue
        const list = group.children[child.parentId] ?? []
        list.push(child)
        group.children[child.parentId] = list
      }
    }
    const projects = [...map.values()]
      .map((g) => ({ ...g, items: g.items.slice().sort((a, b) => b.updatedAt - a.updatedAt) }))
      .sort((a, b) => (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0))
    groups.push({
      id: h.id,
      name: h.name,
      online: rt?.status === 'online',
      projects,
      count: regular.length + Object.values(projects).reduce((n, p) => n + Object.values(p.children).reduce((m, l) => m + l.length, 0), 0),
    })
  }

  pinned.sort((a, b) => b.session.updatedAt - a.session.updatedAt)
  return { pinned, hosts: groups }
}

function RowMenu({
  state,
  onClose,
  onRename,
  onTogglePin,
  onFork,
  onArchive,
  onDelete,
  onMerge,
}: {
  state: MenuState
  onClose: () => void
  onRename: () => void
  onTogglePin: () => void
  onFork: () => void
  onArchive: () => void
  onDelete: () => void
  onMerge: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: state.x, top: state.y })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.min(state.x, window.innerWidth - rect.width - 8)
    const top = Math.min(state.y, window.innerHeight - rect.height - 8)
    setPos({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [state.x, state.y])

  useEffect(() => {
    const close = (ev: Event) => {
      if (ev.target instanceof Node && ref.current?.contains(ev.target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    const onScroll = () => onClose()
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [onClose])

  const item =
    'flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text'

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="anim-pop fixed z-[70] w-[184px] origin-top-left rounded-xl border border-border bg-surface p-1 shadow-[var(--t-shadow-md)]"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      <button className={item} onClick={() => { onClose(); onRename() }}>
        <Pencil size={14} className="text-muted" /> 重命名
      </button>
      <button className={item} onClick={() => { onClose(); onTogglePin() }}>
        {state.session.pinned ? (
          <PinOff size={14} className="text-muted" />
        ) : (
          <Pin size={14} className="text-muted" />
        )}
        {state.session.pinned ? '取消置顶' : '置顶'}
      </button>
      <button className={item} onClick={() => { onClose(); onFork() }}>
        <Copy size={14} className="text-muted" /> 复制会话
      </button>
      {state.session.worktree && (
        <button className={item} onClick={() => { onClose(); onMerge() }}>
          <GitMerge size={14} className="text-muted" /> 合并回 {state.session.worktree.baseBranch}
        </button>
      )}
      <button className={item} onClick={() => { onClose(); onArchive() }}>
        {state.session.archived ? (
          <ArchiveRestore size={14} className="text-muted" />
        ) : (
          <Archive size={14} className="text-muted" />
        )}
        {state.session.archived ? '取消归档' : '归档'}
      </button>
      <div className="my-1 h-px bg-[var(--t-border)]" />
      <button
        className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-danger transition-colors hover:bg-danger-soft"
        onClick={() => { onClose(); onDelete() }}
      >
        <Trash2 size={14} /> 删除
      </button>
    </div>,
    document.body,
  )
}

export function SessionList({
  query,
  onNavigate,
}: {
  query: string
  onNavigate?: () => void
}) {
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  const activeSessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const loading = useAppStore(
    (s) => (activeHostId ? (s.runtimes[activeHostId]?.sessionsLoading ?? false) : false),
  )
  const updateSession = useAppStore((s) => s.updateSession)
  const forkSession = useAppStore((s) => s.forkSession)
  const deleteSession = useAppStore((s) => s.deleteSession)
  const collapsed = useUiStore((s) => s.collapsedProjects)
  const toggleProject = useUiStore((s) => s.toggleProject)
  const showArchived = useUiStore((s) => s.showArchived)
  const setShowArchived = useUiStore((s) => s.setShowArchived)
  const showSubagents = useUiStore((s) => s.showSubagents)
  const setShowSubagents = useUiStore((s) => s.setShowSubagents)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirm, setConfirm] = useState<{
    hostId: string
    session: SessionSummary
    busy: boolean
    dirty?: boolean
  } | null>(null)
  const [merge, setMerge] = useState<{
    hostId: string
    session: SessionSummary
    strategy: 'merge' | 'squash'
    busy: boolean
    error?: string
  } | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const renameDoneRef = useRef(false)
  const renameCancelRef = useRef(false)
  const navRef = useRef<HTMLElement>(null)

  const onNavKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const target = e.target as HTMLElement | null
    if (!target) return
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return
    const rows = Array.from(
      navRef.current?.querySelectorAll<HTMLElement>('[data-session-row]') ?? [],
    )
    if (rows.length === 0) return
    let index = target.closest<HTMLElement>('[data-session-row]')
      ? rows.indexOf(target.closest<HTMLElement>('[data-session-row]')!)
      : rows.findIndex((row) => row.getAttribute('aria-current') === 'page')
    if (index < 0) index = e.key === 'ArrowDown' ? -1 : rows.length
    const next = rows[
      e.key === 'ArrowDown'
        ? Math.min(rows.length - 1, index + 1)
        : Math.max(0, index - 1)
    ]
    if (!next || next === rows[index]) return
    e.preventDefault()
    next.focus()
    next.click()
  }

  const { pinned, hosts: groups } = useMemo(
    () => buildGroups(hosts, runtimes, query, showArchived, showSubagents),
    [hosts, runtimes, query, showArchived, showSubagents],
  )

  const anyRunning = useMemo(
    () =>
      pinned.some(({ session }) => isRunningStatus(session.status)) ||
      groups.some((g) =>
        g.projects.some((p) => p.items.some((s) => isRunningStatus(s.status))),
      ),
    [pinned, groups],
  )
  const now = useNow(anyRunning)

  const runningElapsed = (hostId: string, s: SessionSummary): string | null => {
    const key = `${hostId}:${s.id}`
    if (!isRunningStatus(s.status)) {
      clearRunning(key)
      return null
    }
    return formatElapsed(now - runningSince(key, s.updatedAt))
  }

  // 导入来源：服务端摘要不带来源字段，从外部会话扫描结果反查。
  const importedSources = useMemo(() => {
    const map = new Map<string, { mark: string; label: string }>()
    for (const h of hosts) {
      for (const ext of runtimes[h.id]?.externalSessions ?? []) {
        if (!ext.importedSessionId) continue
        map.set(`${h.id}:${ext.importedSessionId}`, {
          mark: ext.source === 'codex' ? 'Codex' : 'CC',
          label: ext.source === 'codex' ? 'Codex' : 'Claude Code',
        })
      }
    }
    return map
  }, [hosts, runtimes])

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus()
      renameRef.current?.select()
    }
  }, [renaming])

  const total = groups.reduce((n, g) => n + g.count, 0) + (showArchived ? 0 : pinned.length)
  const hasSubagents = useMemo(
    () => Object.values(runtimes).some((rt) => rt.sessions.some((s) => s.parentId)),
    [runtimes],
  )
  const noHosts = hosts.length === 0

  const startRename = (s: SessionSummary) => {
    renameDoneRef.current = false
    renameCancelRef.current = false
    setRenaming(s.id)
    setRenameDraft(s.title || '')
  }

  const commitRename = async (hostId: string, s: SessionSummary) => {
    if (renameDoneRef.current) return
    renameDoneRef.current = true
    const title = renameDraft.trim()
    setRenaming(null)
    if (!title || title === s.title) return
    await updateSession(hostId, s.id, { title })
  }

  const openSession = (hostId: string, sessionId: string) => {
    navigate({ kind: 'session', hostId, sessionId })
    onNavigate?.()
  }

  const openMenu = (e: React.MouseEvent, hostId: string, session: SessionSummary) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ hostId, session, x: e.clientX, y: e.clientY })
  }

  const menuActions = menu
    ? {
        onRename: () => startRename(menu.session),
        onTogglePin: () =>
          void updateSession(menu.hostId, menu.session.id, { pinned: !menu.session.pinned }),
        onFork: () => void forkSession(menu.hostId, menu.session.id),
        onArchive: () =>
          void updateSession(menu.hostId, menu.session.id, { archived: !menu.session.archived }),
        onDelete: () => setConfirm({ hostId: menu.hostId, session: menu.session, busy: false }),
        onMerge: () =>
          setMerge({
            hostId: menu.hostId,
            session: menu.session,
            strategy: 'merge',
            busy: false,
          }),
      }
    : null

  const renderRow = (hostId: string, s: SessionSummary, depth = 0) => {
    const isActive = s.id === activeSessionId
    const renamingThis = renaming === s.id
    const importedFrom = importedSources.get(`${hostId}:${s.id}`)
    const elapsed = runningElapsed(hostId, s)
    const runningLabel = s.status === 'waiting_permission' ? '待审批' : '运行中'
    return (
      <div
        key={`${hostId}:${s.id}`}
        role="button"
        tabIndex={0}
        data-session-row="true"
        data-session-id={s.id}
        data-host-id={hostId}
        onClick={() => {
          if (!renamingThis) openSession(hostId, s.id)
        }}
        onKeyDown={(e) => {
          if (renamingThis) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openSession(hostId, s.id)
          }
        }}
        onContextMenu={(e) => openMenu(e, hostId, s)}
        aria-current={isActive ? 'page' : undefined}
        title={s.title || '未命名会话'}
        className={cn(
          'anim-row-in group relative flex min-h-11 cursor-default items-center gap-2 rounded-lg pr-8 text-[13px] outline-none transition-colors duration-[120ms] md:min-h-8',
          depth > 0 ? 'pl-6' : 'pl-2',
          isActive
            ? 'bg-[var(--t-bg-active)] text-text'
            : 'text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text',
        )}
      >
        <span className="flex w-3 shrink-0 justify-center">
          <SessionStatusDot status={s.status} />
        </span>
        {renamingThis ? (
          <input
            ref={renameRef}
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => {
              if (renameCancelRef.current) {
                renameCancelRef.current = false
                return
              }
              void commitRename(hostId, s)
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                void commitRename(hostId, s)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                renameCancelRef.current = true
                setRenaming(null)
              }
            }}
            className="h-7 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-1.5 text-[13px] outline-none"
            aria-label="重命名会话"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate leading-5">
            {s.title || '未命名会话'}
          </span>
        )}
        {!renamingThis && s.worktree && (
          <span
            title={`worktree 分支 ${s.worktree.branch}（基于 ${s.worktree.baseBranch}）`}
            className="flex max-w-[82px] shrink-0 items-center gap-0.5 text-[9.5px] text-muted"
          >
            <GitBranch size={9} className="shrink-0" />
            <span className="truncate font-mono">{s.worktree.branch}</span>
          </span>
        )}
        {!renamingThis && (
          <>
            <span
              className="session-row-tail flex min-w-0 items-center justify-end gap-1"
              style={elapsed ? { width: 72 } : undefined}
            >
              {importedFrom && (
                <span
                  title={`从 ${importedFrom.label} 导入`}
                  className="shrink-0 text-[9.5px] leading-none text-muted"
                >
                  {importedFrom.mark}
                </span>
              )}
              {elapsed ? (
                <span
                  className={cn(
                    'shrink-0 text-[9.5px] tabular-nums',
                    s.status === 'waiting_permission' ? 'text-accent' : 'text-text-soft',
                  )}
                  title={`${runningLabel} · ${elapsed}`}
                >
                  {runningLabel} · {elapsed}
                </span>
              ) : (
                <span
                  className={cn(
                    'hidden shrink-0 text-[10.5px] tabular-nums text-muted transition-opacity group-hover:opacity-0 md:inline',
                    isActive && 'text-text-soft',
                  )}
                >
                  {formatRelative(s.updatedAt)}
                </span>
              )}
            </span>
            <button
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const rect = e.currentTarget.getBoundingClientRect()
                setMenu({ hostId, session: s, x: rect.right - 4, y: rect.bottom + 4 })
              }}
              aria-label="会话操作"
              title="更多操作"
              className="absolute right-0.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted opacity-100 transition-opacity hover:bg-[var(--t-bg-hover)] hover:text-text focus-visible:opacity-100 md:size-6 md:opacity-0 md:group-hover:opacity-100"
            >
              <MoreHorizontal size={15} />
            </button>
          </>
        )}
      </div>
    )
  }

  if (loading && total === 0) {
    return (
      <div className="flex-1 space-y-2 overflow-hidden px-3 pt-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2.5 px-1 py-1.5">
            <div className="skeleton size-2 rounded-full" />
            <div className="skeleton h-3 flex-1" />
            <div className="skeleton h-2.5 w-8" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <nav
      ref={navRef}
      onKeyDown={onNavKeyDown}
      className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      aria-label="会话列表"
    >
      <div className="flex items-center gap-1 px-2 pb-1 pt-3">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted">
          {showArchived ? '已归档' : query ? '搜索结果' : '会话'}
        </span>
        {!showArchived && hasSubagents && (
          <button
            onClick={() => setShowSubagents(!showSubagents)}
            aria-pressed={showSubagents}
            title={showSubagents ? '隐藏子代理会话' : '在主会话下显示子代理会话'}
            className={cn(
              'ml-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors',
              showSubagents
                ? 'bg-[var(--t-bg-active)] text-text-soft'
                : 'text-muted hover:bg-[var(--t-bg-hover)] hover:text-text-soft',
            )}
          >
            <GitBranch size={10} /> 子代理
          </button>
        )}
        {showArchived && (
          <button
            onClick={() => setShowArchived(false)}
            className="ml-auto rounded-md px-1.5 py-0.5 text-[10.5px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
          >
            返回全部
          </button>
        )}
      </div>

      {total === 0 && (
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--t-bg-hover)] text-muted">
            <MessageSquarePlus size={18} />
          </div>
          <p className="text-[12.5px] leading-5 text-muted">
            {query
              ? '没有匹配的会话'
              : showArchived
                ? '没有已归档的会话'
                : noHosts
                  ? '还没有连接 Host，连接后会话会出现在这里。'
                  : '还没有会话，开始第一次对话吧。'}
          </p>
          {!query && !showArchived && (
            <button
              onClick={() => {
                navigate({ kind: 'home' })
                onNavigate?.()
              }}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-[12.5px] font-medium text-text-soft transition-colors hover:bg-[var(--t-bg-hover)]"
            >
              {noHosts ? '连接 Host' : '新建会话'}
            </button>
          )}
        </div>
      )}

      {!showArchived && pinned.length > 0 && (
        <div className="mb-1">
          <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[10.5px] font-medium text-muted">
            <Pin size={11} />
            置顶
          </div>
          <div className="space-y-0.5">{pinned.map(({ hostId, session }) => renderRow(hostId, session))}</div>
        </div>
      )}

      {groups.map((host) => {
        const hostKey = `host:${host.id}`
        const hostCollapsed = !!collapsed[hostKey]
        return (
          <div key={host.id} className="mt-1.5">
            <button
              onClick={() => toggleProject(hostKey)}
              className="flex min-h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12px] font-semibold text-text-soft transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text"
              aria-expanded={!hostCollapsed}
            >
              <ChevronRight
                size={12}
                className={cn('shrink-0 text-muted transition-transform duration-150', !hostCollapsed && 'rotate-90')}
              />
              <Server size={12} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{host.name}</span>
              <ConnectionDot state={host.online ? 'online' : 'offline'} className="size-1.5" />
              <span className="text-[10px] font-normal tabular-nums text-muted">{host.count}</span>
            </button>
            <div
              className="expand-grid mt-0.5"
              data-open={!hostCollapsed}
              aria-hidden={hostCollapsed}
              inert={hostCollapsed}
            >
              <div className="expand-inner space-y-1">
                {host.projects.map((project) => {
                  const projCollapsed = !!collapsed[project.key]
                  return (
                    <div key={project.key}>
                      <button
                        onClick={() => toggleProject(project.key)}
                        className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 pl-5 text-left text-[11px] text-muted transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text-soft"
                        aria-expanded={!projCollapsed}
                        title={project.name}
                      >
                        <ChevronRight
                          size={11}
                          className={cn('shrink-0 transition-transform duration-150', !projCollapsed && 'rotate-90')}
                        />
                        <FolderGit2 size={12} className="shrink-0" />
                        <span className="min-w-0 max-w-[45%] truncate text-text-soft">{project.name}</span>
                        {project.branch && (
                          <span className="flex min-w-0 items-center gap-0.5 text-[10px] text-muted">
                            <GitBranch size={9} className="shrink-0" />
                            <span className="truncate">{project.branch}</span>
                          </span>
                        )}
                        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted">
                          {project.items.length}
                        </span>
                      </button>
                      <div
                        className="expand-grid mt-0.5"
                        data-open={!projCollapsed}
                        aria-hidden={projCollapsed}
                        inert={projCollapsed}
                      >
                        <div className="expand-inner space-y-0.5 pl-3">
                          {project.items.map((s) => (
                            <Fragment key={`${host.id}:${s.id}`}>
                              {renderRow(host.id, s)}
                              {showSubagents &&
                                project.children[s.id]?.map((child) => renderRow(host.id, child, 1))}
                            </Fragment>
                          ))}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })}

      {menu && menuActions && (
        <RowMenu
          state={menu}
          onClose={() => setMenu(null)}
          {...menuActions}
        />
      )}

      <Modal
        open={!!confirm}
        onClose={() => {
          if (!confirm?.busy) setConfirm(null)
        }}
        title={confirm?.dirty ? 'worktree 有未提交改动' : '删除会话'}
        className="max-w-md"
        footer={
          <>
            <button
              onClick={() => setConfirm(null)}
              disabled={confirm?.busy}
              className="min-h-9 rounded-lg border border-border bg-surface px-3.5 text-[12.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={async () => {
                if (!confirm) return
                setConfirm({ ...confirm, busy: true })
                try {
                  await deleteSession(confirm.hostId, confirm.session.id, !!confirm.dirty)
                  setConfirm(null)
                } catch (err) {
                  const dirty =
                    (err instanceof ApiError && err.status === 409) ||
                    (err instanceof Error && /未提交改动/.test(err.message))
                  if (dirty) setConfirm((c) => (c ? { ...c, busy: false, dirty: true } : c))
                  else {
                    useUiStore.getState().toast(
                      err instanceof Error ? err.message : '删除会话失败',
                      'error',
                    )
                    setConfirm((c) => (c ? { ...c, busy: false } : c))
                  }
                }
              }}
              disabled={confirm?.busy}
              className="flex min-h-9 items-center gap-1.5 rounded-lg bg-danger px-3.5 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {confirm?.busy && <Loader2 size={13} className="animate-spin" />}
              {confirm?.dirty ? '仍然删除' : '删除'}
            </button>
          </>
        }
      >
        {confirm?.dirty ? (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[12px] leading-5 text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            有未提交改动，仍然删除？worktree 目录与分支会被一并清除，改动将无法恢复。
          </div>
        ) : (
          <p className="text-[13px] leading-6 text-text-soft">
            确定删除「{confirm?.session.title || '未命名会话'}」？会话记录将从 Host 上移除，且无法恢复。
          </p>
        )}
        <p className="mt-1.5 break-all font-mono text-[10.5px] text-muted">{confirm?.session.cwd}</p>
      </Modal>

      <Modal
        open={!!merge}
        onClose={() => {
          if (!merge?.busy) setMerge(null)
        }}
        title="合并 worktree"
        className="max-w-md"
        footer={
          <>
            <button
              onClick={() => setMerge(null)}
              disabled={merge?.busy}
              className="min-h-9 rounded-lg border border-border bg-surface px-3.5 text-[12.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
            >
              取消
            </button>
            <button
              onClick={async () => {
                if (!merge) return
                const host = hosts.find((h) => h.id === merge.hostId)
                if (!host) return
                setMerge({ ...merge, busy: true, error: undefined })
                try {
                  const res = await api.mergeWorktree(host, merge.session.id, merge.strategy)
                  if (!res.ok) throw new Error(res.error || '合并失败')
                  useUiStore.getState().toast('已合并回基准分支', 'success')
                  setMerge(null)
                  void useAppStore.getState().refreshSessions(merge.hostId)
                } catch (err) {
                  setMerge((m) =>
                    m ? { ...m, busy: false, error: err instanceof Error ? err.message : '合并失败' } : m,
                  )
                }
              }}
              disabled={merge?.busy}
              className="flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {merge?.busy && <Loader2 size={13} className="animate-spin" />}
              合并
            </button>
          </>
        }
      >
        <div className="space-y-3 text-[12.5px] leading-5 text-text-soft">
          <p>
            把 <span className="font-mono text-text">{merge?.session.worktree?.branch}</span> 合回{' '}
            <span className="font-mono text-text">{merge?.session.worktree?.baseBranch}</span>。
          </p>
          <div className="flex gap-2">
            {(['merge', 'squash'] as const).map((strategy) => (
              <button
                key={strategy}
                onClick={() => merge && setMerge({ ...merge, strategy, error: undefined })}
                className={cn(
                  'flex-1 rounded-lg border px-2.5 py-2 text-left text-[11.5px] transition-colors',
                  merge?.strategy === strategy
                    ? 'border-accent bg-accent-soft/60 text-text'
                    : 'border-border bg-surface text-muted hover:border-border-strong',
                )}
              >
                <span className="block font-medium">
                  {strategy === 'merge' ? 'Merge' : 'Squash'}
                </span>
                <span className="mt-0.5 block text-[10.5px] leading-4">
                  {strategy === 'merge' ? '保留分支提交记录' : '压缩为一个提交'}
                </span>
              </button>
            ))}
          </div>
          {merge?.error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[11.5px] text-danger">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">
                {merge.error}
                {/冲突|conflict/i.test(merge.error) &&
                  ' 请先在 worktree 中解决冲突（或在会话里让助手处理）后重试。'}
              </span>
            </div>
          )}
        </div>
      </Modal>
    </nav>
  )
}
