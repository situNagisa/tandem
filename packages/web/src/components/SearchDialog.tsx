import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Pin, Search } from 'lucide-react'
import type { ExternalSession, ExternalSource, SessionStatus, SessionSummary } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { navigate } from '../lib/router'
import { basename, formatRelative } from '../lib/format'
import { cn } from '../lib/cn'
import { Modal } from './ui/Modal'
import { SessionStatusDot } from './StatusDot'

interface Result {
  key: string
  hostId: string
  hostName: string
  title: string
  cwd: string
  updatedAt: number
  status: SessionStatus
  project: string
  pinned?: boolean
  archived?: boolean
  depth?: number
  sessionId?: string
  external?: ExternalSession
}

type Scope = 'all' | 'project' | 'external'

const SOURCE_LABEL: Record<ExternalSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

const SCOPES: Array<{ value: Scope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'project', label: '本项目' },
  { value: 'external', label: '外部会话' },
]

function projectOf(cwd: string, env?: SessionSummary['env']): string {
  return env?.repoName || basename(cwd) || cwd
}

function dayGroup(ts: number): 'today' | 'yesterday' | 'earlier' {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= today) return 'today'
  if (ts >= today - 86_400_000) return 'yesterday'
  return 'earlier'
}

const GROUP_LABEL = { today: '今天', yesterday: '昨天', earlier: '更早' } as const

export function SearchDialog() {
  const open = useUiStore((s) => s.searchOpen)
  const setOpen = useUiStore((s) => s.setSearchOpen)
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  const active = useAppStore((s) => s.active)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [includeSubagents, setIncludeSubagents] = useState(false)
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setScope('all')
    setIncludeSubagents(false)
    setIndex(0)
    const t = window.setTimeout(() => inputRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [open])

  const project = useMemo(() => {
    const summary = active?.summary
    if (!summary) return null
    return {
      hostId: active.hostId,
      key: projectOf(summary.cwd, summary.env),
    }
  }, [active])

  const all = useMemo<Result[]>(() => {
    const out: Result[] = []
    for (const h of hosts) {
      const rt = runtimes[h.id]
      for (const session of rt?.sessions ?? []) {
        if (session.parentId && !includeSubagents) continue
        out.push({
          key: `s:${h.id}:${session.id}`,
          hostId: h.id,
          hostName: h.name,
          title: session.title || '未命名会话',
          cwd: session.cwd,
          updatedAt: session.updatedAt,
          status: session.status,
          project: projectOf(session.cwd, session.env),
          pinned: session.pinned,
          archived: session.archived,
          depth: session.depth,
          sessionId: session.id,
        })
      }
      for (const ext of rt?.externalSessions ?? []) {
        out.push({
          key: `x:${h.id}:${ext.source}:${ext.id}`,
          hostId: h.id,
          hostName: h.name,
          title: ext.title || '未命名会话',
          cwd: ext.cwd,
          updatedAt: ext.updatedAt,
          status: 'idle',
          project: projectOf(ext.cwd),
          external: ext,
        })
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }, [hosts, runtimes, includeSubagents])

  const scoped = useMemo(() => {
    if (scope === 'external') return all.filter((r) => r.external)
    if (scope === 'project') {
      if (!project) return []
      return all.filter(
        (r) =>
          !r.external && r.hostId === project.hostId && r.project === project.key,
      )
    }
    return all
  }, [all, scope, project])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? scoped.filter(
          (r) =>
            r.title.toLowerCase().includes(q) ||
            r.cwd.toLowerCase().includes(q) ||
            r.project.toLowerCase().includes(q) ||
            r.hostName.toLowerCase().includes(q),
        )
      : scoped
    return filtered.slice(0, 60)
  }, [scoped, query])

  const grouped = useMemo(() => {
    const buckets: Record<'today' | 'yesterday' | 'earlier', Result[]> = {
      today: [],
      yesterday: [],
      earlier: [],
    }
    for (const r of results) buckets[dayGroup(r.updatedAt)].push(r)
    return (['today', 'yesterday', 'earlier'] as const)
      .filter((k) => buckets[k].length > 0)
      .map((k) => ({ key: k, label: GROUP_LABEL[k], items: buckets[k] }))
  }, [results])

  useEffect(() => {
    setIndex(0)
  }, [query, scope])

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, results.length - 1)))
  }, [results.length])

  const openResult = (r: Result) => {
    setOpen(false)
    if (r.external) {
      navigate({ kind: 'external', hostId: r.hostId, source: r.external.source, id: r.external.id })
      return
    }
    if (r.sessionId) {
      navigate({ kind: 'session', hostId: r.hostId, sessionId: r.sessionId })
    }
  }

  let flatIndex = 0

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      align="top"
      className="h-[min(560px,70vh)] max-w-[680px]"
      bodyClassName="overflow-hidden p-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4">
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
          <kbd className="shrink-0 rounded border border-border bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[11px] text-muted">
            Esc
          </kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
          {results.length === 0 && (
            <p className="px-3 py-8 text-center text-[13px] text-muted">
              {query ? '没有找到匹配的会话' : scope === 'project' && !project ? '当前没有可定位的项目' : '暂无可搜索的会话'}
            </p>
          )}
          {grouped.map((group) => (
            <div key={group.key}>
              <div className="px-2.5 pb-1 pt-2 text-[12px] font-medium tracking-[0.08em] text-muted">
                {group.label}
              </div>
              {group.items.map((r) => {
                const i = flatIndex++
                return (
                  <button
                    key={r.key}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => openResult(r)}
                    className={cn(
                      'flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors duration-[120ms]',
                      i === index ? 'bg-[var(--t-bg-active)]' : 'hover:bg-[var(--t-bg-hover)]',
                    )}
                  >
                    {typeof r.depth === 'number' && r.depth > 0 && (
                      <span className="shrink-0 text-[12px] text-muted">
                        {r.depth === 1 ? '子' : r.depth === 2 ? '孙' : `第${r.depth}层`}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {r.title}
                    </span>
                    {r.pinned && <Pin size={10} className="shrink-0 text-muted" />}
                    {r.archived && (
                      <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1 text-[11px] text-muted">
                        已归档
                      </span>
                    )}
                    <span
                      className={cn(
                        'shrink-0 truncate rounded border border-border px-1 py-px text-[11px] text-muted',
                        r.external ? 'max-w-[104px]' : 'max-w-[120px]',
                      )}
                      title={`${r.hostName} · ${r.project}`}
                    >
                      {r.external ? SOURCE_LABEL[r.external.source] : r.project}
                    </span>
                    <span className="min-w-[52px] shrink-0 whitespace-nowrap text-right text-[12px] text-muted">
                      {formatRelative(r.updatedAt)}
                    </span>
                    <span className="flex w-2 shrink-0 justify-center">
                      <SessionStatusDot status={r.status} />
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-1 border-t border-border px-3 py-2">
          <div className="flex items-center gap-0.5">
            {SCOPES.map((s) => (
              <button
                key={s.value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setScope(s.value)}
                aria-pressed={scope === s.value}
                className={cn(
                  'h-6 rounded-md px-2 text-[13px] transition-colors duration-[120ms]',
                  scope === s.value
                    ? 'bg-[var(--t-bg-active)] text-text'
                    : 'text-muted hover:bg-[var(--t-bg-hover)] hover:text-text-soft',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setIncludeSubagents((v) => !v)}
            aria-pressed={includeSubagents}
            className={cn(
              'ml-2 flex h-6 items-center gap-1 rounded-md px-2 text-[12px] transition-colors duration-[120ms]',
              includeSubagents
                ? 'bg-[var(--t-bg-active)] text-text'
                : 'text-muted hover:bg-[var(--t-bg-hover)] hover:text-text-soft',
            )}
          >
            <Bot size={11} /> 包含子代理
          </button>
          <span className="ml-auto text-[12px] text-muted">{results.length} 个结果</span>
        </div>
      </div>
    </Modal>
  )
}
