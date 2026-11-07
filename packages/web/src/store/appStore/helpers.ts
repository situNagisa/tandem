import type { Message, Session, SessionSummary } from '@tandem/protocol'
import type { HostConnection } from '../../lib/ws'
import { paneKey } from '../../lib/split'
import type {
  ActiveSession,
  AppRoute,
  HostRuntime,
  SubagentSession,
  ToolResultBlock,
} from '../../lib/types'
import { useUiStore } from '../useUiStore'

export const connections = new Map<string, HostConnection>()
export const commandsInFlight = new Set<string>()
/** 当前主会话已订阅的子代理会话，避免重复 subscribe 触发快照。 */
export const childSubscriptions = new Map<string, Set<string>>()

export function viewKeyOf(hostId: string, sessionId: string): string {
  return paneKey(hostId, sessionId)
}

export function matchesView(
  view: { hostId: string; sessionId: string } | null | undefined,
  hostId: string,
  sessionId: string,
): boolean {
  return !!view && view.hostId === hostId && view.sessionId === sessionId
}

export function emptyActiveSession(
  hostId: string,
  sessionId: string,
  summary: SessionSummary | null = null,
): ActiveSession {
  return {
    hostId,
    sessionId,
    summary,
    messages: [],
    pending: [],
    todos: [],
    loading: true,
    running: summary ? isRunningStatus(summary.status) : false,
    stopping: false,
    liveToolInputs: {},
    toolResults: {},
    hookEvents: [],
    subagents: {},
    viewers: [],
  }
}

export function emptySubagent(summary: SessionSummary | null = null): SubagentSession {
  return {
    summary,
    messages: [],
    pending: [],
    loading: true,
    running: summary ? isRunningStatus(summary.status) : false,
    liveToolInputs: {},
    toolResults: {},
  }
}

export function summaryOf(s: Session): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    profileId: s.profileId,
    ...(s.groupId ? { groupId: s.groupId } : {}),
    model: s.model,
    permissionMode: s.permissionMode,
    status: s.status,
    ...(s.retryInfo ? { retryInfo: { ...s.retryInfo } } : {}),
    ...(s.resumePaused ? { resumePaused: true as const } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
    ...(s.delegation ? { delegation: s.delegation } : {}),
    ...(s.pinned ? { pinned: true } : {}),
    ...(s.pinnedTurns && s.pinnedTurns.length ? { pinnedTurns: [...s.pinnedTurns] } : {}),
    ...(s.forkedFrom ? { forkedFrom: { ...s.forkedFrom } } : {}),
    ...(s.archived ? { archived: true } : {}),
    ...(s.env ? { env: s.env } : {}),
    ...(s.parentId ? { parentId: s.parentId } : {}),
    ...(typeof s.depth === 'number' ? { depth: s.depth } : {}),
    ...(s.worktree ? { worktree: s.worktree } : {}),
    ...(s.scheduledBy ? { scheduledBy: { ...s.scheduledBy } } : {}),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    usage: s.usage,
    ...(s.context ? { context: s.context } : {}),
    ...(s.handoff ? { handoff: s.handoff } : {}),
    ...(s.quota ? { quota: s.quota } : {}),
    ...(typeof s.secretsCount === 'number' ? { secretsCount: s.secretsCount } : {}),
  }
}

export function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

export function freshRuntime(): HostRuntime {
  return {
    status: 'connecting',
    profiles: [],
    profilesLoaded: false,
    profilesLoading: false,
    sessions: [],
    sessionsLoaded: false,
    sessionsLoading: false,
    commands: [],
    commandsLoaded: false,
    externalSessions: [],
    externalLoaded: false,
    externalLoading: false,
  }
}

export function sortSessions(list: SessionSummary[]): SessionSummary[] {
  return list.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

export function isRunningStatus(status: SessionSummary['status']): boolean {
  return status === 'running' || status === 'waiting_permission' || status === 'retrying'
}

/** 旧数据没有 depth 时沿 parentId 链推算。 */
export function depthOf(summary: SessionSummary, sessions: SessionSummary[]): number {
  if (typeof summary.depth === 'number') return summary.depth
  let depth = 0
  let cursor: SessionSummary | undefined = summary
  const seen = new Set<string>([summary.id])
  while (cursor?.parentId && !seen.has(cursor.parentId)) {
    seen.add(cursor.parentId)
    depth++
    cursor = sessions.find((s) => s.id === cursor!.parentId)
  }
  return depth
}

/** summary 是否位于 rootId 之后（不含 root 本身）。 */
export function isDescendantSummary(
  sessions: SessionSummary[],
  summary: SessionSummary,
  rootId: string,
): boolean {
  let cursor: SessionSummary | undefined = summary
  const seen = new Set<string>([summary.id])
  while (cursor?.parentId && !seen.has(cursor.parentId)) {
    if (cursor.parentId === rootId) return true
    seen.add(cursor.parentId)
    cursor = sessions.find((s) => s.id === cursor!.parentId)
  }
  return false
}

export function collectToolResults(
  messages: Message[],
  base: Record<string, ToolResultBlock> = {},
): Record<string, ToolResultBlock> {
  const map: Record<string, ToolResultBlock> = { ...base }
  for (const m of messages) {
    for (const block of m.content) {
      if (block.type === 'tool_result') map[block.toolUseId] = block
    }
  }
  return map
}

export function hostHashFor(hostId: string | null): AppRoute {
  return hostId ? { kind: 'host', hostId } : { kind: 'home' }
}

export function toast(
  text: string,
  kind: 'info' | 'success' | 'error' = 'info',
  options?: { onClick?: () => void; actionLabel?: string },
): void {
  useUiStore.getState().toast(text, kind, options)
}

export function appendSummary(list: SessionSummary[], summary: SessionSummary): SessionSummary[] {
  const idx = list.findIndex((s) => s.id === summary.id)
  if (idx < 0) return sortSessions([...list, summary])
  const next = list.slice()
  next[idx] = summary
  return sortSessions(next)
}
