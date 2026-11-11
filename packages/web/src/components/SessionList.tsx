import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Clock,
  Columns2,
  Copy,
  Eye,
  FlaskConical,
  Folder,
  GitBranch,
  GitMerge,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Server,
  Share2,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { Spinner } from './ui/Spinner'
import type { ExternalSession, SessionSummary } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { api, ApiError } from '../lib/api'
import { useUiStore } from '../store/useUiStore'
import { useNow } from '../lib/hooks'
import { clearRunning, runningSince } from '../lib/runClock'
import { basename, formatElapsed, formatRelative } from '../lib/format'
import { rememberDir } from '../lib/storage'
import { navigate } from '../lib/router'
import { openSplitSession } from '../lib/splitActions'
import { cn } from '../lib/cn'
import { isSessionFilterActive, type SessionFilter } from '../lib/types'
import { SessionStatusDot } from './StatusDot'
import { Modal } from './ui/Modal'
import { Button, IconButton } from './ui/Button'
import { Menu } from './ui/Menu'
import { Tooltip } from './ui/Tooltip'
import { ShareDialog } from './share/ShareDialog'
import { SaveEvalCaseDialog } from './evals/SaveEvalCaseDialog'

import {
  buildGroups,
  isRunningStatus,
  projectName,
  type ExternalItem,
  type MenuState,
  type ProjectGroup,
} from './session/sessionListUtils'
import { SessionRow } from './session/SessionRow'
import { RowMenu } from './session/SessionRowMenu'
import { DeleteSessionDialog, MergeWorktreeDialog } from './session/SessionDialogs'
import { SessionGroups } from './session/SessionGroups'

export { sessionProjectName } from './session/sessionListUtils'

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
  const setProjectCollapsed = useUiStore((s) => s.setProjectCollapsed)
  const showArchived = useUiStore((s) => s.showArchived)
  const setShowArchived = useUiStore((s) => s.setShowArchived)
  const showExternalSessions = useUiStore((s) => s.showExternalSessions)
  const hiddenExternalSources = useUiStore((s) => s.hiddenExternalSources)
  const sessionFilter = useUiStore((s) => s.sessionFilter)
  const pinnedProjects = useUiStore((s) => s.pinnedProjects)
  const toggleProjectPinned = useUiStore((s) => s.toggleProjectPinned)
  const clearSessionFilter = useUiStore((s) => s.clearSessionFilter)
  const filterActive = isSessionFilterActive(sessionFilter)
  // 同事会提供 externalSessions（顶层数组或按 hostId 的 Record 均可），未就绪时为 undefined。
  const externalRaw = useAppStore(
    (s) => (s as typeof s & { externalSessions?: unknown }).externalSessions,
  )
  const activateHost = useAppStore((s) => s.activateHost)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const [share, setShare] = useState<{ hostId: string; session: SessionSummary } | null>(null)
  const [evalSave, setEvalSave] = useState<{ hostId: string; session: SessionSummary } | null>(null)
  const [expandedExternal, setExpandedExternal] = useState<Record<string, boolean>>({})
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [confirm, setConfirm] = useState<{
    hostId: string
    session: SessionSummary
    busy: boolean
    dirty?: boolean
    detail?: string
  } | null>(null)
  const [merge, setMerge] = useState<{
    hostId: string
    session: SessionSummary
    strategy: 'merge' | 'squash'
    busy: boolean
    error?: string
  } | null>(null)
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
    const control = next.querySelector<HTMLElement>('[data-session-open]') ?? next
    control.focus()
    control.click()
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
    () =>
      buildGroups(
        hosts,
        runtimes,
        visibleExternals,
        query,
        showArchived,
        sessionFilter,
        pinnedProjects,
      ),
    [hosts, runtimes, visibleExternals, query, showArchived, sessionFilter, pinnedProjects],
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

  const total = groups.reduce((n, g) => n + g.count, 0) + (showArchived ? 0 : pinned.length)
  const noHosts = hosts.length === 0

  const startRename = (s: SessionSummary) => {
    setRenaming(s.id)
    setRenameDraft(s.title || '')
  }

  const openSession = (hostId: string, sessionId: string, split = false) => {
    if (split) openSplitSession({ hostId, sessionId })
    else navigate({ kind: 'session', hostId, sessionId })
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
        onSplit: () => {
          openSplitSession({ hostId: menu.hostId, sessionId: menu.session.id })
          onNavigate?.()
        },
        onTogglePin: () =>
          void updateSession(menu.hostId, menu.session.id, { pinned: !menu.session.pinned }),
        onTogglePinProject: () =>
          void updateSession(menu.hostId, menu.session.id, {
            pinnedInProject: !menu.session.pinnedInProject,
          }),
        onFork: () => void forkSession(menu.hostId, menu.session.id),
        onShare: () => setShare({ hostId: menu.hostId, session: menu.session }),
        onSaveEval: () => setEvalSave({ hostId: menu.hostId, session: menu.session }),
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

  const renderRow = (
    hostId: string,
    s: SessionSummary,
    depth = 0,
    section: 'recent' | 'pinned' = 'recent',
    nested = false,
  ) => (
    <SessionRow
      key={`${hostId}:${s.id}`}
      hostId={hostId}
      s={s}
      depth={depth}
      section={section}
      nested={nested}
      activeSessionId={activeSessionId}
      renaming={renaming === s.id}
      renameDraft={renameDraft}
      setRenameDraft={setRenameDraft}
      setRenaming={(value) => setRenaming(value ? s.id : null)}
      updateSession={updateSession}
      openSession={openSession}
      openMenu={openMenu}
      setMenu={setMenu}
      runningElapsed={runningElapsed}
    />
  )

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
        {filterActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearSessionFilter}
            tooltip="清除状态 / 主机 / 项目 / 来源筛选"
            tooltipSide="bottom"
            className="h-5 rounded-full border border-accent-strong/25 bg-accent-soft/60 px-1.5 text-[11px] font-normal text-accent-text"
          >
            已筛选 <span aria-hidden>·</span> 清除
          </Button>
        )}
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
                : filterActive
                  ? '没有符合筛选的会话'
                  : showArchived
                    ? '没有已归档的会话'
                    : noHosts
                      ? '还没有主机，先在右侧添加一台主机，才能开始会话。'
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
            <div className="space-y-0.5">{pinned.map(({ hostId, session }) => renderRow(hostId, session, 0, 'pinned'))}</div>
          </div>
        )}

        <SessionGroups
          hosts={hosts}
          groups={groups}
          pinnedProjects={pinnedProjects}
          collapsed={collapsed}
          expandedExternal={expandedExternal}
          setExpandedExternal={setExpandedExternal}
          showArchived={showArchived}
          query={query}
          renderRow={renderRow}
          openExternal={openExternal}
          setProjectCollapsed={setProjectCollapsed}
          toggleProjectPinned={toggleProjectPinned}
          newSessionIn={newSessionIn}
        />

      {menu && menuActions && (
        <RowMenu
          state={menu}
          onClose={() => setMenu(null)}
          {...menuActions}
        />
      )}

      {share && (
        <ShareDialog
          hostId={share.hostId}
          session={share.session}
          onClose={() => setShare(null)}
        />
      )}

      <SaveEvalCaseDialog
        open={!!evalSave}
        onClose={() => setEvalSave(null)}
        host={hosts.find((item) => item.id === evalSave?.hostId) ?? null}
        session={evalSave?.session ?? null}
      />

      <DeleteSessionDialog
        confirm={confirm}
        setConfirm={setConfirm}
        deleteSession={deleteSession}
      />

      <MergeWorktreeDialog merge={merge} setMerge={setMerge} hosts={hosts} />
    </nav>
  )
}
