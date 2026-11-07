import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Clock,
  CornerDownLeft,
  Folder,
  FolderOpen,
  GitBranch,
  GitFork,
  Loader2,
  Server,
  TriangleAlert,
} from 'lucide-react'
import type { DelegationStrategy, FsEntry, SessionEnv } from '@tandem/protocol'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { basename, dirname } from '../lib/format'
import { loadMigration, loadRecentDirs, rememberDir, rememberMigration } from '../lib/storage'
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { ConnectionDot } from './StatusDot'
import { Button } from './ui/Button'
import { Input, Switch } from './ui/Controls'
import { Menu, MenuItem, MenuList } from './ui/Menu'
import { Popover } from './ui/Popover'
import { Tooltip } from './ui/Tooltip'

/* 透明底：环境条直接坐在对话背景上，只在悬停/展开时给一点底色。 */
const triggerClass =
  'flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12.5px] leading-4 text-text-secondary outline-none transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:pointer-events-none disabled:opacity-40'

function EnvTrigger({
  icon,
  label,
  onClick,
  open,
  disabled,
  title,
  pressed,
}: {
  icon: ReactNode
  label: string
  onClick?: () => void
  open?: boolean
  disabled?: boolean
  title?: string
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-pressed={pressed}
      className={cn(
        triggerClass,
        (open || pressed) && 'bg-[var(--t-bg-active)] text-text',
        disabled && 'opacity-40',
      )}
    >
      {icon}
      <span className="max-w-[160px] truncate">{label}</span>
      {!pressed && <ChevronDown size={11} className="shrink-0 text-muted" />}
    </button>
  )
}

/** 末尾分隔符仅在盘符根上保留，其余去掉（Windows 下 "C:" 表示该盘当前目录）。 */
function cleanDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (!trimmed) return path
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed
}

function sepOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/** 前缀或子序列模糊匹配（大小写不敏感）。 */
function fuzzyMatch(name: string, query: string): boolean {
  if (!query) return true
  const n = name.toLowerCase()
  const q = query.toLowerCase()
  if (n.includes(q)) return true
  let i = 0
  for (const ch of n) {
    if (ch === q[i]) i += 1
    if (i === q.length) return true
  }
  return false
}

/**
 * 输入框既是筛选词也是路径：
 * - 以当前目录开头、后面没有分隔符 → 在当前目录里筛选；
 * - 其余含分隔符的输入 → 按路径导航（目录部分进入，末段作为筛选词）。
 */
function parseDraft(draft: string, current: string): { dir: string; query: string } {
  const value = draft.trim()
  if (!value) return { dir: current, query: '' }
  const fixed = current.replace(/[\\/]+$/, '')
  if (fixed && value.toLowerCase().startsWith(fixed.toLowerCase())) {
    const rest = value.slice(fixed.length).replace(/^[\\/]/, '')
    if (!/[\\/]/.test(rest)) return { dir: current, query: rest }
  }
  const sep = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (sep < 0) return { dir: current, query: value }
  const dir = value.slice(0, sep + 1)
  if (dir.replace(/[\\/]+$/, '').toLowerCase() === fixed.toLowerCase()) {
    return { dir: current, query: value.slice(sep + 1) }
  }
  return { dir, query: value.slice(sep + 1) }
}

function HostMenu({
  hostId,
  onPick,
  keepOpen,
}: {
  hostId: string
  onPick: (id: string) => void
  keepOpen?: boolean
}) {
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  return (
    <>
      {hosts.map((h) => {
        const rt = runtimes[h.id]
        const detail = [
          h.url.replace(/^https?:\/\//, ''),
          rt?.info?.platform,
          h.mode === 'relay' ? '中继 · 加密' : '直连',
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <Menu.Item
            key={h.id}
            icon={<ConnectionDot state={rt?.status ?? 'connecting'} />}
            selected={h.id === hostId}
            hint={detail}
            keepOpen={keepOpen}
            onSelect={() => {
              if (h.id !== hostId) onPick(h.id)
            }}
          >
            {h.name}
          </Menu.Item>
        )
      })}
    </>
  )
}

/** 目录浏览器：最近目录 + 逐级浏览；新会话与迁移目标目录共用。 */
export function FolderBrowser({
  hostId,
  initial,
  onUse,
  useLabel = '使用此目录',
}: {
  hostId: string
  initial?: string
  onUse: (path: string) => void
  useLabel?: string
}) {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const home = useAppStore((s) => (hostId ? s.runtimes[hostId]?.info?.homeDir : undefined))
  const recents = useMemo(() => loadRecentDirs(hostId), [hostId])
  const [path, setPath] = useState(initial || home || '')
  const [draft, setDraft] = useState(initial || home || '')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!initial && home) {
      setPath((prev) => prev || home)
      setDraft((prev) => prev || home)
    }
  }, [home, initial])

  // 输入里的目录部分变化时切换浏览目录；筛选词不触发请求。
  const parsed = useMemo(() => parseDraft(draft, path || home || ''), [draft, path, home])
  const query = parsed.query
  useEffect(() => {
    if (parsed.dir && parsed.dir !== path) setPath(parsed.dir)
  }, [parsed.dir, path])

  useEffect(() => {
    if (!host || !path) return
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .fsList(host, path)
      .then((list) => {
        if (cancelled) return
        setEntries(
          list.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
        )
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setEntries([])
        setError(err instanceof Error ? err.message : '无法读取目录')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, path, refreshKey])

  const open = (next: string) => {
    setPath(next)
    setDraft(next + sepOf(next))
    setRefreshKey((k) => k + 1)
  }

  const filtered = useMemo(() => {
    const q = query.trim()
    if (!q) return entries
    const lower = q.toLowerCase()
    return entries
      .filter((entry) => fuzzyMatch(entry.name, q))
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(lower) ? 0 : 1
        const bp = b.name.toLowerCase().startsWith(lower) ? 0 : 1
        return ap - bp || a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
  }, [entries, query])

  const useCurrent = () => {
    const q = query.trim().toLowerCase()
    let target = parsed.dir || path
    if (q) {
      const exact = filtered.find((entry) => entry.name.toLowerCase() === q)
      if (exact) target = exact.path
      else if (filtered.length === 1) target = filtered[0].path
      else if (/[\\/]/.test(draft.trim())) target = draft.trim()
    }
    if (target) onUse(cleanDir(target))
  }

  const parent = dirname(path)
  const complete = () => {
    if (!query.trim()) return
    const match = filtered[0]
    if (match) open(match.path)
  }

  return (
    <div className="flex w-[min(300px,calc(100vw-2rem))] flex-col gap-1">
      <div className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-[var(--t-bg-hover)] pl-2 pr-1">
        <Folder size={13} className="shrink-0 text-muted" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              if (!e.nativeEvent.isComposing) useCurrent()
            } else if (e.key === 'Tab') {
              e.preventDefault()
              e.stopPropagation()
              complete()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              listRef.current
                ?.querySelector<HTMLElement>('[data-menu-item]:not(:disabled)')
                ?.focus()
            }
          }}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          aria-label="筛选文件夹或输入路径"
          placeholder="筛选文件夹，或输入路径"
          className="h-full min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text outline-none placeholder:font-sans placeholder:text-[12.5px] placeholder:text-muted"
        />
        <button
          type="button"
          onClick={useCurrent}
          aria-label={useLabel}
          title={`${useLabel} (Enter)`}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-[var(--t-bg-active)] hover:text-text"
        >
          <CornerDownLeft size={13} />
        </button>
      </div>

      <div ref={listRef} className="max-h-[264px] overflow-y-auto">
        <MenuList aria-label="选择文件夹" className="p-0">
          {!query.trim() &&
            recents.slice(0, 4).map((d) => (
              <MenuItem key={d} icon={<Clock size={13} />} hint={d} onSelect={() => open(d)}>
                {basename(d) || d}
              </MenuItem>
            ))}
          <MenuItem
            icon={<ArrowUp size={13} />}
            disabled={!parent}
            disabledReason="已经是根目录"
            onSelect={() => parent && open(parent)}
          >
            ..
          </MenuItem>
          {loading && entries.length === 0 && (
            <div className="flex h-[120px] items-center justify-center gap-2 text-[11.5px] text-muted">
              <Loader2 size={12} className="animate-spin" /> 读取目录…
            </div>
          )}
          {!loading && error && (
            <div className="flex h-[120px] flex-col items-center justify-center gap-1 px-4 text-center text-[11px] text-danger">
              <TriangleAlert size={14} />
              {error}
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="flex h-[120px] items-center justify-center text-[11.5px] text-muted">
              {query.trim() ? '没有匹配的文件夹' : '没有子文件夹'}
            </div>
          )}
          {filtered.map((entry) => (
            <MenuItem
              key={entry.path}
              icon={<Folder size={13} />}
              title={entry.path}
              onSelect={() => open(entry.path)}
            >
              {entry.name}
            </MenuItem>
          ))}
        </MenuList>
      </div>
    </div>
  )
}

function BranchMenu({
  hostId,
  sessionId,
  current,
  disabled,
  onDone,
  close,
}: {
  hostId: string
  sessionId: string
  current?: string
  disabled?: boolean
  onDone: () => void
  close: () => void
}) {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const toast = useUiStore((s) => s.toast)
  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  useEffect(() => {
    if (!host) return
    let cancelled = false
    api
      .branches(host, sessionId)
      .then((res) => {
        if (!cancelled) setBranches(res.branches)
      })
      .catch((err) => {
        if (!cancelled) toast(err instanceof Error ? err.message : '读取分支失败', 'error')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, sessionId, toast])

  const run = async (branch: string, create: boolean) => {
    if (!host || busy) return
    setBusy(true)
    try {
      await api.checkout(host, sessionId, branch, create)
      void useAppStore.getState().refreshSessions(hostId)
      toast(`已切换到分支 ${branch}`, 'success')
      onDone()
      close()
    } catch (err) {
      toast(err instanceof Error ? err.message : '切换分支失败', 'error')
      setBusy(false)
    }
  }

  return (
    <div className="w-[240px]">
      <MenuList aria-label="切换分支" className="max-h-[260px] overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 px-2 py-2 text-[11.5px] text-muted">
            <Loader2 size={12} className="animate-spin" /> 读取分支…
          </div>
        )}
        {!loading &&
          branches.map((branch) => (
            <MenuItem
              key={branch}
              icon={<GitBranch size={13} />}
              selected={branch === current}
              title={branch}
              onSelect={() => void run(branch, false)}
            >
              <span className="font-mono text-[12.5px]">{branch}</span>
            </MenuItem>
          ))}
        {!loading && branches.length === 0 && (
          <p className="px-2 py-2 text-[11.5px] text-muted">当前目录不是 git 仓库</p>
        )}
      </MenuList>
      <div className="mt-1 border-t border-border pt-1">
        {creating ? (
          <div className="flex items-center gap-1 px-1">
            <Input
              size="sm"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="新分支名"
              spellCheck={false}
              aria-label="新分支名"
              className="min-w-0 flex-1 font-mono text-[11.5px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) void run(name.trim(), true)
              }}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!name.trim() || busy}
              onClick={() => void run(name.trim(), true)}
            >
              创建
            </Button>
          </div>
        ) : (
          <MenuItem icon={<span className="text-[15px] leading-none">+</span>} onSelect={() => setCreating(true)}>
            新建分支…
          </MenuItem>
        )}
      </div>
    </div>
  )
}

export interface EnvBarProps {
  variant: 'session' | 'new'
  hostId: string
  cwd: string
  env?: SessionEnv
  worktree?: { branch: string; baseBranch: string }
  /** 新会话页的本地 worktree 开关。 */
  worktreeOn?: boolean
  onHostChange?: (hostId: string) => void
  onCwdChange?: (cwd: string) => void
  onWorktreeChange?: (on: boolean) => void
  /** 新会话页的委派策略；会话内直接从 summary 读取。 */
  delegation?: DelegationStrategy
  onDelegationChange?: (strategy: DelegationStrategy) => void
  disabled?: boolean
}

const DELEGATION_OPTIONS: Array<{ value: DelegationStrategy; label: string; hint: string }> = [
  { value: 'orchestrate', label: '编排', hint: '主会话只规划/汇总，读写与命令交给子代理' },
  { value: 'more', label: '多派', hint: '鼓励并行派发独立子任务' },
  { value: 'less', label: '少派', hint: '只有明显独立且多步的任务才派（默认）' },
  { value: 'none', label: '不派', hint: '不提供 Task 工具，主会话自己完成' },
]

/**
 * 输入框上方的环境条：主机 / 文件夹 / 分支 / Worktree。
 * 会话内切换主机 = 导出会话 → 目标 Host 导入 → 跳到新会话。
 */
export function EnvBar({
  variant,
  hostId,
  cwd,
  env,
  worktree,
  worktreeOn,
  onHostChange,
  onCwdChange,
  onWorktreeChange,
  delegation: delegationProp,
  onDelegationChange,
  disabled,
}: EnvBarProps) {
  const hosts = useAppStore((s) => s.hosts)
  const host = hosts.find((h) => h.id === hostId) ?? null
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const running = useAppStore((s) => s.active?.running ?? false)
  const toast = useUiStore((s) => s.toast)

  const [savingDelegation, setSavingDelegation] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [targetHostId, setTargetHostId] = useState<string | null>(null)

  const isSession = variant === 'session'
  const migration = isSession && sessionId ? loadMigration(hostId, sessionId) : undefined
  const locked = disabled || (isSession && running) || migrating
  const branch = worktree?.branch || env?.branch
  const worktreeIntent = useAppStore((s) =>
    sessionId ? !!s.worktreeIntents[`${hostId}:${sessionId}`] : false,
  )
  const setWorktreeIntent = useAppStore((s) => s.setWorktreeIntent)
  const isWorktree = isSession ? !!summary?.worktree || worktreeIntent : !!worktreeOn
  const worktreeTip = !isSession
    ? env?.repoRoot
      ? '将在创建会话时创建隔离分支'
      : '当前目录不在 git 仓库中'
    : summary?.worktree
      ? `worktree：${worktree?.branch ?? branch ?? ''}`
      : worktreeIntent
        ? '将在发送下一条消息时创建隔离分支（再次点击取消）'
        : '将在发送下一条消息时创建隔离分支'

  const startMigration = async (nextHostId: string, targetCwd: string) => {
    if (!host || !sessionId || migrating) return
    const target = hosts.find((h) => h.id === nextHostId)
    if (!target) return
    setMigrating(true)
    try {
      const full = await api.exportSession(host, sessionId)
      const created = await api.importSession(target, { session: full, cwd: targetCwd })
      // 项目记忆跟着会话走：目标 Host 已有记忆时由 Host 合并追加并标注来源。
      try {
        const memory = await api.memory(host, 'project', full.cwd)
        if (memory.exists && memory.text.trim()) {
          await api.importMemory(target, {
            project: targetCwd,
            text: memory.text,
            source: host.name,
          })
        }
      } catch {
        // 记忆迁移失败不影响会话迁移本身
      }
      rememberMigration(hostId, sessionId, target.name)
      rememberDir(target.id, targetCwd)
      await useAppStore.getState().refreshSessions(target.id)
      toast(`会话已迁移到 ${target.name}`, 'success')
      navigate({ kind: 'session', hostId: target.id, sessionId: created.id })
    } catch (err) {
      toast(err instanceof Error ? err.message : '迁移会话失败', 'error')
    } finally {
      setMigrating(false)
      setTargetHostId(null)
    }
  }

  const toggleWorktree = () => {
    if (!isSession) {
      onWorktreeChange?.(!worktreeOn)
      return
    }
    if (!hostId || !sessionId) return
    if (summary?.worktree) {
      toast('会话已在 worktree 中，可在会话菜单合并回基准分支')
      return
    }
    setWorktreeIntent(hostId, sessionId, !worktreeIntent)
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto pb-1.5 sm:gap-1">
      <Menu
        side="top"
        align="left"
        className={targetHostId ? 'w-auto p-1' : 'w-auto min-w-[200px]'}
        aria-label={isSession ? '切换主机' : '选择 Host'}
        trigger={({ open }) => (
          <EnvTrigger
            icon={
              migrating ? (
                <Loader2 size={12} className="animate-spin text-muted" />
              ) : (
                <Server size={12} className="text-muted" />
              )
            }
            label={migrating ? '迁移中…' : host?.name ?? '主机'}
            onClick={() => setTargetHostId(null)}
            open={open}
            disabled={!!locked && !migrating}
            title={isSession ? '切换主机（会话将迁移到目标 Host）' : '选择 Host'}
          />
        )}
      >
        {targetHostId ? (
          <div>
            <div className="px-1 pb-1.5 text-[12px] text-muted">
              选择 {hosts.find((h) => h.id === targetHostId)?.name} 上的目录
            </div>
            <FolderBrowser
              hostId={targetHostId}
              onUse={(path) => {
                void startMigration(targetHostId, path)
                setTargetHostId(null)
              }}
              useLabel="迁移到此目录"
            />
          </div>
        ) : (
          <HostMenu
            hostId={hostId}
            keepOpen={isSession}
            onPick={(id) => {
              if (!isSession) {
                onHostChange?.(id)
                return
              }
              setTargetHostId(id)
            }}
          />
        )}
      </Menu>
      <Popover
        side="top"
        padded={false}
        panelClassName="w-auto rounded-[10px] p-[5px]"
        trigger={({ open, toggle }) => (
          <EnvTrigger
            icon={<FolderOpen size={12} className="text-muted" />}
            label={cwd ? basename(cwd) || cwd : '文件夹'}
            onClick={toggle}
            open={open}
            disabled={locked || !hostId}
            title={cwd}
          />
        )}
      >
        {(close) =>
          hostId ? (
            <FolderBrowser
              hostId={hostId}
              initial={cwd}
              onUse={(path) => {
                if (isSession) {
                  if (host && sessionId) {
                    void useAppStore
                      .getState()
                      .updateSession(host.id, sessionId, { cwd: path })
                      .then((updated) => {
                        if (updated) {
                          rememberDir(host.id, path)
                          toast('已切换工作目录（下一轮生效）', 'success')
                        }
                      })
                  }
                } else {
                  onCwdChange?.(path)
                  rememberDir(hostId, path)
                }
                close()
              }}
            />
          ) : null
        }
      </Popover>

      <Popover
        side="top"
        padded={false}
        className={cn('shrink-0', !isSession && !env?.repoRoot && 'max-sm:hidden')}
        panelClassName="w-auto rounded-[10px] p-[5px]"
        trigger={({ open, toggle }) => (
          <EnvTrigger
            icon={
              isWorktree ? (
                <GitFork size={12} className="text-muted" />
              ) : (
                <GitBranch size={12} className="text-muted" />
              )
            }
            label={branch ?? (env ? '分支' : '非 Git 仓库')}
            onClick={toggle}
            open={open}
            disabled={locked || !isSession || !sessionId || !env?.repoRoot}
            title={
              isSession ? '切换分支' : '创建会话后可切换分支'
            }
          />
        )}
      >
        {(close) =>
          isSession && sessionId && host ? (
            <BranchMenu
              hostId={host.id}
              sessionId={sessionId}
              current={env?.branch}
              disabled={locked}
              onDone={() => void useAppStore.getState().refreshSessions(hostId)}
              close={close}
            />
          ) : null
        }
      </Popover>

      <Popover
        side="top"
        align="left"
        className="shrink-0"
        panelClassName="w-[240px]"
        trigger={({ open, toggle }) => {
          const strategy = isSession ? summary?.delegation ?? 'less' : delegationProp ?? 'less'
          const current = DELEGATION_OPTIONS.find((item) => item.value === strategy) ?? DELEGATION_OPTIONS[2]
          return (
            <EnvTrigger
              icon={<Bot size={12} className="text-muted" />}
              label={savingDelegation ? '保存中…' : current.label}
              onClick={toggle}
              open={open}
              disabled={locked && !isSession}
              title={`委派策略：${current.hint}`}
            />
          )
        }}
      >
        {(close) => {
          const strategy = isSession ? summary?.delegation ?? 'less' : delegationProp ?? 'less'
          return (
            <div className="p-0.5">
              {DELEGATION_OPTIONS.map((option) => (
                <MenuItem
                  key={option.value}
                  selected={option.value === strategy}
                  hint={option.hint}
                  onSelect={() => {
                    close()
                    if (option.value === strategy) return
                    if (!isSession) {
                      onDelegationChange?.(option.value)
                      return
                    }
                    if (!host || !sessionId) return
                    setSavingDelegation(true)
                    void useAppStore
                      .getState()
                      .updateSession(host.id, sessionId, { delegation: option.value })
                      .finally(() => setSavingDelegation(false))
                  }}
                >
                  {option.label}
                </MenuItem>
              ))}
            </div>
          )
        }}
      </Popover>

      <Tooltip label={worktreeTip} side="top" className="shrink-0">
        <div
          className={cn(
            triggerClass,
            'inline-flex cursor-default',
            isWorktree && 'bg-[var(--t-bg-active)] text-text',
          )}
        >
          <GitFork size={12} className={isWorktree ? 'text-text-soft' : 'text-muted'} />
          <span className="hidden sm:inline">Worktree</span>
          <Switch
            checked={isWorktree}
            onChange={toggleWorktree}
            disabled={locked || (!isSession && !env?.repoRoot)}
            label="Worktree"
            className="ml-0.5"
          />
        </div>
      </Tooltip>
      {migration && (
        <span className="ml-2 shrink-0 truncate text-[11px] text-muted">
          已迁移到 {migration}
        </span>
      )}
    </div>
  )
}
