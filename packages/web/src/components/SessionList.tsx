import { useMemo } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import type { SessionSummary } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { basename, dayBucket, formatRelative } from '../lib/format'
import { sessionHash } from '../lib/router'
import { cn } from '../lib/cn'
import { SessionStatusDot } from './StatusDot'

const EMPTY: SessionSummary[] = []

export function SessionList({
  query,
  onNavigate,
}: {
  query: string
  onNavigate?: () => void
}) {
  const activeHostId = useAppStore((s) => s.activeHostId)
  const sessions = useAppStore((s) =>
    activeHostId ? (s.runtimes[activeHostId]?.sessions ?? EMPTY) : EMPTY,
  )
  const loading = useAppStore((s) =>
    activeHostId ? (s.runtimes[activeHostId]?.sessionsLoading ?? false) : false,
  )
  const activeSessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const setNewSessionOpen = useUiStore((s) => s.setNewSessionOpen)

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.cwd.toLowerCase().includes(q) ||
            s.model.toLowerCase().includes(q),
        )
      : sessions
    const map = new Map<string, SessionSummary[]>()
    const order = ['今天', '昨天', '更早']
    for (const s of filtered) {
      const key = dayBucket(s.updatedAt)
      const arr = map.get(key)
      if (arr) arr.push(s)
      else map.set(key, [s])
    }
    return order.filter((k) => map.has(k)).map((k) => ({ label: k, items: map.get(k)! }))
  }, [sessions, query])

  if (loading && sessions.length === 0) {
    return (
      <div className="flex-1 space-y-2 overflow-hidden px-3 pt-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2.5 px-1 py-1.5">
            <div className="skeleton size-2 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="skeleton h-3 w-[75%]" />
              <div className="skeleton h-2.5 w-[45%]" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="会话列表">
      {groups.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl bg-surface-2/70 text-muted">
            <MessageSquarePlus size={18} />
          </div>
          <p className="text-[12.5px] leading-5 text-muted">
            {query ? '没有匹配的会话' : '还没有会话，开始第一次对话吧。'}
          </p>
          {!query && (
            <button
              onClick={() => setNewSessionOpen(true)}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-[12.5px] font-medium text-text-soft transition-colors hover:bg-surface-2"
            >
              新建会话
            </button>
          )}
        </div>
      )}
      {groups.map((group) => (
        <div key={group.label}>
          <div className="sticky top-0 z-10 bg-sidebar/95 px-2 pb-1 pt-3.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted backdrop-blur">
            {group.label}
          </div>
          <ul className="space-y-0.5">
            {group.items.map((s) => {
              const isActive = s.id === activeSessionId
              return (
                <li key={s.id}>
                  <a
                    href={sessionHash(activeHostId ?? '', s.id)}
                    onClick={(e) => {
                      e.preventDefault()
                      if (isActive) {
                        onNavigate?.()
                        return
                      }
                      window.location.hash = sessionHash(activeHostId ?? '', s.id).slice(1)
                      onNavigate?.()
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'group flex min-h-11 items-start gap-2 rounded-lg px-2 py-1.5 transition-colors duration-150',
                      isActive
                        ? 'bg-surface text-text shadow-[0_1px_2px_rgba(40,30,20,0.06)] ring-1 ring-border'
                        : 'text-text-soft hover:bg-surface-2/60 hover:text-text',
                    )}
                  >
                    <span className="mt-[7px] flex w-3 shrink-0 justify-center">
                      <SessionStatusDot status={s.status} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">
                          {s.title || '未命名会话'}
                        </span>
                        {s.status === 'waiting_permission' && (
                          <span className="shrink-0 rounded-full bg-warning-soft px-1.5 py-px text-[10px] font-medium leading-4 text-warning">
                            待审批
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted">
                        {basename(s.cwd) || s.cwd} · {formatRelative(s.updatedAt)}
                      </span>
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
