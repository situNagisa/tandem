import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUpRight,
  BarChart3,
  Bot,
  Brain,
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
  KeyRound,
  ListTodo,
  Maximize2,
  ScrollText,
} from 'lucide-react'
import { Spinner } from './ui/Spinner'
import type { MemoryFile, Todo } from '@tandem/protocol'
import { countTurns } from '@tandem/protocol'
import type { SubagentSession, UiMessage } from '../lib/types'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useSessionChanges } from '../lib/useChanges'
import { cn } from '../lib/cn'
import { useCopy } from '../lib/useCopy'
import { api } from '../lib/api'
import { useIsMobile, useNow } from '../lib/hooks'
import { prettyModel } from '../lib/modelName'
import { runningSince } from '../lib/runClock'
import {
  formatCost,
  formatElapsed,
  formatRelative,
  formatTime,
  formatTokens,
} from '../lib/format'
import { PERMISSION_MODE_LABELS } from '../lib/types'
import { quotaLine } from '../lib/quota'
import { stripMemoryMeta } from '../lib/memory'
import { ConnectionDot } from './StatusDot'
import { Markdown } from './Markdown'
import { useContextBreakdown } from './chat/ContextMeter'
import { Modal } from './ui/Modal'
import { Menu } from './ui/Menu'
import { Button, IconButton } from './ui/Button'
import { PanelBody } from './ui/Panel'
import { ResizeHandle } from './ui/ResizeHandle'
import { rememberWikiHost, useWikiStore } from '../store/useWikiStore'

const EMPTY_TODOS: Todo[] = []
const EMPTY_MESSAGES: UiMessage[] = []

const TODO_ICONS = {
  completed: CircleCheck,
  in_progress: CircleDot,
  pending: Circle,
} as const
import {
  CHANGE_MARK,
  Card,
  DetailRow,
  GROUP_META,
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  loadCollapsedGroups,
  loadPanelWidth,
  saveCollapsedGroups,
  savePanelWidth,
  setPanelAvailability,
  setPanelPrefs,
  usePanelGroups,
  type GroupId,
} from './right-panel/shared'
import { AgentsCard } from './right-panel/AgentsCard'
import { ContextCard } from './right-panel/ContextCard'
import { WikiCard } from './right-panel/WikiCard'
import { SessionGraphCard } from './sessionGraph/SessionGraphCard'

export function RightPanel() {
  const isMobile = useIsMobile()
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const messages = useAppStore((s) => s.active?.messages ?? EMPTY_MESSAGES)
  const profiles = useAppStore((s) => (hostId ? s.runtimes[hostId]?.profiles : undefined))
  const todos = useAppStore((s) => s.active?.todos ?? EMPTY_TODOS)
  const plan = useAppStore((s) => s.active?.plan ?? null)
  const subagents = useAppStore((s) => s.active?.subagents)
  const agentCount = subagents ? Object.keys(subagents).length : 0
  const hostSessions = useAppStore((s) => (hostId ? s.runtimes[hostId]?.sessions : undefined))
  const turnCount = useMemo(() => countTurns(messages), [messages])
  const forkCount = useMemo(
    () =>
      sessionId && hostSessions
        ? hostSessions.filter((item) => item.forkedFrom?.sessionId === sessionId).length
        : 0,
    [hostSessions, sessionId],
  )
  const changesNonce = useAppStore((s) => s.changesNonce)
  const openSettings = useUiStore((s) => s.openSettings)
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
  const toast = useUiStore((s) => s.toast)
  const setChangesOpen = useUiStore((s) => s.setChangesOpen)
  const openWiki = useUiStore((s) => s.openWiki)
  const { copied, copy } = useCopy({ onError: () => toast('复制失败', 'error') })
  const [planOpen, setPlanOpen] = useState(false)
  const [graphExpanded, setGraphExpanded] = useState(false)
  const { prefs } = usePanelGroups()
  const [collapsedGroups, setCollapsedGroups] = useState<GroupId[]>(loadCollapsedGroups)
  const [dragging, setDragging] = useState<GroupId | null>(null)
  const handleDownRef = useRef(false)
  const lastTargetRef = useRef<GroupId | null>(null)
  const cardRefs = useRef(new Map<GroupId, HTMLElement>())
  const positionsRef = useRef(new Map<GroupId, number>())
  const asideRef = useRef<HTMLElement>(null)
  // 分组随数据出现/消失时的滚动锚点：插入不推挤用户正在看的位置（反馈9#06）。
  const visibilityLayoutRef = useRef(new Map<GroupId, number>())
  const visibleIdsRef = useRef(new Set<GroupId>())
  const orderKeyRef = useRef('')
  const sessionKeyRef = useRef(sessionId)
  const mountedRef = useRef(false)
  const { changes } = useSessionChanges(host, sessionId, changesNonce, !!sessionId)
  const memoryEditorOpen = useUiStore((s) => !!s.memoryEditor)
  const openMemoryEditor = useUiStore((s) => s.openMemoryEditor)
  const [memory, setMemory] = useState<MemoryFile | null>(null)
  const [memoryLoading, setMemoryLoading] = useState(false)
  // 工具写入记忆后刷新卡片（messages 中 Memory 调用数变化）
  const memoryToolCalls = useMemo(
    () =>
      messages.reduce(
        (n, message) =>
          n + message.content.filter((b) => b.type === 'tool_use' && b.name === 'Memory').length,
        0,
      ),
    [messages],
  )
  const teamRole = useAppStore((s) =>
    s.active?.hostId ? s.runtimes[s.active.hostId]?.team?.role : undefined,
  )
  useEffect(() => {
    if (!host || !summary?.cwd || teamRole !== 'owner') {
      setMemory(null)
      return
    }
    let cancelled = false
    setMemoryLoading(true)
    api
      .memory(host, 'project', summary.cwd)
      .then((file) => {
        if (!cancelled) setMemory(file)
      })
      .catch(() => {
        if (!cancelled) setMemory(null)
      })
      .finally(() => {
        if (!cancelled) setMemoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, summary?.cwd, memoryToolCalls, memoryEditorOpen, teamRole])
  const memoryPreview = useMemo(() => {
    if (!memory?.exists) return []
    const body = stripMemoryMeta(memory.text)
    return body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+\S/.test(line))
      .slice(0, 3)
      .map((line) => line.replace(/^[-*]\s+/, ''))
  }, [memory])

  const completed = todos.filter((t) => t.status === 'completed').length
  const progress = todos.length ? Math.round((completed / todos.length) * 100) : 0
  const usage = summary?.usage
  const reviewUsage = summary?.aiReviewUsage
  const subUsage = useMemo(() => {
    const list = Object.values(subagents ?? {})
      .map((sub) => sub.summary)
      .filter((item): item is NonNullable<typeof item> => !!item)
    const byModel = new Map<string, { cost: number; tokens: number }>()
    let cost = 0
    let tokens = 0
    for (const item of list) {
      const itemCost = item.usage.costUsd ?? 0
      const itemTokens = item.usage.inputTokens + item.usage.outputTokens
      cost += itemCost
      tokens += itemTokens
      const entry = byModel.get(item.model) ?? { cost: 0, tokens: 0 }
      entry.cost += itemCost
      entry.tokens += itemTokens
      byModel.set(item.model, entry)
    }
    return { count: list.length, cost, tokens, byModel: [...byModel.entries()] }
  }, [subagents])
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
  const contextData = useContextBreakdown()
  const usageHasData =
    subUsage.count > 0 ||
    (!!usage &&
      ((usage.inputTokens ?? 0) > 0 ||
        (usage.outputTokens ?? 0) > 0 ||
        (usage.cacheReadTokens ?? 0) > 0 ||
        (usage.cacheWriteTokens ?? 0) > 0 ||
        (usage.costUsd ?? 0) > 0)) ||
    !!reviewUsage
  const memoryHasData =
    !!memory?.exists && ((memory.entries ?? 0) > 0 || memoryPreview.length > 0)
  // Wiki 数据由 WikiCard 自己拉；分组默认隐藏，需要面板层先取一次元数据才知道有没有内容。
  const wikiProject = summary?.env?.repoRoot || summary?.cwd || ''
  const wikiKey = host && wikiProject ? `${host.id}\u0000${wikiProject}` : ''
  const wikiEntry = useWikiStore((s) => (wikiKey ? s.entries[wikiKey] : undefined))
  const refreshWiki = useWikiStore((s) => s.refresh)
  useEffect(() => {
    if (!host || !wikiProject || wikiEntry) return
    rememberWikiHost(host)
    void refreshWiki(host, wikiProject)
  }, [host, wikiProject, wikiEntry, refreshWiki])
  const wikiHasData =
    !!wikiEntry &&
    ((wikiEntry.meta?.exists === true && (wikiEntry.meta.pages?.length ?? 0) > 0) ||
      wikiEntry.jobs.some((job) => job.status === 'running'))

  const hasData = useMemo<Record<GroupId, boolean>>(
    () => ({
      plan: !!plan,
      todos: todos.length > 0,
      agents: agentCount > 0,
      graph: turnCount > 0,
      usage: usageHasData,
      context: !contextData.noData,
      changes: fileChanges.length > 0,
      memory: memoryHasData,
      wiki: wikiHasData,
      details: true,
    }),
    [
      plan,
      todos.length,
      agentCount,
      turnCount,
      usageHasData,
      contextData.noData,
      fileChanges.length,
      memoryHasData,
      wikiHasData,
    ],
  )

  const visibleGroups = prefs.order.filter(
    (id) => !prefs.hidden.includes(id) && (hasData[id] || prefs.shown.includes(id)),
  )
  const visibleKey = visibleGroups.join(',')
  const orderKey = prefs.order.join(',')

  useEffect(() => saveCollapsedGroups(collapsedGroups), [collapsedGroups])
  useEffect(() => setPanelAvailability(hasData), [hasData])
  useEffect(() => setGraphExpanded(false), [sessionId])

  const toggleCollapsed = (id: GroupId) =>
    setCollapsedGroups((list) =>
      list.includes(id) ? list.filter((item) => item !== id) : [...list, id],
    )

  // 收起后的标题行只显示最关键的一行结论（反馈12#07）。
  const cardSummary = (id: GroupId): ReactNode => {
    switch (id) {
      case 'plan':
        return planStatus
      case 'todos':
        return todos.length ? `${completed}/${todos.length}` : '—'
      case 'agents':
        return String(agentCount)
      case 'graph':
        return `${turnCount} 轮 · ${agentCount} 子代理 · ${forkCount} 分叉`
      case 'usage': {
        const total = (usage?.costUsd ?? 0) + subUsage.cost
        return formatCost(total)
      }
      case 'context':
        return contextData.noData
          ? '—'
          : `${formatTokens(contextData.used)} / ${formatTokens(contextData.window)} · ${contextData.pct}%`
      case 'changes':
        return fileChanges.length
          ? `${fileChanges.length} 个文件 · +${additions} −${deletions}`
          : '—'
      case 'memory':
        return `${memory?.entries ?? 0} 条`
      case 'wiki':
        return `${wikiEntry?.meta?.pages?.length ?? 0} 页`
      case 'details':
        return summary?.model ? prettyModel(summary.model) : '—'
      default:
        return null
    }
  }

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

  // 反馈9#06：有数据的分组出现时轻量淡入；若用户正滚动在下方，保持滚动锚点，
  // 不因为上方插入卡片把正在看的内容推走。拖动排序交给上面的 FLIP。
  useLayoutEffect(() => {
    const box = asideRef.current?.querySelector<HTMLElement>('[data-panel-body]')
    if (!box) return
    const first = !mountedRef.current
    const sessionChanged = sessionKeyRef.current !== sessionId
    const orderChanged = orderKeyRef.current !== '' && orderKeyRef.current !== orderKey
    const prev = visibilityLayoutRef.current
    const seen = visibleIdsRef.current
    const added: HTMLElement[] = []
    let anchorDelta = 0
    if (!first && !sessionChanged && !orderChanged) {
      let inside: { before: number; el: HTMLElement } | null = null
      for (const id of visibleGroups) {
        const el = cardRefs.current.get(id)
        if (!el) continue
        const before = prev.get(id)
        if (before === undefined) {
          if (!seen.has(id)) added.push(el)
          continue
        }
        if (before >= box.scrollTop - 1) {
          anchorDelta = el.offsetTop - before
          break
        }
        inside = { before, el }
      }
      if (anchorDelta === 0 && inside) anchorDelta = inside.el.offsetTop - inside.before
      if (anchorDelta !== 0 && box.scrollTop > 0) {
        box.scrollTop = Math.max(0, box.scrollTop + anchorDelta)
      }
      if (
        added.length > 0 &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        for (const el of added) {
          el.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 180,
            easing: 'cubic-bezier(.16,1,.3,1)',
          })
        }
      }
    }
    visibilityLayoutRef.current = new Map(
      [...cardRefs.current].map(([id, el]) => [id, el.offsetTop]),
    )
    visibleIdsRef.current = new Set(visibleGroups)
    orderKeyRef.current = orderKey
    sessionKeyRef.current = sessionId
    mountedRef.current = true
  }, [visibleKey, orderKey, sessionId])

  // 卡片内容高度变化（数据增长、展开明细）后刷新基线，下一次插入/删除才只按增量补偿。
  useLayoutEffect(() => {
    visibilityLayoutRef.current = new Map(
      [...cardRefs.current].map(([id, el]) => [id, el.offsetTop]),
    )
  })

  const moveGroup = (from: GroupId, to: GroupId) => {
    if (from === to) return
    capturePositions()
    const order = [...prefs.order]
    const fromIndex = order.indexOf(from)
    const toIndex = order.indexOf(to)
    if (fromIndex < 0 || toIndex < 0) return
    order.splice(fromIndex, 1)
    order.splice(toIndex, 0, from)
    setPanelPrefs({ ...prefs, order })
  }


  const copyCwd = () => {
    if (summary?.cwd) void copy(summary.cwd)
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
    if (id === 'graph') {
      return (
        <IconButton
          size="sm"
          onClick={() => setGraphExpanded(true)}
          label="全高显示会话图"
          tooltip="展开"
          className="-mr-1 size-6! [&_svg]:size-3"
        >
          <Maximize2 size={12} />
        </IconButton>
      )
    }
    if (id === 'todos' && todos.length > 0) {
      return (
        <span className="text-[12px] tabular-nums text-muted">
          {completed}/{todos.length}
        </span>
      )
    }
    if (id === 'memory') {
      return (
        <button
          type="button"
          onClick={() => summary?.cwd && openMemoryEditor({ scope: 'project', project: summary.cwd })}
          disabled={!summary?.cwd}
          className="rounded px-1 py-0.5 text-[12px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:opacity-50"
        >
          编辑
        </button>
      )
    }
    if (id === 'wiki') {
      return (
        <button
          type="button"
          onClick={() => summary?.cwd && openWiki({ project: summary.env?.repoRoot || summary.cwd })}
          disabled={!summary?.cwd}
          className="rounded px-1 py-0.5 text-[12px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:opacity-50"
        >
          浏览
        </button>
      )
    }
    if (id === 'changes') {
      return (
        <button
          type="button"
          onClick={() => setChangesOpen(true)}
          className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[12px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
        >
          审阅 <ArrowUpRight size={10} />
        </button>
      )
    }
    return null
  }

  const renderBody = (id: GroupId) => {
    if (id === 'memory') {
      if (memoryLoading && !memory) {
        return (
          <p className="flex items-center gap-1.5 text-[12px] text-muted">
            <Spinner size={11} /> 读取中…
          </p>
        )
      }
      return (
        <div>
          {memoryPreview.length > 0 ? (
            <ul className="space-y-1 text-[12px] leading-[18px] text-text-soft">
              {memoryPreview.map((line, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--t-text-tertiary)]" />
                  <span className="min-w-0 truncate">{line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] leading-4 text-muted">
              暂无记忆。输入「#记住 …」或让 agent 记录长期事实。
            </p>
          )}
          <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-1.5 text-[12px]">
            <span className="text-muted">共 {memory?.entries ?? 0} 条</span>
            <button
              type="button"
              onClick={() => openMemoryEditor({ scope: 'global' })}
              className="rounded px-1 py-0.5 text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
            >
              全局记忆
            </button>
          </div>
        </div>
      )
    }
    if (id === 'plan') {
      if (!plan) return <p className="text-[12px] text-muted">暂无计划</p>
      return (
        <div className="max-h-[180px] overflow-y-auto rounded-md border border-border/70 bg-bg/25 px-2.5 py-2 text-[13px] leading-[18px]">
          <Markdown text={plan.content} />
        </div>
      )
    }
    if (id === 'agents') {
      return <AgentsCard />
    }
    if (id === 'graph') {
      return <SessionGraphCard />
    }
    if (id === 'wiki') {
      return <WikiCard />
    }
    if (id === 'context') {
      return <ContextCard data={contextData} />
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
      if (!usageHasData) {
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
      const quota = quotaLine(summary?.quota)
      return (
        <div>
          <div className="text-[12px] text-muted">总花费</div>
          <div className="mt-0.5 font-mono text-[19px] leading-6 tabular-nums text-text">
            {formatCost(usage?.costUsd)}
          </div>
          {summary?.autoRoute && (summary.routeSavings?.savedUsd ?? 0) > 0 && (
            <div className="mt-1 text-[12px] leading-4 text-muted" data-route-savings>
              自动路由节省约 {formatCost(summary.routeSavings?.savedUsd)}
              {summary.routeSavings?.baselineModel
                ? `（对比全程使用强力档 ${prettyModel(summary.routeSavings.baselineModel)}）`
                : '（对比全程使用强力档）'}
            </div>
          )}
          {summary?.routeSavings?.byRole && (
            <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[12px] leading-4 text-muted" data-route-roles>
              {Object.entries(summary.routeSavings.byRole).map(([role, value]) => (
                <span key={role}>
                  {role === 'planner'
                    ? '规划'
                    : role === 'executor'
                      ? '执行'
                      : role === 'specialist'
                        ? '专长'
                        : '审查'}{' '}
                  {formatCost(value.costUsd)}
                  {value.savedUsd > 0 ? ` · 省 ${formatCost(value.savedUsd)}` : ''}
                </span>
              ))}
            </div>
          )}
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
          {quota && (
            <div
              className="mt-2 border-t border-border pt-1.5 text-[12px] leading-4 text-muted"
              data-quota-line="usage"
            >
              {quota}
            </div>
          )}
          {subUsage.count > 0 && (
            <div className="mt-2 space-y-1 border-t border-border pt-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] text-muted">
                  子代理（{subUsage.count}）
                </span>
                <span className="font-mono text-[13px] tabular-nums text-text-soft">
                  {formatCost(subUsage.cost)} · {formatTokens(subUsage.tokens)} tok
                </span>
              </div>
              {subUsage.byModel.map(([model, item]) => (
                <div key={model} className="flex min-w-0 items-baseline justify-between gap-2 pl-2">
                  <span className="min-w-0 truncate font-mono text-[12px] text-muted" data-tip={model}>
                    {model}
                  </span>
                  <span className="shrink-0 font-mono text-[12px] tabular-nums text-muted">
                    {formatCost(item.cost)}
                  </span>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] text-muted">合计</span>
                <span className="font-mono text-[13px] tabular-nums text-text">
                  {formatCost((usage?.costUsd ?? 0) + subUsage.cost)}
                </span>
              </div>
            </div>
          )}
          {reviewUsage && (
            <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border pt-1.5">
              <span className="text-[12px] text-muted">AI 评审</span>
              <span className="font-mono text-[13px] tabular-nums text-text-soft">
                {formatCost(reviewUsage.costUsd)} ·{' '}
                {formatTokens(reviewUsage.inputTokens + reviewUsage.outputTokens)} tok
              </span>
            </div>
          )}
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
      if (fileChanges.length === 0) {
        return <p className="text-[12px] leading-4 text-muted">暂无改动</p>
      }
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
                <span className="min-w-0 flex-1 truncate font-mono text-text-soft" data-tip={f.path}>
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
          <span className="font-mono text-[12px]">
            {summary?.autoRoute
              ? `自动 · ${summary.route?.model ?? summary.model ?? '—'}`
              : (summary?.model ?? '—')}
          </span>
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
        <DetailRow label="Secrets">
          <button
            type="button"
            onClick={() => openSettings('secrets')}
            className="flex items-center gap-1 rounded px-1 py-0.5 text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
            data-tip="打开设置 → Secrets"
          >
            <KeyRound size={10} className="text-muted" />
            {summary?.secretsCount ? `${summary.secretsCount} 个可用` : '未配置'}
            <ArrowUpRight size={10} className="text-muted" />
          </button>
        </DetailRow>
        <DetailRow label="主机">
          <span className="flex items-center gap-1.5">
            <ConnectionDot state={hostStatus} />
            <span className="truncate">{host?.name ?? '—'}</span>
          </span>
        </DetailRow>
        <DetailRow label="更新">
          {summary ? (
            <span className="tabular-nums" data-tip={formatTime(summary.updatedAt)}>
              {formatRelative(summary.updatedAt)}
            </span>
          ) : (
            '—'
          )}
        </DetailRow>
        <DetailRow label="创建">
          {summary ? (
            <span className="tabular-nums" data-tip={formatTime(summary.createdAt)}>
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
    <aside
      ref={asideRef}
      className="relative flex h-full min-h-0 flex-col border-l border-border bg-sidebar"
      style={{
        width: isMobile ? '100%' : (dragWidth ?? panelWidth),
        transition: dragWidth !== null ? 'none' : undefined,
      }}
    >
      {!isMobile && (
        <ResizeHandle
          value={panelWidth}
          min={PANEL_WIDTH_MIN}
          max={PANEL_WIDTH_MAX}
          edge="left"
          onChange={setDragWidth}
          onCommit={(next) => {
            setPanelWidth(next)
            savePanelWidth(next)
            setDragWidth(null)
          }}
          resetValue={PANEL_WIDTH_DEFAULT}
          label="调整会话信息面板宽度"
        />
      )}

      {graphExpanded ? (
        <div className="flex min-h-0 flex-1 flex-col px-3 pb-7 pt-2" data-graph-full>
          <SessionGraphCard full onBack={() => setGraphExpanded(false)} />
        </div>
      ) : (
      <PanelBody scroll className="space-y-2 p-3"
        style={{ overflowAnchor: 'none', scrollbarGutter: 'stable' }}
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
              cardRef={(el) => {
                if (el) cardRefs.current.set(id, el)
                else cardRefs.current.delete(id)
              }}
              onHandleDown={() => {
                handleDownRef.current = true
              }}
              onHandleUp={() => {
                handleDownRef.current = false
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
              collapsible
              collapsed={collapsedGroups.includes(id)}
              onToggle={() => toggleCollapsed(id)}
              summary={cardSummary(id)}
            >
              {renderBody(id)}
            </Card>
          )
        })}

        {visibleGroups.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-[13px] leading-5 text-muted">
            <Info size={15} />
            当前没有可显示的分组；点右上角 ⋯ 勾选要显示的分组（没有数据的分组默认隐藏）。
          </div>
        )}
      </PanelBody>
      )}

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

    </aside>
  )
}

