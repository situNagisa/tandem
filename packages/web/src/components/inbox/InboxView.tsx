import { useEffect, useState } from 'react'
import {
  ArrowRightLeft,
  BellRing,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  GitFork,
  GitPullRequest,
  Inbox,
  Kanban,
  ShieldAlert,
  TriangleAlert,
  Wallet,
  X,
} from 'lucide-react'
import type { InboxEvent, PermissionDecision } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { navigate } from '../../lib/router'
import { navigateBoard } from '../../lib/boardRoute'
import { focusMessage, focusTool } from '../../lib/jump'
import { formatRelative } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Button } from '../ui/Button'
import { AggregateDetailRow, AggregateRow } from '../ui/AggregateRow'

/** 所有主机的未处理数（待审批 + 未读提醒）。 */
export function useInboxCount(): number {
  return useAppStore((s) =>
    Object.values(s.inbox).reduce(
      (sum, entry) => sum + entry.pending.length + Math.max(0, entry.unread - entry.pending.length),
      0,
    ),
  )
}

export function useInboxPendingCount(): number {
  return useAppStore((s) => Object.values(s.inbox).reduce((sum, entry) => sum + entry.pending.length, 0))
}

function hostNameOf(hostId: string): string {
  return useAppStore.getState().hosts.find((h) => h.id === hostId)?.name ?? hostId
}

interface Entry {
  hostId: string
  event: InboxEvent
}

function eventSummary(event: InboxEvent): { title: string; body?: string } {
  const permission = event.permission
  if (event.kind === 'permission' && permission) {
    if (event.plan || permission.toolName === 'ExitPlanMode') {
      const plan = permission.input as { plan?: unknown } | null
      const content = typeof plan?.plan === 'string' ? plan.plan : ''
      const first = content.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
      return {
        title: '计划待批准',
        ...(first ? { body: first.replace(/^#+\s*/, '') } : {}),
      }
    }
    const input = permission.input as { command?: unknown } | null
    return {
      title:
        permission.toolName === 'Bash' && typeof input?.command === 'string'
          ? '运行命令'
          : permission.description || `${permission.toolName} 请求权限`,
      body: event.sourceTitle
        ? `来自子代理「${event.sourceTitle}」`
        : undefined,
    }
  }
  if (event.kind === 'permission_resolved') {
    const name = permission?.toolName ?? '审批'
    return {
      title: event.decision === 'deny' ? `已拒绝 · ${name}` : `已允许 · ${name}`,
    }
  }
  if (event.kind === 'division_plan' && event.divisionPlan) {
    return {
      title: '分工计划待确认',
      body: `${event.divisionPlan.tasks.length} 个子任务 · 预计 $${event.divisionPlan.estimatedCostUsd.toFixed(4)}`,
    }
  }
  if (event.kind === 'turn_end') {
    if (event.turnReason === 'error') {
      return { title: '回合出错', body: event.error ?? '执行失败' }
    }
    return { title: event.turnReason === 'interrupted' ? '回合已停止' : '回合完成' }
  }
  if (event.kind === 'budget') {
    return { title: '预算提醒', body: event.budgetText ?? '' }
  }
  if (event.kind === 'handoff' && event.handoff) {
    return { title: '额度交接', body: event.handoff.text }
  }
  if (event.kind === 'ci') {
    return { title: event.ci?.text ?? 'PR 状态变化', body: event.ci ? `#${event.ci.prNumber}` : undefined }
  }
  if (event.kind === 'board' && event.board) {
    const info = event.board
    return {
      title: info.cardTitle
        ? `${info.cardTitle} · ${
            info.event === 'review' ? '待评审' : info.event === 'failed' ? '失败' : info.event === 'proposal' ? '提议了后续卡片' : '完成'
          }`
        : `${info.boardName} 已跑完`,
      body: info.text,
    }
  }
  if (event.kind === 'eval') {
    const info = event.eval
    return {
      title:
        info?.status === 'done'
          ? '评测完成'
          : info?.status === 'cancelled'
            ? '评测已取消'
            : '评测运行中',
      body: info?.text,
    }
  }
  return { title: '事件' }
}

/** 审批涉及的具体内容：命令 / 文件路径，避免只看到被截断的一行标题。 */
function permissionPreview(event: InboxEvent): string | undefined {
  const input = event.permission?.input
  if (!input || typeof input !== 'object') return undefined
  const raw = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    if (typeof raw[key] === 'string' && raw[key]) return raw[key] as string
  }
  return undefined
}

interface HistoryGroup {
  key: string
  hostId: string
  sessionId?: string
  sessionTitle?: string
  /** 同一回合内的审批流水（不含回合结束事件本身）。 */
  children: InboxEvent[]
  turnEnd?: InboxEvent
  /** 预算、看板、CI 等独立事件。 */
  single?: InboxEvent
  at: number
  kind: 'turn' | 'event'
}

/**
 * 最近列表按回合聚合：同一会话两次「回合结束」之间的审批流水合并成一条，
 * 回合结束本身作为标题；预算/看板/CI 等仍单列。
 */
function groupHistory(
  hosts: Array<{ id: string }>,
  inbox: Record<string, { events: InboxEvent[]; pending: InboxEvent[] } | undefined>,
): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  for (const host of hosts) {
    const entry = inbox[host.id]
    if (!entry) continue
    const pendingIds = new Set(entry.pending.map((event) => event.requestId).filter(Boolean))
    const events = entry.events
      .filter((event) => !(event.kind === 'permission' && event.requestId && pendingIds.has(event.requestId)))
      .slice()
      .sort((a, b) => a.seq - b.seq)
    const buffers = new Map<string, InboxEvent[]>()
    for (const event of events) {
      if (event.kind === 'permission' || event.kind === 'permission_resolved') {
        const key = event.sessionId ?? ''
        buffers.set(key, [...(buffers.get(key) ?? []), event])
        continue
      }
      if (event.kind === 'turn_end') {
        const key = event.sessionId ?? ''
        const children = buffers.get(key) ?? []
        buffers.delete(key)
        groups.push({
          key: `${host.id}:turn:${event.seq}`,
          hostId: host.id,
          sessionId: event.sessionId,
          sessionTitle: event.sessionTitle,
          children,
          turnEnd: event,
          at: event.at,
          kind: 'turn',
        })
        continue
      }
      groups.push({
        key: `${host.id}:event:${event.seq}`,
        hostId: host.id,
        sessionId: event.sessionId ?? event.budgetSessionId,
        sessionTitle: event.sessionTitle ?? event.budgetSessionTitle,
        children: [],
        single: event,
        at: event.at,
        kind: 'event',
      })
    }
    // 还没有回合结束的审批流水：仍聚成一条，避免逐条刷屏。
    for (const [sessionId, children] of buffers) {
      const last = children.at(-1)
      if (!last) continue
      groups.push({
        key: `${host.id}:open:${sessionId}:${last.seq}`,
        hostId: host.id,
        ...(sessionId ? { sessionId } : {}),
        sessionTitle: last.sessionTitle,
        children,
        at: last.at,
        kind: 'turn',
      })
    }
  }
  // 回合结束/出错排最上面，其余按时间倒序；同组内审批流水默认折叠。
  const rank = (group: HistoryGroup) => (group.turnEnd ? 0 : group.kind === 'turn' ? 1 : 2)
  return groups.sort((a, b) => rank(a) - rank(b) || b.at - a.at)
}

function toolPhrase(toolName: string, count: number): string {
  switch (toolName) {
    case 'Bash':
      return `运行了 ${count} 条命令`
    case 'Edit':
      return `编辑了 ${count} 个文件`
    case 'Write':
      return `新建了 ${count} 个文件`
    case 'Read':
      return `读取了 ${count} 个文件`
    case 'WebFetch':
    case 'WebSearch':
      return `联网查询 ${count} 次`
    default:
      return `${toolName} ${count} 次`
  }
}

function groupSummary(group: HistoryGroup): { title: string; body?: string } {
  if (group.single) return eventSummary(group.single)
  const end = group.turnEnd
  const base = end
    ? end.turnReason === 'error'
      ? '回合出错'
      : end.turnReason === 'interrupted'
        ? '回合已停止'
        : '回合完成'
    : '回合进行中'
  const counts = new Map<string, { allowed: number; denied: number }>()
  for (const event of group.children) {
    if (event.kind !== 'permission_resolved') continue
    const tool = event.permission?.toolName ?? '审批'
    const current = counts.get(tool) ?? { allowed: 0, denied: 0 }
    if (event.decision === 'deny') current.denied += 1
    else current.allowed += 1
    counts.set(tool, current)
  }
  const parts: string[] = []
  for (const [tool, { allowed, denied }] of counts) {
    if (allowed) parts.push(`${toolPhrase(tool, allowed)}（已允许）`)
    if (denied) parts.push(`${toolPhrase(tool, denied)}（已拒绝）`)
  }
  return {
    title: parts.length ? `${base} · ${parts.join('、')}` : base,
    body: end?.turnReason === 'error' ? end.error ?? '执行失败' : undefined,
  }
}

function EventIcon({ event }: { event: InboxEvent }) {
  if (event.kind === 'permission') {
    return event.plan ? <ShieldAlert size={14} /> : <BellRing size={14} />
  }
  if (event.kind === 'division_plan') return <GitFork size={14} />
  if (event.kind === 'permission_resolved') return <Check size={14} />
  if (event.kind === 'budget') return <Wallet size={14} />
  if (event.kind === 'handoff') return <ArrowRightLeft size={14} />
  if (event.kind === 'ci') return <GitPullRequest size={14} />
  if (event.kind === 'eval') return <FlaskConical size={14} />
  if (event.kind === 'board') return <Kanban size={14} />
  if (event.turnReason === 'error') return <TriangleAlert size={14} />
  return <CheckCircle2 size={14} />
}

function PendingCard({ entry }: { entry: Entry }) {
  const decide = useAppStore((s) => s.decideInboxPermission)
  const [descOpen, setDescOpen] = useState(false)
  const { event, hostId } = entry
  const permission = event.permission
  if (!permission) return null
  const isPlan = event.plan || permission.toolName === 'ExitPlanMode'
  const { title, body } = eventSummary(event)
  const preview = permissionPreview(event)
  const open = () => {
    if (!event.sessionId) return
    useUiStore.getState().setInboxOpen(false)
    navigate({ kind: 'session', hostId, sessionId: event.sessionId })
  }
  const submit = (decision: PermissionDecision) => decide(hostId, event.requestId ?? permission.id, decision)

  return (
    <div className="rounded-xl border border-border bg-surface p-3" data-testid="inbox-pending">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md',
            isPlan ? 'bg-accent/15 text-accent-text' : 'bg-[var(--t-bg-active)] text-text-soft',
          )}
        >
          <EventIcon event={event} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium" data-tip={title}>
              {title}
            </span>
            <span className="ml-auto shrink-0 text-[12px] text-muted">
              {formatRelative(event.at)}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted">
            <span className="rounded bg-[var(--t-bg-hover)] px-1.5 py-px text-[12px] text-text-tertiary">
              {hostNameOf(hostId)}
            </span>
            <button
              type="button"
              onClick={() => setDescOpen((value) => !value)}
              aria-expanded={descOpen}
              data-tip={`${event.sessionTitle || '未命名会话'}${descOpen ? '' : '（点击展开全文）'}`}
              className={cn(
                'min-w-0 max-w-full text-left text-text-soft underline-offset-2 hover:text-text hover:underline',
                !descOpen && 'line-clamp-1 max-sm:line-clamp-2',
              )}
            >
              {event.sessionTitle || '未命名会话'}
            </button>
            {event.depth ? <span className="shrink-0 text-[12px]">· 子代理</span> : null}
            {permission.transferredFrom ? (
              <span className="shrink-0 text-[12px] text-accent-text">
                · 由 {permission.transferredFrom.name} 转交
              </span>
            ) : null}
          </div>
          {preview && !body ? (
            <div className="mt-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-[var(--t-bg-hover)] px-2 py-1.5 font-mono text-[12px] leading-5 text-text-soft">
              {preview}
            </div>
          ) : null}
          {body ? (
            <div className="mt-1.5 max-h-20 overflow-hidden whitespace-pre-wrap break-words rounded-md bg-[var(--t-bg-hover)] px-2 py-1.5 font-mono text-[12px] leading-5 text-text-soft">
              {body}
            </div>
          ) : null}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => submit(isPlan ? 'allow_always' : 'allow')}
              className="max-sm:h-11 max-sm:px-4"
            >
              {isPlan ? '批准计划' : '允许'}
            </Button>
            <Button
              size="sm"
              variant="danger-ghost"
              onClick={() => submit('deny')}
              className="max-sm:h-11 max-sm:px-4"
              icon={<X size={13} />}
            >
              拒绝
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={open}
              disabled={!event.sessionId}
              className="ml-auto max-sm:h-11"
            >
              打开会话
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function openGroupTarget(hostId: string, group: HistoryGroup, detail?: InboxEvent) {
  const single = detail ?? group.single
  if (!detail && single?.board) {
    useUiStore.getState().setInboxOpen(false)
    navigateBoard(hostId, single.board.boardId)
    return
  }
  const sessionId =
    detail?.sessionId ?? group.sessionId ?? single?.sessionId ?? single?.budgetSessionId
  if (!sessionId) return
  useUiStore.getState().setInboxOpen(false)
  navigate({ kind: 'session', hostId, sessionId })
  if (detail) {
    if (detail.permission?.toolUseId) focusTool(detail.permission.toolUseId)
    else if (detail.kind === 'turn_end') focusMessage(detail.messageId)
    return
  }
  if (group.turnEnd?.messageId) focusMessage(group.turnEnd.messageId)
}

function HistoryGroupRow({
  group,
  expanded,
  onToggle,
}: {
  group: HistoryGroup
  expanded: boolean
  onToggle: () => void
}) {
  const { title, body } = groupSummary(group)
  const isTurn = group.kind === 'turn'
  const hasDetails = group.children.length > 0
  const error = group.turnEnd?.turnReason === 'error'
  const sessionTitle = group.sessionTitle ?? ''
  return (
    <AggregateRow
      icon={
        group.turnEnd ? (
          <EventIcon event={group.turnEnd} />
        ) : group.single ? (
          <EventIcon event={group.single} />
        ) : (
          <Check size={14} />
        )
      }
      title={title}
      titleText={title}
      iconClassName={error ? 'text-danger' : isTurn ? 'text-text-soft' : 'text-text-tertiary'}
      time={formatRelative(group.at)}
      meta={
        <>
          <span className="shrink-0">{hostNameOf(group.hostId)}</span>
          <span className="min-w-0 truncate" data-tip={sessionTitle}>
            {sessionTitle}
          </span>
          {isTurn && hasDetails ? (
            <span className="shrink-0 text-text-tertiary">
              {expanded ? '收起明细' : `${group.children.length} 条明细`}
            </span>
          ) : null}
        </>
      }
      body={body}
      expandable={isTurn && hasDetails}
      expanded={expanded}
      detailCount={group.children.length}
      onOpen={() => openGroupTarget(group.hostId, group)}
      onToggle={onToggle}
      className={error ? 'text-danger' : undefined}
      testId="inbox-history-group"
    >
      {isTurn && expanded ? (
        <div className="mb-1 ml-8 border-l border-border pl-2" data-testid="inbox-history-details">
          {group.children.map((event) => {
            const detail = eventSummary(event)
            const preview = permissionPreview(event)
            const toolUseId = event.permission?.toolUseId
            return (
              <AggregateDetailRow
                key={event.seq}
                icon={<EventIcon event={event} />}
                title={detail.title}
                titleText={[detail.title, detail.body, preview].filter(Boolean).join('\n')}
                time={formatRelative(event.at)}
                body={detail.body ?? preview}
                onOpen={
                  toolUseId || group.sessionId
                    ? () => openGroupTarget(group.hostId, group, event)
                    : undefined
                }
              />
            )
          })}
          {group.turnEnd ? (
            <AggregateDetailRow
              icon={<EventIcon event={group.turnEnd} />}
              title={eventSummary(group.turnEnd).title}
              titleText={eventSummary(group.turnEnd).body}
              time={formatRelative(group.turnEnd.at)}
              body={eventSummary(group.turnEnd).body}
              onOpen={
                group.turnEnd.messageId || group.sessionId
                  ? () => openGroupTarget(group.hostId, group, group.turnEnd)
                  : undefined
              }
            />
          ) : null}
          <button
            type="button"
            onClick={() => openGroupTarget(group.hostId, group)}
            className="mt-1 flex items-center gap-1 rounded-md px-1 py-1 text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
          >
            打开会话
            <ChevronRight size={12} />
          </button>
        </div>
      ) : null}
    </AggregateRow>
  )
}

export function InboxView({ embedded = false }: { embedded?: boolean }) {
  const inbox = useAppStore((s) => s.inbox)
  const markInboxSeen = useAppStore((s) => s.markInboxSeen)
  const hosts = useAppStore((s) => s.hosts)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    markInboxSeen()
  }, [markInboxSeen])

  // 手机首页内嵌收件箱没有走桌面弹层；停留期间同样不应累计未读角标。
  useEffect(() => {
    if (!embedded) return
    useUiStore.getState().setInboxViewOpen(true)
    return () => useUiStore.getState().setInboxViewOpen(false)
  }, [embedded])

  const pending: Entry[] = []
  for (const host of hosts) {
    const entry = inbox[host.id]
    if (!entry) continue
    for (const event of entry.pending) pending.push({ hostId: host.id, event })
  }
  pending.sort((a, b) => b.event.at - a.event.at)
  const history = groupHistory(hosts, inbox)

  return (
    <div className={cn('flex min-h-0 flex-col', embedded ? 'h-full' : '')}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {pending.length === 0 && history.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <Inbox size={26} className="text-muted" />
            <p className="text-[13px] text-text-soft">收件箱是空的</p>
            <p className="max-w-[300px] text-[12px] leading-5 text-muted">
              会话请求审批、回合完成或预算告警时会出现在这里；手机保持连接即可随时处理。
            </p>
          </div>
        ) : (
          <div className="space-y-4 px-3 py-3">
            {pending.length > 0 && (
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-medium text-muted">
                  待审批
                  <span className="rounded-full bg-accent-strong px-1.5 py-px text-[12px] font-semibold text-on-accent">
                    {pending.length}
                  </span>
                </h3>
                <div className="space-y-2">
                  {pending.map((entry) => (
                    <PendingCard
                      key={`${entry.hostId}:${entry.event.requestId}:${entry.event.seq}`}
                      entry={entry}
                    />
                  ))}
                </div>
              </section>
            )}
            {history.length > 0 && (
              <section>
                <h3 className="mb-1 px-1 text-[12px] font-medium text-muted">最近</h3>
                <div className="-mx-1" data-testid="inbox-history">
                  {history.slice(0, 40).map((group) => (
                    <HistoryGroupRow
                      key={group.key}
                      group={group}
                      expanded={expanded.has(group.key)}
                      onToggle={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev)
                          if (next.has(group.key)) next.delete(group.key)
                          else next.add(group.key)
                          return next
                        })
                      }
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
