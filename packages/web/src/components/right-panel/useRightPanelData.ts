import { useEffect, useMemo, useRef, useState } from 'react'
import { countTurns, type MemoryFile, type Todo } from '@tandem/protocol'
import type { SubagentSession, UiMessage } from '../../lib/types'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { useSessionChanges } from '../../lib/useChanges'
import { useCopy } from '../../lib/useCopy'
import { api } from '../../lib/api'
import { useIsMobile } from '../../lib/hooks'
import { stripMemoryMeta } from '../../lib/memory'
import { useContextBreakdown } from '../chat/ContextMeter'
import { rememberWikiHost, useWikiStore } from '../../store/useWikiStore'
import { loadCollapsedGroups, loadPanelWidth, usePanelGroups, type GroupId } from './shared'

const EMPTY_TODOS: Todo[] = []
const EMPTY_MESSAGES: UiMessage[] = []

export function useRightPanelData() {
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
  return {
    isMobile,
    panelWidth,
    setPanelWidth,
    dragWidth,
    setDragWidth,
    sessionId,
    summary,
    todos,
    plan,
    agentCount,
    turnCount,
    forkCount,
    openSettings,
    host,
    hostStatus,
    profileName,
    profilesLoaded,
    profilesLoading,
    setChangesOpen,
    openWiki,
    copied,
    copy,
    prefs,
    planOpen,
    setPlanOpen,
    graphExpanded,
    setGraphExpanded,
    collapsedGroups,
    setCollapsedGroups,
    dragging,
    setDragging,
    handleDownRef,
    lastTargetRef,
    cardRefs,
    positionsRef,
    asideRef,
    visibilityLayoutRef,
    visibleIdsRef,
    orderKeyRef,
    sessionKeyRef,
    mountedRef,
    openMemoryEditor,
    memory,
    memoryLoading,
    memoryPreview,
    completed,
    progress,
    usage,
    reviewUsage,
    subUsage,
    keyUsage,
    fileChanges,
    additions,
    deletions,
    contextData,
    usageHasData,
    memoryHasData,
    wikiEntry,
    wikiHasData,
    hasData,
    visibleGroups,
    visibleKey,
    orderKey,
  }
}
