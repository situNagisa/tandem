import { useEffect, useMemo, useRef, useState } from 'react'
import { MessagesSquare } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { basename, formatRelative } from '../../lib/format'
import { openSplitSession } from '../../lib/splitActions'
import { Modal } from '../ui/Modal'
import { Input } from '../ui/Controls'
import { ListRow } from '../ui/ListRow'
import { SessionStatusDot } from '../StatusDot'

/** 命令面板 / 顶栏「分屏打开…」的会话选择器。 */
export function SplitOpenDialog() {
  const open = useUiStore((s) => s.splitPickerOpen)
  const setOpen = useUiStore((s) => s.setSplitPickerOpen)
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [open])

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = hosts.flatMap((host) =>
      (runtimes[host.id]?.sessions ?? [])
        .filter((session) => !session.archived && !session.parentId)
        .map((session) => ({
          hostId: host.id,
          hostName: host.name,
          session,
        })),
    )
    const filtered = q
      ? rows.filter(
          (row) =>
            row.session.title.toLowerCase().includes(q) ||
            row.session.cwd.toLowerCase().includes(q) ||
            row.hostName.toLowerCase().includes(q),
        )
      : rows
    return filtered.sort((a, b) => b.session.updatedAt - a.session.updatedAt).slice(0, 60)
  }, [hosts, runtimes, query])

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="分屏打开会话"
      description="再选一个会话放进分屏；每个窗格可独立发送、审批与滚动。"
      className="max-w-lg"
      bodyClassName="min-h-0"
    >
      <div className="flex min-h-0 flex-col gap-2">
        <Input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索会话标题、目录或 Host…"
          aria-label="搜索要分屏打开的会话"
        />
        <div className="max-h-[min(60dvh,460px)] min-h-[120px] overflow-y-auto">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-[13px] text-muted">
              <MessagesSquare size={20} className="opacity-50" />
              {runtimes[hosts[0]?.id ?? '']?.sessionsLoading
                ? '正在加载会话…'
                : '没有匹配的会话'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {items.map(({ hostId, hostName, session }) => (
                <ListRow
                  key={`${hostId}:${session.id}`}
                  icon={<SessionStatusDot status={session.status} />}
                  title={session.title || '未命名会话'}
                  detail={`${hostName} · ${basename(session.cwd) || session.cwd}`}
                  trailing={formatRelative(session.updatedAt)}
                  onClick={() => {
                    setOpen(false)
                    openSplitSession({ hostId, sessionId: session.id })
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
