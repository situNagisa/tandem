import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUpRight,
  BarChart3,
  Bot,
  Check,
  Circle,
  CircleCheck,
  CircleDot,
  Copy,
  FileDiff,
  FolderGit2,
  Gauge,
  GitBranch,
  GitFork,
  GripVertical,
  Info,
  ListTodo,
  Loader2,
  Maximize2,
  MoreHorizontal,
  ScrollText,
  Trash2,
  X,
} from 'lucide-react'
import type { Todo } from '@tandem/protocol'
import type { SubagentSession, UiMessage } from '../lib/types'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useSessionChanges } from '../lib/useChanges'
import { copyText } from '../lib/clipboard'
import { cn } from '../lib/cn'
import { ApiError } from '../lib/api'
import { useNow } from '../lib/hooks'
import { runningSince } from '../lib/runClock'
import {
  formatCost,
  formatElapsed,
  formatRelative,
  formatTime,
  formatTokens,
} from '../lib/format'
import { PERMISSION_MODE_LABELS } from '../lib/types'
import { ConnectionDot, SessionStatusDot } from './StatusDot'
import { Markdown } from './Markdown'
import { CONTEXT_PART_META, useContextBreakdown } from './chat/ContextMeter'
import { Modal } from './ui/Modal'
import { Menu } from './ui/Menu'
import { Button, IconButton } from './ui/Button'

const EMPTY_TODOS: Todo[] = []
const EMPTY_MESSAGES: UiMessage[] = []

const STATUS_TEXT: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  waiting_permission: '等待审批',
  error: '出错',
}

const TODO_ICONS = {
  completed: CircleCheck,
  in_progress: CircleDot,
  pending: Circle,
} as const

type GroupId = 'plan' | 'todos' | 'agents' | 'usage' | 'context' | 'changes' | 'details'

const GROUPS: Array<{ id: GroupId; label: string; Icon: typeof ListTodo }> = [
  { id: 'plan', label: '当前计划', Icon: ScrollText },
  { id: 'todos', label: '待办', Icon: ListTodo },
  { id: 'agents', label: '代理', Icon: Bot },
  { id: 'usage', label: '用量', Icon: BarChart3 },
  { id: 'context', label: '上下文', Icon: Gauge },
  { id: 'changes', label: '改动摘要', Icon: FileDiff },
  { id: 'details', label: '详情', Icon: Info },
]

const GROUP_META = Object.fromEntries(GROUPS.map((g) => [g.id, g])) as Record<
  GroupId,
  (typeof GROUPS)[number]
>
const DEFAULT_ORDER = GROUPS.map((g) => g.id)
const GROUP_IDS = new Set<GroupId>(DEFAULT_ORDER)
const PREFS_KEY = 'tandem.rightPanel.v1'

interface PanelPrefs {
  order: GroupId[]
  hidden: GroupId[]
}

function loadPanelPrefs(): PanelPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { order: [...DEFAULT_ORDER], hidden: [] }
    const parsed = JSON.parse(raw) as { order?: unknown; hidden?: unknown }
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((id): id is GroupId => typeof id === 'string' && GROUP_IDS.has(id as GroupId))
      : []
    for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id)
    const hidden = Array.isArray(parsed.hidden)
      ? parsed.hidden.filter((id): id is GroupId => typeof id === 'string' && GROUP_IDS.has(id as GroupId))
      : []
    return { order, hidden: [...new Set(hidden)] }
  } catch {
    return { order: [...DEFAULT_ORDER], hidden: [] }
  }
}

function savePanelPrefs(prefs: PanelPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage 不可用时只保留本次会话内的顺序与显隐。
  }
}

const CHANGE_MARK: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] items-baseline gap-2 py-[3px] text-[13px] leading-[18px]">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="min-w-0 break-words text-text">{children}</span>
    </div>
  )
}

function Card({
  id,
  label,
  icon: Icon,
  dragging,
  activeHandle,
  onHandleDown,
  onHandleUp,
  onDragStart,
  onDragEnd,
  onDragOver,
  right,
  cardRef,
  children,
}: {
  id: GroupId
  label: string
  icon: typeof ListTodo
  dragging: boolean
  activeHandle: boolean
  onHandleDown: () => void
  onHandleUp: () => void
  onDragStart: (e: React.DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent<HTMLElement>) => void
  right?: ReactNode
  cardRef: (el: HTMLElement | null) => void
  children: ReactNode
}) {
  return (
    <section
      ref={cardRef}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      data-group={id}
      className={cn(
        'group/card rounded-[10px] border border-border px-3 py-2.5 shadow-[var(--t-shadow-sm)] transition-[opacity,box-shadow] duration-150',
        dragging && 'opacity-55',
      )}
      style={{ backgroundColor: 'color-mix(in srgb, var(--t-surface) 38%, var(--t-sidebar))' }}
    >
      <div className="mb-2 flex min-h-4 items-center gap-1.5">
        <span
          role="button"
          tabIndex={-1}
          aria-label={`拖动排序：${label}`}
          onPointerDown={onHandleDown}
          onPointerUp={onHandleUp}
          className={cn(
            'hidden w-3 shrink-0 cursor-grab items-center justify-center self-stretch text-muted transition-opacity duration-120 active:cursor-grabbing md:flex',
            activeHandle || dragging ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100',
          )}
        >
          <GripVertical size={11} />
        </span>
        <Icon size={11} className="shrink-0 text-text-tertiary" />
        <h3 className="min-w-0 truncate text-[12px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
          {label}
        </h3>
        <span className="flex-1" />
        {right}
      </div>
      {children}
    </section>
  )
}

function AgentRow({ sub, depth }: { sub: SubagentSession; depth: number }) {
  const focusAgent = useUiStore((s) => s.focusAgent)
  const id = sub.summary?.id ?? ''
  const status = sub.summary?.status
  const running = sub.running || status === 'running' || status === 'waiting_permission'
  const now = useNow(running)
  const since = runningSince(`agent:${id}`, sub.summary?.createdAt ?? Date.now())
  const usage = sub.summary?.usage
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  const failed = status === 'error' || !!sub.error
  const text = failed
    ? '出错'
    : status === 'waiting_permission'
      ? '待审批'
      : running
        ? '运行中'
        : sub.loading
          ? '加载中'
          : '已结束'
  return (
    <button
      type="button"
      onClick={() => id && focusAgent(id)}
      className="flex min-h-8 w-full items-center gap-1.5 rounded-md pr-1 text-left text-[13px] transition-colors hover:bg-[var(--t-bg-hover)]"
      style={{ paddingLeft: 4 + Math.max(0, depth - 1) * 14 }}
      title={sub.summary?.title}
    >
      <span className="shrink-0 text-[12px] text-muted">
        {depth <= 1 ? '子' : depth === 2 ? '孙' : depth}
      </span>
      <span className="min-w-0 flex-1 truncate text-text-soft">
        {sub.summary?.title || '未命名代理'}
      </span>
      <span
        className={cn(
          'shrink-0 text-[12px]',
          failed ? 'text-danger' : running ? 'text-text-secondary' : 'text-muted',
        )}
      >
        {text}
        {running && ` ${formatElapsed(now - since)}`}
      </span>
      <span className="w-9 shrink-0 text-right text-[12px] tabular-nums text-muted">
        {formatTokens(tokens)}
      </span>
    </button>
  )
}

function AgentsCard() {
  const subagents = useAppStore((s) => s.active?.subagents)
  const activeSessionId = useAppStore((s) => s.active?.sessionId)
  const rows = useMemo(() => {
    if (!subagents || !activeSessionId) return []
    const children = new Map<string, SubagentSession[]>()
    for (const sub of Object.values(subagents)) {
      const parentId = sub.summary?.parentId
      if (!parentId) continue
      const list = children.get(parentId) ?? []
      list.push(sub)
      children.set(parentId, list)
    }
    const out: Array<{ sub: SubagentSession; depth: number }> = []
    const walk = (parentId: string, depth: number) => {
      const list = (children.get(parentId) ?? [])
        .slice()
        .sort((a, b) => (a.summary?.createdAt ?? 0) - (b.summary?.createdAt ?? 0))
      for (const sub of list) {
        out.push({ sub, depth })
        if (sub.summary?.id) walk(sub.summary.id, depth + 1)
      }
    }
    walk(activeSessionId, 1)
    return out
  }, [subagents, activeSessionId])

  if (rows.length === 0) return <p className="text-[12px] text-muted">暂无代理</p>
  return (
    <div className="space-y-0.5">
      {rows.map(({ sub, depth }) => (
        <AgentRow key={sub.summary?.id} sub={sub} depth={depth} />
      ))}
    </div>
  )
}

/** 右侧栏上下文卡片：与输入框上下文环同源，紧凑展示占用、分类与缓存命中率。 */
function ContextCard() {
  const { context, noData, window, used, pct } = useContextBreakdown()
  if (noData || !context) {
    return <p className="text-[12px] leading-4 text-muted">暂无上下文数据</p>
  }
  const parts = context.parts.filter((part) => part.kind !== 'free')
  const free = Math.max(0, window - used)
  const rows = [...parts, { kind: 'free' as const, tokens: free }]
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[12px] tabular-nums text-text-soft">
          {formatTokens(used)} / {formatTokens(window)}
        </span>
        <span className="font-mono text-[12px] tabular-nums text-muted">{pct}%</span>
      </div>
      <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        {rows.map((part) => {
          const width = (part.tokens / window) * 100
          if (width <= 0) return null
          const meta = CONTEXT_PART_META[part.kind]
          return (
            <div
              key={part.kind}
              title={`${meta.label} ${formatTokens(part.tokens)}`}
              style={{
                width: `${width}%`,
                backgroundColor: meta.color,
                opacity: part.kind === 'free' ? 1 : 0.88,
              }}
              className={cn(part.kind === 'free' && 'bg-[var(--t-surface-2)]')}
            />
          )
        })}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        {rows.map((part) => {
          const meta = CONTEXT_PART_META[part.kind]
          return (
            <div
              key={part.kind}
              className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4"
            >
              <span
                className="size-1.5 shrink-0 rounded-[2px] border border-border/60"
                style={{ backgroundColor: part.kind === 'free' ? 'transparent' : meta.color }}
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  part.kind === 'free' ? 'text-muted' : 'text-text-soft',
                )}
              >
                {meta.label}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-text-soft">
                {formatTokens(part.tokens)}
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-1.5 text-[12px]">
        <span className="text-muted">缓存命中率</span>
        <span className="font-mono tabular-nums text-text-soft">
          {context.cacheHitRate !== undefined
            ? `${Math.round(context.cacheHitRate * 100)}%`
            : '—'}
        </span>
      </div>
    </div>
  )
}

export function RightPanel({ onClose }: { onClose: () => void }) {
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const messages = useAppStore((s) => s.active?.messages ?? EMPTY_MESSAGES)
  const profiles = useAppStore((s) => (hostId ? s.runtimes[hostId]?.profiles : undefined))
  const todos = useAppStore((s) => s.active?.todos ?? EMPTY_TODOS)
  const plan = useAppStore((s) => s.active?.plan ?? null)
  const subagents = useAppStore((s) => s.active?.subagents)
  const agentCount = subagents ? Object.keys(subagents).length : 0
  const changesNonce = useAppStore((s) => s.changesNonce)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.active?.hostId) ?? null)
  const hostStatus = useAppStore((s) =>
    hostId ? (s.runtimes[hostId]?.status ?? 'offline') : 'offline',
  )
  const profileName = useAppStore((s) => {
    if (!hostId || !summary?.profileId) return null
    const profile = s.runtimes[hostId]?.profiles.find((p) => p.id === summary.profileId)
    if (!profile) return null
    // 老会话的 groupId 可能写的是分组名
    const group = summary.groupId
      ? profile.groups?.find((g) => g.id === summary.groupId || g.name === summary.groupId)?.name
      : undefined
    return group ? `${profile.name} › ${group}` : profile.name
  })
  const profilesLoaded = useAppStore((s) =>
    hostId ? (s.runtimes[hostId]?.profilesLoaded ?? false) : false,
  )
  const profilesLoading = useAppStore((s) =>
    hostId ? (s.runtimes[hostId]?.profilesLoading ?? false) : false,
  )
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const profileRetryRef = useRef<string | null>(null)
  useEffect(() => {
    if (!hostId || profilesLoaded || profilesLoading) return
    if (profileRetryRef.current === hostId) return
    profileRetryRef.current = hostId
    void refreshProfiles(hostId)
  }, [hostId, profilesLoaded, profilesLoading, refreshProfiles])
  const deleteSession = useAppStore((s) => s.deleteSession)
  const toast = useUiStore((s) => s.toast)
  const setChangesOpen = useUiStore((s) => s.setChangesOpen)
  const [copied, setCopied] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [dirtyWorktree, setDirtyWorktree] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [prefs, setPrefs] = useState<PanelPrefs>(loadPanelPrefs)
  const [dragging, setDragging] = useState<GroupId | null>(null)
  const [dragArmed, setDragArmed] = useState<GroupId | null>(null)
  const handleDownRef = useRef(false)
  const lastTargetRef = useRef<GroupId | null>(null)
  const cardRefs = useRef(new Map<GroupId, HTMLElement>())
  const positionsRef = useRef(new Map<GroupId, number>())
  const { changes } = useSessionChanges(host, sessionId, changesNonce, !!sessionId)

  const completed = todos.filter((t) => t.status === 'completed').length
  const progress = todos.length ? Math.round((completed / todos.length) * 100) : 0
  const usage = summary?.usage
  const keyUsage = useMemo(() => {
    const counts = new Map<string, number>()
    for (const message of messages) {
      const keyId = message.usage?.keyId
      if (keyId && message.role === 'assistant') {
        counts.set(keyId, (counts.get(keyId) ?? 0) + 1)
      }
    }
    if (counts.size <= 1) return null
    const profile = profiles?.find((p) => p.id === summary?.profileId)
    const group = profile?.groups?.find(
      (g) => g.id === summary?.groupId || g.name === summary?.groupId,
    )
    return [...counts]
      .map(([id, count]) => {
        const key = group?.keys.find((k) => k.id === id)
        const label = key?.label?.trim() || key?.apiKeyMasked?.slice(-4) || id.slice(-4)
        return `${label} ×${count}`
      })
      .join(' · ')
  }, [messages, profiles, summary?.profileId, summary?.groupId])
  const fileChanges = changes?.isRepo ? changes.files : []
  const additions = fileChanges.reduce((n, f) => n + f.additions, 0)
  const deletions = fileChanges.reduce((n, f) => n + f.deletions, 0)

  const available = useMemo<Record<GroupId, boolean>>(
    () => ({
      plan: !!plan,
      todos: true,
      agents: agentCount > 0,
      usage: true,
      context: true,
      changes: fileChanges.length > 0,
      details: true,
    }),
    [plan, fileChanges.length, agentCount],
  )

  const visibleGroups = prefs.order.filter((id) => !prefs.hidden.includes(id) && available[id])

  useEffect(() => savePanelPrefs(prefs), [prefs])

  const capturePositions = () => {
    const map = new Map<GroupId, number>()
    for (const [id, el] of cardRefs.current) map.set(id, el.offsetTop)
    positionsRef.current = map
  }

  useLayoutEffect(() => {
    const before = positionsRef.current
    if (before.size === 0) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduceMotion) {
      for (const [id, el] of cardRefs.current) {
        const prev = before.get(id)
        if (prev === undefined) continue
        const delta = prev - el.offsetTop
        if (Math.abs(delta) < 1) continue
        el.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
          { duration: 180, easing: 'cubic-bezier(.16,1,.3,1)' },
        )
      }
    }
    positionsRef.current = new Map()
  }, [prefs.order])

  const moveGroup = (from: GroupId, to: GroupId) => {
    if (from === to) return
    capturePositions()
    setPrefs((p) => {
      const order = [...p.order]
      const fromIndex = order.indexOf(from)
      const toIndex = order.indexOf(to)
      if (fromIndex < 0 || toIndex < 0) return p
      order.splice(fromIndex, 1)
      order.splice(toIndex, 0, from)
      return { ...p, order }
    })
  }

  const toggleGroup = (id: GroupId) => {
    setPrefs((p) => ({
      ...p,
      hidden: p.hidden.includes(id) ? p.hidden.filter((x) => x !== id) : [...p.hidden, id],
    }))
  }

  const copyCwd = async () => {
    if (!summary?.cwd) return
    if (await copyText(summary.cwd)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } else {
      toast('复制失败', 'error')
    }
  }

  const onDelete = async () => {
    if (!hostId || !sessionId || !summary || deleting) return
    setDeleting(true)
    try {
      await deleteSession(hostId, sessionId, dirtyWorktree)
      setConfirmDelete(false)
      setDirtyWorktree(false)
    } catch (err) {
      if ((err instanceof ApiError && err.status === 409) || (err instanceof Error && /未提交改动/.test(err.message))) {
        setDirtyWorktree(true)
      } else {
        toast(err instanceof Error ? err.message : '删除会话失败', 'error')
      }
    } finally {
      setDeleting(false)
    }
  }

  const planStatus = plan
    ? plan.status === 'approved'
      ? plan.approvalMode === 'acceptEdits'
        ? '已批准 · 自动接受编辑'
        : '已批准 · 逐个询问'
      : plan.status === 'rejected'
        ? '已退回完善'
        : '待批准'
    : ''

  const renderRight = (id: GroupId) => {
    if (id === 'plan') {
      return (
        <span className="flex items-center gap-1 text-[12px] text-muted">
          {planStatus}
          <IconButton
            size="sm"
            onClick={() => setPlanOpen(true)}
            label="查看计划全文"
            tooltip="查看全文"
            className="-mr-1 size-6! [&_svg]:size-3"
          >
            <Maximize2 size={12} />
          </IconButton>
        </span>
      )
    }
    if (id === 'agents') {
      return <span className="text-[12px] tabular-nums text-muted">{agentCount}</span>
    }
    if (id === 'todos' && todos.length > 0) {
      return (
        <span className="text-[12px] tabular-nums text-muted">
          {completed}/{todos.length}
        </span>
      )
    }
    if (id === 'changes') {
      return (
        <button
          type="button"
          onClick={() => setChangesOpen(true)}
          className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
        >
          审阅 <ArrowUpRight size={10} />
        </button>
      )
    }
    return null
  }

  const renderBody = (id: GroupId) => {
    if (id === 'plan' && plan) {
      return (
        <div className="max-h-[180px] overflow-y-auto rounded-md border border-border/70 bg-bg/25 px-2.5 py-2 text-[13px] leading-[18px]">
          <Markdown text={plan.content} />
        </div>
      )
    }
    if (id === 'agents') {
      return <AgentsCard />
    }
    if (id === 'context') {
      return <ContextCard />
    }
    if (id === 'todos') {
      if (todos.length === 0) return <p className="text-[12px] text-muted">暂无待办</p>
      return (
        <>
          <div className="mb-2 h-0.5 overflow-hidden rounded-full bg-[var(--t-bg-active)]/60">
            <div
              className="h-full rounded-full bg-[var(--t-text-tertiary)]/70 transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <ul className="space-y-1.5">
            {todos.map((t, i) => {
              const Icon = TODO_ICONS[t.status] ?? Circle
              return (
                <li key={i} className="flex items-start gap-2 text-[12px] leading-[18px]">
                  <Icon
                    size={12}
                    className={cn(
                      'mt-[3px] shrink-0',
                      t.status === 'in_progress' ? 'text-text-secondary' : 'text-muted',
                    )}
                  />
                  <span
                    className={cn(
                      'min-w-0',
                      t.status === 'completed'
                        ? 'text-muted line-through'
                        : t.status === 'in_progress'
                          ? 'text-text'
                          : 'text-text-soft',
                    )}
                  >
                    {t.content}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )
    }
    if (id === 'usage') {
      const hasUsage =
        !!usage &&
        ((usage.inputTokens ?? 0) > 0 ||
          (usage.outputTokens ?? 0) > 0 ||
          (usage.cacheReadTokens ?? 0) > 0 ||
          (usage.cacheWriteTokens ?? 0) > 0 ||
          (usage.costUsd ?? 0) > 0)
      if (!hasUsage) {
        return <p className="text-[12px] leading-4 text-muted">暂无用量</p>
      }
      const cacheRead = usage?.cacheReadTokens ?? 0
      const cacheWrite = usage?.cacheWriteTokens ?? 0
      const inputTotal = (usage?.inputTokens ?? 0) + cacheRead + cacheWrite
      const hitRate = inputTotal > 0 ? cacheRead / inputTotal : undefined
      const stats = [
        { label: '输入', value: formatTokens(usage?.inputTokens ?? 0) },
        { label: '输出', value: formatTokens(usage?.outputTokens ?? 0) },
        { label: '缓存读', value: formatTokens(cacheRead) },
        { label: '缓存写', value: formatTokens(cacheWrite) },
      ]
      return (
        <div>
          <div className="text-[12px] text-muted">总花费</div>
          <div className="mt-0.5 font-mono text-[19px] leading-6 tabular-nums text-text">
            {formatCost(usage?.costUsd)}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
            {stats.map((s) => (
              <div key={s.label} className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="text-[12px] text-muted">{s.label}</span>
                <span className="truncate font-mono text-[13px] tabular-nums text-text-soft">
                  {s.value}
                </span>
              </div>
            ))}
          </div>
          {keyUsage && (
            <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-1.5">
              <span className="shrink-0 text-[12px] text-muted">Key</span>
              <span className="min-w-0 truncate font-mono text-[13px] tabular-nums text-text-soft">
                {keyUsage}
              </span>
            </div>
          )}
          <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-1.5">
            <span className="text-[12px] text-muted">缓存命中率</span>
            <span className="font-mono text-[13px] tabular-nums text-text-soft">
              {hitRate !== undefined ? `${Math.round(hitRate * 100)}%` : '—'}
            </span>
          </div>
        </div>
      )
    }
    if (id === 'changes') {
      return (
        <>
          <div className="mb-1.5 flex items-baseline gap-2 text-[12px] text-text-soft">
            <span className="tabular-nums">{fileChanges.length} 个文件</span>
            <span className="flex-1" />
            <span className="font-mono text-[12px] tabular-nums text-muted">
              +{additions} −{deletions}
            </span>
          </div>
          <div className="space-y-px">
            {fileChanges.slice(0, 4).map((f) => (
              <div key={f.path} className="flex min-w-0 items-center gap-1.5 text-[12px] leading-[17px]">
                <span className="w-2.5 shrink-0 font-mono text-[12px] text-muted">
                  {CHANGE_MARK[f.status] ?? 'M'}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-text-soft" title={f.path}>
                  {f.path}
                </span>
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted">
                  +{f.additions} −{f.deletions}
                </span>
              </div>
            ))}
            {fileChanges.length > 4 && (
              <div className="pt-0.5 text-[12px] text-muted">还有 {fileChanges.length - 4} 个文件</div>
            )}
          </div>
        </>
      )
    }
    return (
      <div className="space-y-0">
        <DetailRow label="模型">
          <span className="font-mono text-[12px]">{summary?.model ?? '—'}</span>
        </DetailRow>
        <DetailRow label="账号">
          {profileName ??
            (summary?.profileId ? (profilesLoaded ? '未知账号' : '加载中…') : '—')}
        </DetailRow>
        <DetailRow label="权限">
          {summary ? PERMISSION_MODE_LABELS[summary.permissionMode] : '—'}
        </DetailRow>
        <DetailRow label="工作目录">
          <span className="flex items-start gap-1">
            <span className="min-w-0 flex-1 break-all font-mono text-[12px] leading-[17px] text-text-soft">
              {summary?.cwd ?? '—'}
            </span>
            {summary?.cwd && (
              <IconButton
                size="sm"
                onClick={copyCwd}
                label="复制工作目录"
                tooltip="复制"
                className="mt-px size-5! shrink-0 opacity-40 hover:opacity-100 [&_svg]:size-3"
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </IconButton>
            )}
          </span>
        </DetailRow>
        {summary?.env?.repoName && (
          <DetailRow label="仓库">
            <span className="flex items-center gap-1">
              <FolderGit2 size={10} className="text-muted" />
              {summary.env.repoName}
            </span>
          </DetailRow>
        )}
        {summary?.env?.branch && (
          <DetailRow label="分支">
            <span className="flex items-center gap-1">
              <GitBranch size={10} className="text-muted" />
              {summary.env.branch}
            </span>
          </DetailRow>
        )}
        {summary?.worktree && (
          <DetailRow label="worktree">
            <span className="block space-y-0.5">
              <span className="flex items-center gap-1 text-text">
                <GitFork size={10} className="text-muted" />
                <span className="font-mono text-[12px]">{summary.worktree.branch}</span>
              </span>
              <span className="block text-[12px] text-muted">
                基于 {summary.worktree.baseBranch}
              </span>
              <span className="block break-all font-mono text-[12px] leading-4 text-muted">
                {summary.worktree.path}
              </span>
            </span>
          </DetailRow>
        )}
        <DetailRow label="Host">
          <span className="flex items-center gap-1.5">
            <ConnectionDot state={hostStatus} />
            <span className="truncate">{host?.name ?? '—'}</span>
          </span>
        </DetailRow>
        <DetailRow label="更新">
          {summary ? (
            <span className="tabular-nums" title={formatTime(summary.updatedAt)}>
              {formatRelative(summary.updatedAt)}
            </span>
          ) : (
            '—'
          )}
        </DetailRow>
        <DetailRow label="创建">
          {summary ? (
            <span className="tabular-nums" title={formatTime(summary.createdAt)}>
              {formatRelative(summary.createdAt)}
            </span>
          ) : (
            '—'
          )}
        </DetailRow>
      </div>
    )
  }

  return (
    <aside className="flex h-full w-full flex-col border-l border-border bg-sidebar md:w-[300px]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3.5">
        <h2 className="text-[13px] font-semibold">会话信息</h2>
        {summary && (
          <span className="flex items-center gap-1.5 text-[12px] text-muted">
            <SessionStatusDot status={summary.status} />
            {STATUS_TEXT[summary.status] ?? summary.status}
          </span>
        )}
        <span className="flex-1" />
        <Menu
          side="bottom"
          align="end"
          aria-label="显示分组"
          className="w-[200px]"
          trigger={({ open }) => (
            <IconButton
              label="自定义信息面板"
              tooltip={open ? '' : '自定义'}
              aria-expanded={open}
              aria-haspopup="menu"
              className={cn('-mr-0.5 max-md:size-11', open && 'bg-[var(--t-bg-active)] text-text')}
            >
              <MoreHorizontal size={15} />
            </IconButton>
          )}
        >
          {GROUPS.map((g) => {
            const shown = !prefs.hidden.includes(g.id)
            const avail = available[g.id]
            const reason = avail
              ? undefined
              : g.id === 'plan'
                ? '当前会话没有计划'
                : g.id === 'agents'
                  ? '当前会话没有子代理'
                  : g.id === 'changes'
                    ? changes && !changes.isRepo
                      ? '非 git 仓库，无改动摘要'
                      : '当前没有改动'
                    : '暂无数据'
            return (
              <Menu.CheckItem
                key={g.id}
                icon={<g.Icon />}
                checked={shown}
                disabled={!avail}
                disabledReason={reason}
                onCheckedChange={() => toggleGroup(g.id)}
              >
                {g.label}
              </Menu.CheckItem>
            )
          })}
        </Menu>
        <IconButton onClick={onClose} label="关闭信息面板" className="-mr-1 max-md:size-11">
          <X size={15} />
        </IconButton>
      </div>

      <div
        className="min-h-0 flex-1 space-y-2 overflow-x-hidden overflow-y-auto p-3"
        onDragOver={(e) => {
          if (dragging) e.preventDefault()
        }}
      >
        {visibleGroups.map((id) => {
          const meta = GROUP_META[id]
          return (
            <Card
              key={id}
              id={id}
              label={meta.label}
              icon={meta.Icon}
              dragging={dragging === id}
              activeHandle={dragArmed === id}
              cardRef={(el) => {
                if (el) cardRefs.current.set(id, el)
                else cardRefs.current.delete(id)
              }}
              onHandleDown={() => {
                handleDownRef.current = true
                setDragArmed(id)
              }}
              onHandleUp={() => {
                handleDownRef.current = false
                setDragArmed(null)
              }}
              onDragStart={(e) => {
                if (!handleDownRef.current) {
                  e.preventDefault()
                  return
                }
                setDragging(id)
                lastTargetRef.current = null
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', id)
              }}
              onDragEnd={() => {
                handleDownRef.current = false
                setDragArmed(null)
                setDragging(null)
                lastTargetRef.current = null
              }}
              onDragOver={(e) => {
                if (!dragging || dragging === id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (lastTargetRef.current === id) return
                lastTargetRef.current = id
                moveGroup(dragging, id)
              }}
              right={renderRight(id)}
            >
              {renderBody(id)}
            </Card>
          )
        })}

        {visibleGroups.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-[13px] leading-5 text-muted">
            <Info size={15} />
            所有分组已隐藏，点击右上角 ⋯ 恢复显示。
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-4 py-2.5">
        <Button
          size="sm"
          variant="danger-ghost"
          onClick={() => {
            setDirtyWorktree(false)
            setConfirmDelete(true)
          }}
          disabled={deleting || !summary}
          className="px-1 text-[12px] [&_svg]:size-3"
        >
          {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          删除会话
        </Button>
      </div>

      <Modal
        open={planOpen && !!plan}
        onClose={() => setPlanOpen(false)}
        title="当前计划"
        description={plan?.status === 'approved' ? '计划已批准，可随时回看。' : undefined}
        className="max-w-[min(820px,94vw)]"
        bodyClassName="p-5"
        footer={
          <Button size="lg" onClick={() => setPlanOpen(false)}>
            关闭
          </Button>
        }
      >
        {plan && <Markdown text={plan.content} />}
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={dirtyWorktree ? 'worktree 有未提交改动' : '删除会话'}
        className="max-w-md"
        footer={
          <>
            <Button size="lg" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              取消
            </Button>
            <Button
              size="lg"
              variant="danger-ghost"
              onClick={() => void onDelete()}
              disabled={deleting}
            >
              {deleting && <Loader2 size={14} className="animate-spin" />}
              {dirtyWorktree ? '仍然删除' : '删除'}
            </Button>
          </>
        }
      >
        {dirtyWorktree ? (
          <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[12px] leading-5 text-danger">
            <span className="min-w-0 flex-1">
              有未提交改动，仍然删除？worktree 目录与分支会被一并清除，改动将无法恢复。
            </span>
          </div>
        ) : (
          <p className="text-[13px] leading-6 text-text-soft">
            确定删除「{summary?.title || '未命名会话'}」？该操作不可撤销。
          </p>
        )}
      </Modal>
    </aside>
  )
}
