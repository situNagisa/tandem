import { useEffect, useMemo, useRef, useState } from 'react'
import { Pin, Search, Server } from 'lucide-react'
import type { SessionSummary } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { navigate } from '../lib/router'
import { basename, formatRelative } from '../lib/format'
import { cn } from '../lib/cn'
import { Modal } from './ui/Modal'
import { SessionStatusDot } from './StatusDot'

interface Result {
  hostId: string
  hostName: string
  session: SessionSummary
}

export function SearchDialog() {
  const open = useUiStore((s) => s.searchOpen)
  const setOpen = useUiStore((s) => s.setSearchOpen)
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [open])

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase()
    const all: Result[] = []
    for (const h of hosts) {
      const rt = runtimes[h.id]
      for (const session of rt?.sessions ?? []) {
        all.push({ hostId: h.id, hostName: h.name, session })
      }
    }
    all.sort((a, b) => b.session.updatedAt - a.session.updatedAt)
    const filtered = q
      ? all.filter(
          (r) =>
            r.session.title.toLowerCase().includes(q) ||
            r.session.cwd.toLowerCase().includes(q) ||
            r.session.model.toLowerCase().includes(q) ||
            r.hostName.toLowerCase().includes(q),
        )
      : all
    return filtered.slice(0, 40)
  }, [hosts, runtimes, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  const openResult = (r: Result) => {
    setOpen(false)
    navigate({ kind: 'session', hostId: r.hostId, sessionId: r.session.id })
  }

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      align="top"
      className="max-w-xl"
      bodyClassName="p-0"
    >
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <Search size={16} className="shrink-0 text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(results.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const r = results[index]
              if (r) openResult(r)
            }
          }}
          placeholder="搜索全部 Host 的会话"
          className="h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted"
          aria-label="搜索会话"
        />
        <kbd className="shrink-0 rounded border border-border bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[10px] text-muted">
          Esc
        </kbd>
      </div>

      <div className="max-h-[52vh] overflow-y-auto p-2">
        {results.length === 0 && (
          <p className="px-3 py-8 text-center text-[13px] text-muted">
            {query ? '没有找到匹配的会话' : '暂无可搜索的会话'}
          </p>
        )}
        {results.map((r, i) => (
          <button
            key={`${r.hostId}:${r.session.id}`}
            onMouseEnter={() => setIndex(i)}
            onClick={() => openResult(r)}
            className={cn(
              'flex min-h-11 w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100',
              i === index ? 'bg-[var(--t-bg-active)]' : 'hover:bg-[var(--t-bg-hover)]',
            )}
          >
            <span className="mt-[7px] flex w-3 shrink-0 justify-center">
              <SessionStatusDot status={r.session.status} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {r.session.title || '未命名会话'}
                </span>
                {r.session.pinned && <Pin size={10} className="shrink-0 text-muted" />}
                {r.session.archived && (
                  <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1 text-[9px] text-muted">
                    已归档
                  </span>
                )}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted">
                <Server size={10} className="shrink-0" />
                <span className="shrink-0">{r.hostName}</span>
                <span className="text-border-strong">·</span>
                <span className="truncate">{r.session.env?.repoName || basename(r.session.cwd) || r.session.cwd}</span>
                {r.session.env?.branch && (
                  <>
                    <span className="text-border-strong">·</span>
                    <span className="max-w-[120px] truncate">{r.session.env.branch}</span>
                  </>
                )}
                <span className="text-border-strong">·</span>
                <span className="shrink-0">{formatRelative(r.session.updatedAt)}</span>
              </span>
            </span>
            {i === index && (
              <kbd className="mt-0.5 shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-muted">
                ↵
              </kbd>
            )}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-muted">
        <span>↑↓ 选择</span>
        <span>Enter 打开</span>
        <span className="ml-auto">Ctrl/⌘ + K</span>
      </div>
    </Modal>
  )
}
