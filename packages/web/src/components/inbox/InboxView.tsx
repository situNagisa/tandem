import { useEffect } from 'react'
import {
  BellRing,
  Check,
  CheckCircle2,
  FlaskConical,
  GitPullRequest,
  Inbox,
  ShieldAlert,
  TriangleAlert,
  Wallet,
  X,
} from 'lucide-react'
import type { InboxEvent, PermissionDecision } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { navigate } from '../../lib/router'
import { formatRelative } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Button } from '../ui/Button'

/** 所有 Host 的未处理数（待审批 + 未读提醒）。 */
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
  if (event.kind === 'turn_end') {
    if (event.turnReason === 'error') {
      return { title: '回合出错', body: event.error ?? '执行失败' }
    }
    return { title: event.turnReason === 'interrupted' ? '回合已停止' : '回合完成' }
  }
  if (event.kind === 'budget') {
    return { title: '预算提醒', body: event.budgetText ?? '' }
  }
  if (event.kind === 'ci') {
    return { title: event.ci?.text ?? 'PR 状态变化', body: event.ci ? `#${event.ci.prNumber}` : undefined }
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

function EventIcon({ event }: { event: InboxEvent }) {
  if (event.kind === 'permission') {
    return event.plan ? <ShieldAlert size={14} /> : <BellRing size={14} />
  }
  if (event.kind === 'permission_resolved') return <Check size={14} />
  if (event.kind === 'budget') return <Wallet size={14} />
  if (event.kind === 'ci') return <GitPullRequest size={14} />
  if (event.kind === 'eval') return <FlaskConical size={14} />
  if (event.turnReason === 'error') return <TriangleAlert size={14} />
  return <CheckCircle2 size={14} />
}

function PendingCard({ entry }: { entry: Entry }) {
  const decide = useAppStore((s) => s.decideInboxPermission)
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
    <div className="rounded-xl border border-border bg-surface p-3">
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
            <span className="min-w-0 truncate text-[13px] font-medium">{title}</span>
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
              onClick={open}
              disabled={!event.sessionId}
              className="min-w-0 max-w-full truncate text-text-soft underline-offset-2 hover:text-text hover:underline disabled:no-underline"
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

function HistoryRow({ entry }: { entry: Entry }) {
  const { event, hostId } = entry
  const { title, body } = eventSummary(event)
  const open = () => {
    const sessionId = event.sessionId ?? event.budgetSessionId
    if (!sessionId) return
    useUiStore.getState().setInboxOpen(false)
    navigate({ kind: 'session', hostId, sessionId })
  }
  return (
    <button
      type="button"
      onClick={open}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
    >
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md',
          event.kind === 'turn_end' && event.turnReason === 'error'
            ? 'text-danger'
            : 'text-text-tertiary',
        )}
      >
        <EventIcon event={event} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[12.5px] text-text-soft">{title}</span>
          <span className="ml-auto shrink-0 text-[12px] text-muted">{formatRelative(event.at)}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 gap-1.5 text-[12px] text-muted">
          <span className="shrink-0">{hostNameOf(hostId)}</span>
          <span className="truncate">{event.sessionTitle ?? event.budgetSessionTitle ?? ''}</span>
        </span>
        {body && event.kind !== 'permission' ? (
          <span className="mt-0.5 block truncate text-[12px] text-muted">{body}</span>
        ) : null}
      </span>
    </button>
  )
}

export function InboxView({ embedded = false }: { embedded?: boolean }) {
  const inbox = useAppStore((s) => s.inbox)
  const markInboxSeen = useAppStore((s) => s.markInboxSeen)
  const hosts = useAppStore((s) => s.hosts)

  useEffect(() => {
    markInboxSeen()
  }, [markInboxSeen])

  const pending: Entry[] = []
  const history: Entry[] = []
  for (const host of hosts) {
    const entry = inbox[host.id]
    if (!entry) continue
    for (const event of entry.pending) pending.push({ hostId: host.id, event })
    for (const event of entry.events) {
      if (event.kind === 'permission') {
        // 未处理审批在上方单独显示
        if (!entry.pending.some((p) => p.requestId === event.requestId)) {
          history.push({ hostId: host.id, event })
        }
      } else {
        history.push({ hostId: host.id, event })
      }
    }
  }
  pending.sort((a, b) => b.event.at - a.event.at)
  history.sort((a, b) => b.event.at - a.event.at)

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
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-medium text-muted">
                待审批
                {pending.length > 0 && (
                  <span className="rounded-full bg-accent-strong px-1.5 py-px text-[12px] font-semibold text-on-accent">
                    {pending.length}
                  </span>
                )}
              </h3>
              {pending.length === 0 ? (
                <p className="px-1 pb-1 text-[12px] text-muted">没有需要处理的审批</p>
              ) : (
                <div className="space-y-2">
                  {pending.map((entry) => (
                    <PendingCard
                      key={`${entry.hostId}:${entry.event.requestId}:${entry.event.seq}`}
                      entry={entry}
                    />
                  ))}
                </div>
              )}
            </section>
            {history.length > 0 && (
              <section>
                <h3 className="mb-1 px-1 text-[12px] font-medium text-muted">最近</h3>
                <div className="-mx-1">
                  {history.slice(0, 40).map((entry) => (
                    <HistoryRow key={`${entry.hostId}:${entry.event.seq}`} entry={entry} />
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
