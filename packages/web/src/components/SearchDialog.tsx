import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  Bot,
  Command,
  FolderOpen,
  MessageSquare,
  Pin,
  Search,
  Server,
  SlidersHorizontal,
} from 'lucide-react'
import { Spinner } from './ui/Spinner'
import type { SearchHit, SessionStatus } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { api } from '../lib/api'
import { navigate } from '../lib/router'
import { focusMessage } from '../lib/jump'
import { basename, formatRelative } from '../lib/format'
import { cn } from '../lib/cn'
import { Modal } from './ui/Modal'
import { SessionStatusDot } from './StatusDot'
import { textMatches } from '../lib/pinyin'
import {
  COMMANDS,
  getCommandShortcut,
  loadRecentCommands,
  pushRecentCommand,
} from '../lib/commands'
import { formatShortcut } from '../lib/shortcut'
import { SETTINGS_ITEMS, SETTINGS_TAB_LABELS } from '../lib/settingsRegistry'
import { readRecentDirsMap } from '../lib/storage'
import { defaultChoiceFor } from '../lib/profileModels'

type Kind = 'command' | 'session' | 'setting' | 'host' | 'project'
type Prefix = 'all' | 'command' | 'session' | 'setting'

interface PaletteItem {
  key: string
  kind: Kind
  title: string
  meta: string
  shortcut?: string
  status?: SessionStatus
  pinned?: boolean
  archived?: boolean
  depth?: number
  time?: number
  external?: boolean
  /** 全文搜索命中：片段与高亮区间（相对片段）。 */
  snippet?: string
  highlights?: Array<{ start: number; end: number }>
  hit?: SearchHit & { hostId: string }
  run: () => void
}

function HighlightedText({
  text,
  ranges,
}: {
  text: string
  ranges?: Array<{ start: number; end: number }>
}) {
  if (!ranges?.length) return <>{text}</>
  const sorted = [...ranges]
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start)
  const parts: ReactNode[] = []
  let cursor = 0
  for (const range of sorted) {
    const start = Math.max(cursor, Math.min(text.length, range.start))
    const end = Math.max(start, Math.min(text.length, range.end))
    if (start > cursor) parts.push(text.slice(cursor, start))
    if (end > start) {
      parts.push(
        <mark key={`${start}:${end}`} className="chat-match">
          {text.slice(start, end)}
        </mark>,
      )
    }
    cursor = end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

interface PaletteGroup {
  key: string
  label: string
  items: PaletteItem[]
}

const GROUP_ICON: Record<Kind, typeof Search> = {
  command: Command,
  session: MessageSquare,
  setting: SlidersHorizontal,
  host: Server,
  project: FolderOpen,
}

function projectOf(cwd: string, env?: { repoName?: string }): string {
  return env?.repoName || basename(cwd) || cwd
}

function parseQuery(raw: string): { prefix: Prefix; query: string } {
  const text = raw.trimStart()
  if (text.startsWith('>')) return { prefix: 'command', query: text.slice(1).trim() }
  if (text.startsWith('@')) return { prefix: 'session', query: text.slice(1).trim() }
  if (text.startsWith('#')) return { prefix: 'setting', query: text.slice(1).trim() }
  return { prefix: 'all', query: text.trim() }
}

export function SearchDialog() {
  const open = useUiStore((s) => s.searchOpen)
  const setOpen = useUiStore((s) => s.setSearchOpen)
  const focusSetting = useUiStore((s) => s.focusSetting)
  const toast = useUiStore((s) => s.toast)
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const teamRole = useAppStore((s) =>
    s.activeHostId ? s.runtimes[s.activeHostId]?.team?.role : undefined,
  )
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [includeSubagents, setIncludeSubagents] = useState(false)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [remoteHits, setRemoteHits] = useState<Array<SearchHit & { hostId: string }>>([])
  const [searching, setSearching] = useState(false)
  const searchSeq = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    setIncludeSubagents(false)
    setRemoteHits([])
    setSearching(false)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [open])

  const { prefix, query: text } = parseQuery(query)
  const sessionSearchAllowed = prefix === 'all' || prefix === 'session'

  // 会话分组走 Host 全文索引：多 Host（含加密隧道）并行请求，归档默认排除。
  useEffect(() => {
    if (!open || !sessionSearchAllowed || !text.trim()) {
      setRemoteHits([])
      setSearching(false)
      return
    }
    const seq = ++searchSeq.current
    setSearching(true)
    const timer = window.setTimeout(() => {
      void Promise.all(
        hosts.map(async (host) => {
          try {
            const result = await api.search(host, text, { includeArchived })
            return result.hits.map((hit) => ({ ...hit, hostId: host.id }))
          } catch {
            return []
          }
        }),
      ).then((lists) => {
        if (seq !== searchSeq.current) return
        setRemoteHits(lists.flat())
        setSearching(false)
      })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [open, sessionSearchAllowed, text, includeArchived, hosts])

  const groups = useMemo<PaletteGroup[]>(() => {
    const out: PaletteGroup[] = []
    const q = text
    const commandAllowed = prefix === 'all' || prefix === 'command'
    const sessionAllowed = prefix === 'all' || prefix === 'session'
    const settingAllowed = prefix === 'all' || prefix === 'setting'
    const hostAllowed = prefix === 'all'
    const projectAllowed = prefix === 'all'

    if (commandAllowed) {
      const recentIds = loadRecentCommands()
      const rank = new Map(recentIds.map((id, i) => [id, i]))
      const matched = COMMANDS.filter(
        (command) =>
          !q ||
          textMatches(command.title, q) ||
          command.keywords.some((word) => textMatches(word, q)) ||
          textMatches(command.id.replace(/[._-]/g, ' '), q),
      ).sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99))
      const toItem = (command: (typeof COMMANDS)[number]): PaletteItem => ({
        key: `c:${command.id}`,
        kind: 'command',
        title: command.title,
        meta: '命令',
        shortcut: getCommandShortcut(command.id),
        run: command.run,
      })
      if (!q) {
        const recent = recentIds
          .map((id) => COMMANDS.find((command) => command.id === id))
          .filter((command): command is (typeof COMMANDS)[number] => !!command)
        if (recent.length) {
          out.push({ key: 'recent', label: '最近使用', items: recent.map(toItem) })
        }
        out.push({
          key: 'commands',
          label: '命令',
          items: matched.filter((command) => !recentIds.includes(command.id)).map(toItem),
        })
      } else if (matched.length) {
        out.push({ key: 'commands', label: '命令', items: matched.map(toItem) })
      }
    }

    if (sessionAllowed && !q) {
      const sessions: PaletteItem[] = []
      for (const host of hosts) {
        const runtime = runtimes[host.id]
        for (const session of runtime?.sessions ?? []) {
          if (session.parentId && !includeSubagents) continue
          const title = session.title || '未命名会话'
          const project = projectOf(session.cwd, session.env)
          sessions.push({
            key: `s:${host.id}:${session.id}`,
            kind: 'session',
            title,
            meta: `${host.name} · ${project}`,
            status: session.status,
            pinned: session.pinned,
            archived: session.archived,
            depth: session.depth,
            time: session.updatedAt,
            run: () => navigate({ kind: 'session', hostId: host.id, sessionId: session.id }),
          })
        }
        for (const external of runtime?.externalSessions ?? []) {
          sessions.push({
            key: `x:${host.id}:${external.source}:${external.id}`,
            kind: 'session',
            title: external.title || '未命名会话',
            meta: `${host.name} · ${external.source === 'claude-code' ? 'Claude Code' : 'Codex'}`,
            status: 'idle',
            time: external.updatedAt,
            external: true,
            run: () =>
              navigate({
                kind: 'external',
                hostId: host.id,
                source: external.source,
                id: external.id,
              }),
          })
        }
      }
      sessions.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
      if (sessions.length) out.push({ key: 'sessions', label: '会话', items: sessions.slice(0, 8) })
    }

    // 有查询词：会话分组完全来自 Host 全文索引（标题/正文/工具命令与路径）。
    if (sessionAllowed && q) {
      const seen = new Set<string>()
      const items: PaletteItem[] = []
      const ordered = [...remoteHits].sort(
        (a, b) => b.score - a.score || b.updatedAt - a.updatedAt,
      )
      for (const hit of ordered) {
        const dedupeKey = `${hit.hostId}:${hit.source}:${hit.sessionId}`
        if (seen.has(dedupeKey)) continue
        const host = hosts.find((item) => item.id === hit.hostId)
        if (!host) continue
        const summary = runtimes[hit.hostId]?.sessions.find((s) => s.id === hit.sessionId)
        if (summary?.parentId && !includeSubagents) continue
        seen.add(dedupeKey)
        const sourceLabel =
          hit.source === 'tandem'
            ? 'Tandem'
            : hit.source === 'claude-code'
              ? 'Claude Code'
              : 'Codex'
        items.push({
          key: `hit:${dedupeKey}`,
          kind: 'session',
          title: hit.title || summary?.title || '未命名会话',
          meta: `${host.name} · ${sourceLabel} · ${hit.project}`,
          status: summary?.status ?? 'idle',
          pinned: summary?.pinned,
          archived: summary?.archived,
          depth: summary?.depth,
          time: hit.updatedAt,
          external: hit.source !== 'tandem',
          snippet: hit.snippet,
          highlights: hit.highlights,
          hit,
          run: () => {
            if (hit.source === 'tandem') {
              navigate({ kind: 'session', hostId: hit.hostId, sessionId: hit.sessionId })
            } else {
              navigate({
                kind: 'external',
                hostId: hit.hostId,
                source: hit.source,
                id: hit.sessionId,
              })
            }
            if (hit.messageId) focusMessage(hit.messageId)
          },
        })
        if (items.length >= 40) break
      }
      if (items.length) out.push({ key: 'sessions', label: '会话', items })
    }

    if (settingAllowed && (q || prefix === 'setting')) {
      const allowedTabs =
        teamRole && teamRole !== 'owner'
          ? new Set(['hosts', 'appearance', 'notifications'])
          : null
      const settings = SETTINGS_ITEMS.filter((item) => {
        if (allowedTabs && !allowedTabs.has(item.tab)) return false
        if (!q) return true
        return (
          textMatches(item.title, q) ||
          item.keywords.some((word) => textMatches(word, q)) ||
          textMatches(SETTINGS_TAB_LABELS[item.tab], q)
        )
      })
      if (settings.length) {
        out.push({
          key: 'settings',
          label: '设置',
          items: settings.slice(0, 60).map((item) => ({
            key: `t:${item.id}`,
            kind: 'setting',
            title: item.title,
            meta: `设置 · ${SETTINGS_TAB_LABELS[item.tab]}`,
            run: () => focusSetting(item.tab, item.id),
          })),
        })
      }
    }

    if (hostAllowed) {
      const matched = hosts.filter((host) => !q || textMatches(host.name, q))
      if (matched.length && (q || hosts.length > 1)) {
        out.push({
          key: 'hosts',
          label: '主机',
          items: matched.map((host) => ({
            key: `h:${host.id}`,
            kind: 'host',
            title: host.name,
            meta: `${runtimes[host.id]?.status === 'online' ? '在线' : runtimes[host.id]?.status === 'connecting' ? '连接中' : '离线'}${
              host.id === activeHostId ? ' · 当前' : ''
            }`,
            run: () => {
              useAppStore.getState().activateHost(host.id)
              navigate({ kind: 'host', hostId: host.id })
            },
          })),
        })
      }
    }

    if (projectAllowed) {
      const dirs = readRecentDirsMap()
      const projects: PaletteItem[] = []
      for (const host of hosts) {
        for (const dir of dirs[host.id] ?? []) {
          if (q && !textMatches(`${dir} ${host.name}`, q)) continue
          projects.push({
            key: `p:${host.id}:${dir}`,
            kind: 'project',
            title: basename(dir) || dir,
            meta: `${host.name} · ${dir}`,
            run: () => {
              const runtime = useAppStore.getState().runtimes[host.id]
              const profile = runtime?.profiles[0]
              const choice = defaultChoiceFor(profile)
              if (!profile || !choice) {
                toast(`${host.name} 还没有可用账号`, 'info')
                return
              }
              useAppStore.getState().activateHost(host.id)
              void useAppStore
                .getState()
                .createSession(host.id, {
                  cwd: dir,
                  profileId: profile.id,
                  ...(choice.groupId ? { groupId: choice.groupId } : {}),
                  model: choice.model,
                })
                .catch((err: unknown) =>
                  toast(err instanceof Error ? err.message : '创建会话失败', 'error'),
                )
            },
          })
        }
      }
      if (projects.length) {
        out.push({ key: 'projects', label: '项目目录', items: projects.slice(0, q ? 20 : 6) })
      }
    }

    return out
  }, [
    text,
    prefix,
    hosts,
    runtimes,
    remoteHits,
    includeSubagents,
    activeHostId,
    teamRole,
    focusSetting,
    toast,
  ])

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])

  useEffect(() => {
    setIndex(0)
  }, [query])

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, flat.length - 1)))
  }, [flat.length])

  useEffect(() => {
    document
      .querySelector(`[data-palette-index="${index}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return
    setOpen(false)
    if (item.kind === 'command') pushRecentCommand(item.key.slice(2))
    window.setTimeout(() => item.run(), 0)
  }

  const jumpGroup = (direction: 1 | -1) => {
    if (flat.length === 0) return
    let groupIndex = 0
    let cursor = 0
    for (let i = 0; i < groups.length; i++) {
      if (index < cursor + groups[i].items.length) {
        groupIndex = i
        break
      }
      cursor += groups[i].items.length
    }
    const nextGroup = (groupIndex + direction + groups.length) % groups.length
    let start = 0
    for (let i = 0; i < nextGroup; i++) start += groups[i].items.length
    setIndex(start)
  }

  let flatIndex = 0

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      align="top"
      ariaLabel="命令面板"
      className="h-[min(620px,76vh)] max-w-[720px]"
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
                setIndex((i) => Math.min(flat.length - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(0, i - 1))
              } else if (e.key === 'Tab') {
                e.preventDefault()
                e.stopPropagation()
                jumpGroup(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runItem(flat[index])
              }
            }}
            placeholder="搜索会话、命令、设置…  > 命令  @ 会话  # 设置"
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted"
            aria-label="搜索会话、命令与设置"
          />
          <kbd className="shrink-0 rounded border border-border bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[12px] text-muted">
            Esc
          </kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
          {flat.length === 0 && (
            <p className="px-3 py-8 text-center text-[13px] text-muted">
              {searching
                ? '搜索中…'
                : text
                  ? '没有匹配的结果'
                  : prefix === 'all'
                    ? '暂无可搜索的内容'
                    : '没有内容'}
            </p>
          )}
          {groups.map((group) => {
            const Icon = GROUP_ICON[group.items[0]?.kind ?? 'command']
            return (
              <div key={group.key}>
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[12px] font-medium tracking-[0.08em] text-muted">
                  <Icon size={11} />
                  {group.label}
                  <span className="font-normal tracking-normal text-muted/70">{group.items.length}</span>
                </div>
                {group.items.map((item) => {
                  const i = flatIndex++
                  return (
                    <button
                      key={item.key}
                      data-palette-index={i}
                      data-palette-kind={item.kind}
                      data-palette-active={i === index ? 'true' : undefined}
                      data-search-hit={item.hit ? 'true' : undefined}
                      data-search-message-id={item.hit?.messageId || undefined}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => runItem(item)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors duration-[120ms]',
                        item.snippet ? 'min-h-12 py-1.5' : 'h-10',
                        i === index ? 'bg-[var(--t-bg-active)]' : 'hover:bg-[var(--t-bg-hover)]',
                      )}
                    >
                      {typeof item.depth === 'number' && item.depth > 0 && (
                        <span className="shrink-0 text-[12px] text-muted">
                          {item.depth === 1 ? '子' : item.depth === 2 ? '孙' : `第${item.depth}层`}
                        </span>
                      )}
                      {item.snippet ? (
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                              {item.title}
                            </span>
                            {item.pinned && <Pin size={10} className="shrink-0 text-muted" />}
                            {item.archived && (
                              <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1 text-[12px] text-muted">
                                已归档
                              </span>
                            )}
                          </span>
                          <span
                            className="mt-0.5 block truncate text-[12px] font-normal text-text-tertiary"
                            data-tip={item.snippet}
                          >
                            <HighlightedText text={item.snippet} ranges={item.highlights} />
                          </span>
                        </span>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                            {item.title}
                          </span>
                          {item.pinned && <Pin size={10} className="shrink-0 text-muted" />}
                          {item.archived && (
                            <span className="shrink-0 rounded bg-[var(--t-bg-hover)] px-1 text-[12px] text-muted">
                              已归档
                            </span>
                          )}
                        </>
                      )}
                      <span
                        className={cn(
                          'shrink-0 truncate text-[12px] text-muted',
                          item.kind === 'session' || item.kind === 'project'
                            ? 'max-w-[220px]'
                            : 'max-w-[180px]',
                        )}
                        data-tip={item.meta}
                      >
                        {item.meta}
                      </span>
                      {item.shortcut && (
                        <kbd className="shrink-0 whitespace-nowrap rounded border border-border bg-[var(--t-bg-hover)] px-1.5 py-0.5 font-mono text-[11px] text-muted">
                          {formatShortcut(item.shortcut)}
                        </kbd>
                      )}
                      {item.time !== undefined && (
                        <span className="min-w-[52px] shrink-0 whitespace-nowrap text-right text-[12px] text-muted">
                          {formatRelative(item.time)}
                        </span>
                      )}
                      {item.status && (
                        <span className="flex w-2 shrink-0 justify-center">
                          <SessionStatusDot status={item.status} />
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-3 py-2 text-[12px] text-muted">
          <span className="flex items-center gap-0.5">
            {[
              { prefix: '>', label: '命令' },
              { prefix: '@', label: '会话' },
              { prefix: '#', label: '设置' },
            ].map((entry) => (
              <button
                key={entry.prefix}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery(`${entry.prefix} `)
                  inputRef.current?.focus()
                }}
                className="h-6 rounded-md px-1.5 transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text-soft"
              >
                <kbd className="font-mono">{entry.prefix}</kbd> {entry.label}
              </button>
            ))}
          </span>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setIncludeSubagents((v) => !v)}
            aria-pressed={includeSubagents}
            className={cn(
              'flex h-6 items-center gap-1 rounded-md px-2 transition-colors duration-[120ms]',
              includeSubagents
                ? 'bg-[var(--t-bg-active)] text-text'
                : 'hover:bg-[var(--t-bg-hover)] hover:text-text-soft',
            )}
          >
            <Bot size={11} /> 含子代理
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setIncludeArchived((v) => !v)}
            aria-pressed={includeArchived}
            className={cn(
              'flex h-6 items-center gap-1 rounded-md px-2 transition-colors duration-[120ms]',
              includeArchived
                ? 'bg-[var(--t-bg-active)] text-text'
                : 'hover:bg-[var(--t-bg-hover)] hover:text-text-soft',
            )}
          >
            <Archive size={11} /> 含已归档
          </button>
          <span className="ml-auto hidden items-center gap-2 sm:flex">
            <span>↑↓ 选择</span>
            <span>Enter 打开</span>
            <span>Tab 切换分组</span>
          </span>
          <span className="ml-auto flex items-center gap-1.5 sm:ml-0">
            {searching && <Spinner size={11} />}
            {searching ? '搜索中…' : `${flat.length} 个结果`}
          </span>
        </div>
      </div>
    </Modal>
  )
}
