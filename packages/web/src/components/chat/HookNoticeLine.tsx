import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { HookNotice } from '../../lib/types'
import { cn } from '../../lib/cn'

interface HookGroup {
  key: string
  event: string
  name: string
  blocked: boolean
  count: number
  messages: string[]
}

/** 连续出现的同类 Hook 错误合并计数，避免刷屏。 */
export function groupHookNotices(notices: HookNotice[]): HookGroup[] {
  const groups: HookGroup[] = []
  for (const notice of notices) {
    const blocked = !!notice.blocked
    const first = (notice.message ?? '').split('\n')[0] ?? ''
    const key = `${notice.event}:${notice.name}:${blocked}:${first}`
    const last = groups[groups.length - 1]
    if (last && last.key === key) {
      last.count++
      if (notice.message) last.messages.push(notice.message)
      continue
    }
    groups.push({
      key: `${key}:${groups.length}`,
      event: notice.event,
      name: notice.name,
      blocked,
      count: 1,
      messages: notice.message ? [notice.message] : [],
    })
  }
  return groups
}

/** 消息流内的 Hook 失败提示：一行灰色小字，点击展开详情。 */
export function HookNoticeLine({ notices }: { notices: HookNotice[] }) {
  const [open, setOpen] = useState(false)
  const groups = groupHookNotices(notices)
  if (groups.length === 0) return null

  return (
    <div className="mt-1.5 flex flex-col gap-0.5">
      {groups.map((group) => {
        const label = `Hook ${group.event} · ${group.name} ${group.blocked ? '已阻止' : '出错'}`
        const hint = group.messages[0]?.split('\n')[0] ?? ''
        return (
          <div key={group.key}>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="flex max-w-full items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-[11.5px] leading-4 text-muted transition-colors hover:text-text-soft"
            >
              <span className="shrink-0">
                {label}
                {group.count > 1 ? ` ×${group.count}` : ''}
              </span>
              {hint && <span className="min-w-0 truncate opacity-80">：{hint}</span>}
              <ChevronDown
                size={11}
                className={cn('shrink-0 transition-transform', open && 'rotate-180')}
              />
            </button>
            {open && (
              <div className="mb-1 mt-0.5 space-y-1 rounded-md bg-[var(--t-bg-subtle)] px-2 py-1.5 font-mono text-[10.5px] leading-4 text-muted">
                {group.messages.map((message, index) => (
                  <pre key={index} className="whitespace-pre-wrap break-words">
                    {message}
                  </pre>
                ))}
                {group.messages.length === 0 && <p>没有更多详情</p>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
