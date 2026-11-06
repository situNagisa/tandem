import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  Eye,
  Folder,
  GitBranch,
  GitMerge,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type { ExternalSession, SessionSummary } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { api, ApiError } from '../lib/api'
import { useUiStore } from '../store/useUiStore'
import { useNow } from '../lib/hooks'
import { clearRunning, runningSince } from '../lib/runClock'
import { basename, formatElapsed, formatRelative } from '../lib/format'
import { rememberDir } from '../lib/storage'
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { SessionStatusDot } from './StatusDot'
import { Modal } from './ui/Modal'
import { Button, IconButton } from './ui/Button'
import { MenuDivider, MenuItem, MenuList } from './ui/Menu'
import { Tooltip } from './ui/Tooltip'

const EMPTY: SessionSummary[] = []

interface ExternalItem extends ExternalSession {
  hostId: string
}

interface ProjectGroup {
  key: string
  name: string
  cwd?: string
  branch?: string
  items: SessionSummary[]
  externals: ExternalItem[]
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
  externalSessions: ExternalItem[],
  query: string,
  showArchived: boolean,
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

    // 子代理/孙代理会话只出现在对应主会话的消息流里，侧栏与搜索结果一律隐藏
    const tops = matched.filter((s) => !s.parentId)
    const regular: SessionSummary[] = []
    for (const s of tops) {
      if (s.pinned && !showArchived) pinned.push({ hostId: h.id, session: s })
      else regular.push(s)
    }
    const map = new Map<string, ProjectGroup>()
    for (const s of regular) {
      const name = projectName(s)
      const key = `${h.id}:${name}`
      let group = map.get(key)
      if (!group) {
        group = {
          key,
          name,
          cwd: s.cwd,
          branch: s.worktree ? undefined : s.env?.branch,
          items: [],
          externals: [],
          children: {},
        }
        map.set(key, group)
      }
      if (!group.branch && s.env?.branch && !s.worktree) group.branch = s.env.branch
      group.items.push(s)
    }

    // 外部会话（Claude Code / Codex）按 cwd 并入对应项目；字段缺失时自然为空。
    if (!showArchived) {
      for (const ext of externalSessions) {
        if (ext.hostId !== h.id) continue
        if (q) {
          const hay = `${ext.title} ${ext.cwd} ${ext.source}`.toLowerCase()
          if (!hay.includes(q)) continue
        }
        const base = basename(ext.cwd) || '未命名项目'
        let group: ProjectGroup | null =
          [...map.values()].find((g) => (g.cwd && g.cwd === ext.cwd) || g.name === base) ?? null
        if (!group) {
          group = {
            key: `${h.id}:${base}`,
            name: base,
            cwd: ext.cwd,
            items: [],
            externals: [],
            children: {},
          }
          map.set(group.key, group)
        }
        group.externals.push(ext)
      }
    }
    if (regular.length === 0 && ![...map.values()].some((g) => g.externals.length > 0)) continue
    const projects = [...map.values()]
      .map((g) => ({
        ...g,
        items: g.items.slice().sort((a, b) => b.updatedAt - a.updatedAt),
        externals: g.externals.slice().sort((a, b) => b.updatedAt - a.updatedAt),
      }))
      .sort((a, b) => {
        const at = Math.max(a.items[0]?.updatedAt ?? 0, a.externals[0]?.updatedAt ?? 0)
        const bt = Math.max(b.items[0]?.updatedAt ?? 0, b.externals[0]?.updatedAt ?? 0)
        return bt - at
      })
    groups.push({
      id: h.id,
      name: h.name,
      online: rt?.status === 'online',
      projects,
      count:
        regular.length +
        projects.reduce((n, p) => n + p.externals.length, 0) +
        Object.values(projects).reduce(
          (n, p) => n + Object.values(p.children).reduce((m, l) => m + l.length, 0),
          0,
        ),
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
    // 靠近视口右侧/底部时向内翻转，避免菜单被边缘裁切。
    let left = state.x
    let top = state.y
    if (left + rect.width > window.innerWidth - 8) left = state.x - rect.width
    if (top + rect.height > window.innerHeight - 8) top = state.y - rect.height
    setPos({
      left: Math.max(8, Math.min(left, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - rect.height - 8)),
    })
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

  return createPortal(
    <div
      ref={ref}
      className="anim-pop fixed z-[70] w-[196px] origin-top-left rounded-[10px] border border-border bg-surface p-[5px] shadow-[var(--t-shadow-md)]"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      <MenuList aria-label="会话操作">
        <MenuItem
          icon={<Pencil size={14} />}
          onSelect={() => {
            onClose()
            onRename()
          }}
        >
          重命名
        </MenuItem>
        <MenuItem
          icon={state.session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          onSelect={() => {
            onClose()
            onTogglePin()
          }}
        >
          {state.session.pinned ? '取消置顶' : '置顶'}
        </MenuItem>
        <MenuItem
          icon={<Copy size={14} />}
          onSelect={() => {
            onClose()
            onFork()
          }}
        >
          复制会话
        </MenuItem>
        {state.session.worktree && (
          <MenuItem
            icon={<GitMerge size={14} />}
            onSelect={() => {
              onClose()
              onMerge()
            }}
          >
            合并回 {state.session.worktree.baseBranch}
          </MenuItem>
        )}
        <MenuItem
          icon={state.session.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          onSelect={() => {
            onClose()
            onArchive()
          }}
        >
          {state.session.archived ? '取消归档' : '归档'}
        </MenuItem>
        <MenuDivider />
        <MenuItem
          danger
          icon={<Trash2 size={14} />}
          onSelect={() => {
            onClose()
            onDelete()
          }}
        >
          删除
        </MenuItem>
      </MenuList>
    </div>,
    document.body,
  )
}

export function SessionList({
  query,
  onNavigate,
  headerActions,
}: {
  query: string
  onNavigate?: () => void
  headerActions?: ReactNode
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
  const showExternalSessions = useUiStore((s) => s.showExternalSessions)
  const hiddenExternalSources = useUiStore((s) => s.hiddenExternalSources)
  // 同事会提供 externalSessions（顶层数组或按 hostId 的 Record 均可），未就绪时为 undefined。
  const externalRaw = useAppStore(
    (s) => (s as typeof s & { externalSessions?: unknown }).externalSessions,
  )
  const activateHost = useAppStore((s) => s.activateHost)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [expandedExternal, setExpandedExternal] = useState<Record<string, boolean>>({})
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

  const externalItems = useMemo(() => {
    const list: ExternalItem[] = []
    for (const h of hosts) {
      for (const ext of runtimes[h.id]?.externalSessions ?? []) {
        list.push({ ...ext, hostId: h.id })
      }
    }
    // 顶层 externalSessions 兼容两种形态：ExternalSession[]（带 hostId）或 Record<hostId, ...>。
    const top: Array<ExternalSession & { hostId?: string }> = []
    if (Array.isArray(externalRaw)) {
      top.push(...(externalRaw as Array<ExternalSession & { hostId?: string }>))
    } else if (externalRaw && typeof externalRaw === 'object') {
      for (const [hostId, value] of Object.entries(externalRaw as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue
        for (const ext of value as ExternalSession[]) top.push({ ...ext, hostId })
      }
    }
    for (const ext of top) {
      const hostId = ext.hostId ?? hosts[0]?.id
      if (!hostId) continue
      if (list.some((x) => x.hostId === hostId && x.source === ext.source && x.id === ext.id)) {
        continue
      }
      list.push({ ...ext, hostId })
    }
    return list.filter((x) => !x.importedSessionId)
  }, [hosts, runtimes, externalRaw])

  const visibleExternals = useMemo(
    () =>
      showExternalSessions
        ? externalItems.filter((x) => !hiddenExternalSources.includes(x.source))
        : [],
    [externalItems, showExternalSessions, hiddenExternalSources],
  )

  const { pinned, hosts: groups } = useMemo(
    () => buildGroups(hosts, runtimes, visibleExternals, query, showArchived),
    [hosts, runtimes, visibleExternals, query, showArchived],
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

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus()
      renameRef.current?.select()
    }
  }, [renaming])

  const total = groups.reduce((n, g) => n + g.count, 0) + (showArchived ? 0 : pinned.length)
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

  const openExternal = (hostId: string, ext: ExternalItem) => {
    window.location.hash = `#/h/${encodeURIComponent(hostId)}/x/${encodeURIComponent(ext.source)}/${encodeURIComponent(ext.id)}`
    onNavigate?.()
  }

  const newSessionIn = (hostId: string, cwd: string) => {
    activateHost(hostId)
    if (cwd) rememberDir(hostId, cwd)
    // 已经在新会话页时不会重新挂载，用事件把 Host / 目录同步过去。
    window.dispatchEvent(new CustomEvent('tandem:new-session', { detail: { hostId, cwd } }))
    setShowArchived(false)
    navigate({ kind: 'home' })
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
        title={
          s.forkedFrom
            ? `分叉自 ${s.forkedFrom.title || '父会话'}${s.title ? ` · ${s.title}` : ''}`
            : s.worktree
              ? `${s.title || '未命名会话'} · worktree ${s.worktree.branch}（基于 ${s.worktree.baseBranch}）`
              : s.title || '未命名会话'
        }
        className={cn(
          'anim-row-in group relative flex h-11 cursor-default items-center gap-2 rounded-lg pl-2 pr-1 text-[14px] outline-none transition-colors duration-[120ms] md:h-[34px]',
          depth > 0 && 'ml-5',
          isActive
            ? 'bg-[var(--t-bg-active)] text-text'
            : 'text-text hover:bg-[var(--t-bg-hover)]',
        )}
      >
        <span className="pointer-events-none flex size-4 shrink-0 items-center justify-center">
          {s.status !== 'idle' ? (
            <SessionStatusDot status={s.status} />
          ) : (
            <span className="size-1.5 rounded-full border border-current opacity-35" />
          )}
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
          <span className="min-w-0 flex-1 truncate text-[14px] leading-5">
            {s.title || '未命名会话'}
          </span>
        )}
        {!renamingThis && (
          <span className="relative flex h-full w-[62px] shrink-0 items-center justify-end">
            <span
              className={cn(
                'hidden max-w-full truncate text-[12px] tabular-nums transition-opacity md:inline',
                elapsed && 'text-[12px]',
                s.status === 'waiting_permission' ? 'text-accent' : 'text-text-tertiary',
                isActive ? 'opacity-0' : 'group-hover:opacity-0',
              )}
              title={elapsed ? `${runningLabel} · ${elapsed}` : undefined}
            >
              {elapsed ? `${runningLabel} · ${elapsed}` : formatRelative(s.updatedAt)}
            </span>
            <IconButton
              size="sm"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const rect = e.currentTarget.getBoundingClientRect()
                setMenu({ hostId, session: s, x: rect.right - 4, y: rect.bottom + 4 })
              }}
              label="会话操作"
              tooltip=""
              className={cn(
                'absolute right-0 top-1/2 size-7! -translate-y-1/2 focus-visible:opacity-100 [&_svg]:size-[15px]',
                isActive
                  ? 'opacity-100'
                  : 'opacity-100 md:opacity-0 md:group-hover:opacity-100',
              )}
            >
              <MoreHorizontal size={15} />
            </IconButton>
          </span>
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
      className="min-h-0 flex-1 overflow-x-clip overflow-y-auto px-2 pb-3"
      aria-label="会话列表"
    >
      <div className="flex h-8 items-center gap-1 pb-0.5 pl-2.5 pr-0.5 pt-1.5">
        <span className="text-[12px] font-medium text-text-tertiary">
          {showArchived ? '已归档' : query ? '搜索结果' : '会话'}
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-0.5">{headerActions}</div>
      </div>

        {total === 0 && (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--t-bg-hover)] text-muted">
              <MessageSquarePlus size={18} />
            </div>
            <p className="text-[13px] leading-5 text-muted">
              {query
                ? '没有匹配的会话'
                : showArchived
                  ? '没有已归档的会话'
                  : noHosts
                    ? '还没有连接 Host，在左下角设置中添加。'
                    : '还没有会话，从上方「新会话」开始。'}
            </p>
          </div>
        )}

        {!showArchived && pinned.length > 0 && (
          <div className="mb-1">
            <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[12px] font-medium text-text-tertiary">
              <Pin size={11} />
              置顶
            </div>
            <div className="space-y-0.5">{pinned.map(({ hostId, session }) => renderRow(hostId, session))}</div>
          </div>
        )}

        {(() => {
          const multiHost = hosts.length > 1
          const renderExternal = (hostId: string, ext: ExternalItem) => {
            const sourceLabel = ext.source === 'codex' ? 'Codex' : 'Claude Code'
            return (
              <Tooltip
                key={`${hostId}:${ext.source}:${ext.id}`}
                label={`${sourceLabel} 会话 · 只读`}
                side="top"
                className="block w-full"
              >
                <button
                  onClick={() => openExternal(hostId, ext)}
                  className="anim-row-in flex h-11 w-full min-w-0 items-center gap-2 rounded-lg pl-2 pr-2 text-left text-[14px] text-text outline-none transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] md:h-[34px]"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center text-text-tertiary">
                    <Eye size={12} />
                  </span>
                  <span className="min-w-0 flex-1 truncate leading-5">
                    {ext.title || '未命名会话'}
                  </span>
                  <span className="w-[64px] shrink-0 truncate text-right text-[12px] tabular-nums text-text-tertiary">
                    {formatRelative(ext.updatedAt)}
                  </span>
                </button>
              </Tooltip>
            )
          }

          const renderProject = (hostId: string, project: ProjectGroup, indented: boolean) => {
            const projCollapsed = !!collapsed[project.key]
            // 搜索时展示全部；平时外部会话默认只露最近 5 条，避免淹没 Tandem 会话
            const searching = !!query.trim()
            const externalExpanded = !!expandedExternal[project.key]
            const shownExternals =
              searching || externalExpanded ? project.externals : project.externals.slice(0, 5)
            const hiddenExternalCount = project.externals.length - shownExternals.length
            const externalSourceLabel = project.externals.some((e) => e.source === 'claude-code')
              ? 'Claude Code'
              : 'Codex'
            const entries = [
              ...project.items.map((s) => (
                <Fragment key={`${hostId}:${s.id}`}>{renderRow(hostId, s)}</Fragment>
              )),
              ...shownExternals.map((ext) => renderExternal(hostId, ext)),
            ]
            const count = project.items.length + project.externals.length
            return (
              <div key={project.key} className="min-w-0">
                <div className="group/proj flex h-8 min-w-0 items-center rounded-lg pr-0.5 transition-colors hover:bg-[var(--t-bg-hover)]">
                  <button
                    onClick={() => toggleProject(project.key)}
                    className={cn(
                      'flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg text-left text-[13px] font-medium text-text-secondary transition-colors duration-[120ms] hover:text-text',
                      indented ? 'pl-5' : 'pl-1.5',
                    )}
                    aria-expanded={!projCollapsed}
                    title={`${project.name}${project.branch ? ` · ${project.branch}` : ''} (${count})`}
                  >
                    <ChevronRight
                      size={11}
                      className={cn(
                        'shrink-0 text-text-tertiary opacity-70 transition-transform duration-150',
                        !projCollapsed && 'rotate-90',
                      )}
                    />
                    <Folder size={13} className="shrink-0 text-text-tertiary" />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {project.branch && (
                      <span className="flex min-w-0 max-w-[42%] items-center gap-0.5 text-[12px] font-normal text-text-tertiary">
                        <GitBranch size={9} className="shrink-0" />
                        <span className="truncate">{project.branch}</span>
                      </span>
                    )}
                  </button>
                  <IconButton
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      newSessionIn(hostId, project.cwd || '')
                    }}
                    tooltip={`在 ${project.name} 新建会话`}
                    label={`在 ${project.name} 新建会话`}
                    tooltipSide="top"
                    className="size-7! opacity-100 focus-visible:opacity-100 md:opacity-0 md:group-hover/proj:opacity-100 [&_svg]:size-[13px]"
                  >
                    <Plus size={13} />
                  </IconButton>
                </div>
                <div
                  className="expand-grid mt-0.5"
                  data-open={!projCollapsed}
                  aria-hidden={projCollapsed}
                  inert={projCollapsed}
                >
                  <div className={cn('expand-inner space-y-0.5', indented ? 'pl-6' : 'pl-4')}>
                    {entries}
                    {hiddenExternalCount > 0 && (
                      <button
                        onClick={() =>
                          setExpandedExternal((s) => ({ ...s, [project.key]: true }))
                        }
                        className="flex h-8 w-full items-center gap-1.5 rounded-lg pl-2 pr-2 text-left text-[12px] text-text-tertiary transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text-secondary"
                      >
                        <ChevronRight size={11} className="shrink-0 rotate-90" />
                        更多 {externalSourceLabel} 会话（{hiddenExternalCount}）
                      </button>
                    )}
                    {!searching && externalExpanded && project.externals.length > 5 && (
                      <button
                        onClick={() =>
                          setExpandedExternal((s) => {
                            const next = { ...s }
                            delete next[project.key]
                            return next
                          })
                        }
                        className="flex h-8 w-full items-center gap-1.5 rounded-lg pl-2 pr-2 text-left text-[12px] text-text-tertiary transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text-secondary"
                      >
                        <ChevronRight size={11} className="shrink-0" />
                        收起 {externalSourceLabel} 会话
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          }

          if (!multiHost) {
            return (
              <div className="space-y-1 pt-1">
                {groups.flatMap((host) =>
                  host.projects.map((project) => renderProject(host.id, project, false)),
                )}
              </div>
            )
          }

          return groups.map((host) => {
            const hostKey = `host:${host.id}`
            const hostCollapsed = !!collapsed[hostKey]
            return (
              <div key={host.id} className="mt-2">
                <button
                  onClick={() => toggleProject(hostKey)}
                  className={cn(
                    'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-left text-[12px] font-medium transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)]',
                    host.online ? 'text-text-secondary hover:text-text' : 'text-text-tertiary',
                  )}
                  aria-expanded={!hostCollapsed}
                >
                  <ChevronRight
                    size={11}
                    className={cn('shrink-0 opacity-70 transition-transform duration-150', !hostCollapsed && 'rotate-90')}
                  />
                  <Server size={12} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">{host.name}</span>
                  <span className="text-[12px] font-normal tabular-nums text-text-tertiary">{host.count}</span>
                </button>
                <div
                  className="expand-grid mt-0.5"
                  data-open={!hostCollapsed}
                  aria-hidden={hostCollapsed}
                  inert={hostCollapsed}
                >
                  <div className="expand-inner space-y-1 pt-0.5">
                    {host.projects.map((project) => renderProject(host.id, project, true))}
                  </div>
                </div>
              </div>
            )
          })
        })()}

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
            <Button size="lg" onClick={() => setConfirm(null)} disabled={confirm?.busy}>
              取消
            </Button>
            <Button
              size="lg"
              variant="danger-ghost"
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
            >
              {confirm?.busy && <Loader2 size={14} className="animate-spin" />}
              {confirm?.dirty ? '仍然删除' : '删除'}
            </Button>
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
        <p className="mt-1.5 break-all font-mono text-[12px] text-muted">{confirm?.session.cwd}</p>
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
            <Button size="lg" onClick={() => setMerge(null)} disabled={merge?.busy}>
              取消
            </Button>
            <Button
              size="lg"
              variant="primary"
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
            >
              {merge?.busy && <Loader2 size={14} className="animate-spin" />}
              合并
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px] leading-5 text-text-soft">
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
                  'flex-1 rounded-lg border px-2.5 py-2 text-left text-[13px] transition-colors',
                  merge?.strategy === strategy
                    ? 'border-[var(--t-border-strong)] bg-[var(--t-bg-active)] text-text'
                    : 'border-border bg-surface text-muted hover:border-border-strong',
                )}
              >
                <span className="block font-medium">
                  {strategy === 'merge' ? 'Merge' : 'Squash'}
                </span>
                <span className="mt-0.5 block text-[12px] leading-4">
                  {strategy === 'merge' ? '保留分支提交记录' : '压缩为一个提交'}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[12px] leading-5 text-muted">
            只合并已提交的改动；worktree 里未提交或未跟踪的文件会留在原目录，不会带回基准分支。
          </p>
          {merge?.error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[13px] text-danger">
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
