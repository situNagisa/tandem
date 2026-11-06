import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock,
  Folder,
  FolderOpen,
  GitBranch,
  GitFork,
  Loader2,
  Server,
  TriangleAlert,
} from 'lucide-react'
import type { FsEntry, SessionEnv } from '@tandem/protocol'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { basename, dirname } from '../lib/format'
import { loadMigration, loadRecentDirs, rememberDir, rememberMigration } from '../lib/storage'
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { ConnectionDot } from './StatusDot'
import { Button } from './ui/Button'
import { Input } from './ui/Controls'
import { MenuDivider, MenuItem, MenuList } from './ui/Menu'
import { Popover } from './ui/Popover'
import { Tooltip } from './ui/Tooltip'

const triggerClass =
  'flex h-6 shrink-0 items-center gap-1 rounded-lg bg-[var(--t-bg-subtle)] px-2 text-[12.5px] leading-4 text-text-secondary outline-none transition-colors hover:bg-[var(--t-bg-active)] hover:text-text disabled:pointer-events-none disabled:opacity-40'

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
  onClick: () => void
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

function MenuRow({
  onClick,
  children,
  active,
}: {
  onClick: () => void
  children: ReactNode
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-[26px] w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--t-bg-hover)]',
        active ? 'text-text' : 'text-text-soft',
      )}
    >
      {children}
    </button>
  )
}

function HostMenu({
  hostId,
  onPick,
  close,
}: {
  hostId: string
  onPick: (id: string) => void
  close: () => void
}) {
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  return (
    <MenuList aria-label="切换主机" className="w-[248px]">
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
          <MenuItem
            key={h.id}
            icon={<ConnectionDot state={rt?.status ?? 'connecting'} />}
            selected={h.id === hostId}
            hint={detail}
            onSelect={() => {
              if (h.id !== hostId) onPick(h.id)
              close()
            }}
          >
            {h.name}
          </MenuItem>
        )
      })}
    </MenuList>
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

  useEffect(() => {
    if (!initial && home) {
      setPath((prev) => prev || home)
      setDraft((prev) => prev || home)
    }
  }, [home, initial])

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
    setDraft(next)
    setRefreshKey((k) => k + 1)
  }
  const parent = dirname(path)

  // Tab 补全：用当前输入最后一段匹配到的子目录名替换。
  const complete = () => {
    const idx = Math.max(draft.lastIndexOf('/'), draft.lastIndexOf('\\'))
    const prefix = draft.slice(idx + 1)
    const match = entries.find((e) => e.name.toLowerCase().startsWith(prefix.toLowerCase()))
    if (match) setDraft(draft.slice(0, idx + 1) + match.name)
  }

  const rowClass =
    'flex h-[26px] w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[12.5px] leading-none text-text-soft outline-none transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text focus-visible:bg-[var(--t-bg-hover)] focus-visible:text-text'

  return (
    <div className="w-[min(320px,calc(100vw-2rem))]">
      <MenuList aria-label="选择文件夹">
        <div className="max-h-[264px] overflow-y-auto">
          {recents.length > 0 && (
            <>
              {recents.slice(0, 4).map((d) => (
                <MenuItem key={d} icon={<Clock size={13} />} hint={d} onSelect={() => open(d)}>
                  {basename(d) || d}
                </MenuItem>
              ))}
              <MenuDivider />
            </>
          )}
          <MenuItem
            icon={<ArrowUp size={13} />}
            disabled={!parent}
            disabledReason="已经是根目录"
            onSelect={() => parent && open(parent)}
          >
            ..
          </MenuItem>
          {loading && entries.length === 0 && (
            <div className="flex h-[150px] items-center justify-center gap-2 text-[11.5px] text-muted">
              <Loader2 size={12} className="animate-spin" /> 读取目录…
            </div>
          )}
          {!loading && error && (
            <div className="flex h-[150px] flex-col items-center justify-center gap-1 px-4 text-center text-[11px] text-danger">
              <TriangleAlert size={14} />
              {error}
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="flex h-[150px] items-center justify-center text-[11.5px] text-muted">
              没有子文件夹
            </div>
          )}
          {entries.map((entry) => (
            <div key={entry.path} className="group/dir relative">
              <button
                type="button"
                data-menu-item=""
                onClick={() => open(entry.path)}
                onDoubleClick={() => onUse(entry.path)}
                className={cn(rowClass, 'pr-8')}
              >
                <Folder size={13} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
              <button
                type="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation()
                  onUse(entry.path)
                }}
                aria-label={`选择 ${entry.name}`}
                className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted opacity-70 transition-opacity hover:bg-[var(--t-bg-hover)] hover:text-text md:opacity-0 md:group-hover/dir:opacity-100 md:focus-visible:opacity-100"
              >
                <Check size={12} />
              </button>
            </div>
          ))}
        </div>
        <MenuDivider />
        <MenuItem
          icon={<Check size={13} />}
          disabled={!path}
          disabledReason="还没有打开任何目录"
          onSelect={() => onUse(path)}
        >
          {useLabel}
        </MenuItem>
      </MenuList>
      <div className="mt-1 border-t border-border pt-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const next = draft.trim()
              if (next) onUse(next)
            } else if (e.key === 'Tab') {
              e.preventDefault()
              complete()
            }
          }}
          spellCheck={false}
          autoComplete="off"
          aria-label="目录路径"
          placeholder="输入绝对路径，Enter 选定"
          className="h-8 w-full min-w-0 bg-transparent px-2 font-mono text-[11.5px] text-text outline-none placeholder:text-muted"
        />
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
      <div className="max-h-[260px] overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 px-2 py-2 text-[11.5px] text-muted">
            <Loader2 size={12} className="animate-spin" /> 读取分支…
          </div>
        )}
        {!loading &&
          branches.map((branch) => (
            <MenuRow
              key={branch}
              active={branch === current}
              onClick={() => void run(branch, false)}
            >
              <GitBranch size={13} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{branch}</span>
              {branch === current && <Check size={13} className="shrink-0 text-text" />}
            </MenuRow>
          ))}
        {!loading && branches.length === 0 && (
          <p className="px-2 py-2 text-[11.5px] text-muted">当前目录不是 git 仓库</p>
        )}
      </div>
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
          <MenuRow onClick={() => setCreating(true)}>
            <span className="text-[15px] leading-none">+</span>
            <span>新建分支…</span>
          </MenuRow>
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
  disabled?: boolean
}

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
  disabled,
}: EnvBarProps) {
  const hosts = useAppStore((s) => s.hosts)
  const host = hosts.find((h) => h.id === hostId) ?? null
  const summary = useAppStore((s) => s.active?.summary ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const running = useAppStore((s) => s.active?.running ?? false)
  const toast = useUiStore((s) => s.toast)

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
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto pb-1.5">
      <Popover
        side="top"
        panelClassName="w-auto"
        trigger={({ open, toggle }) => (
          <EnvTrigger
            icon={
              migrating ? (
                <Loader2 size={12} className="animate-spin text-muted" />
              ) : (
                <Server size={12} className="text-muted" />
              )
            }
            label={migrating ? '迁移中…' : host?.name ?? '主机'}
            onClick={() => {
              setTargetHostId(null)
              toggle()
            }}
            open={open}
            disabled={!!locked && !migrating}
            title={isSession ? '切换主机（会话将迁移到目标 Host）' : '选择 Host'}
          />
        )}
      >
        {(close) =>
          targetHostId ? (
            <div>
              <div className="px-1 pb-1.5 text-[11px] text-muted">
                选择 {hosts.find((h) => h.id === targetHostId)?.name} 上的目录
              </div>
              <FolderBrowser
                hostId={targetHostId}
                onUse={(path) => {
                  void startMigration(targetHostId, path)
                  close()
                }}
                useLabel="迁移到此目录"
              />
            </div>
          ) : (
            <HostMenu
              hostId={hostId}
              onPick={(id) => {
                if (!isSession) {
                  onHostChange?.(id)
                  return
                }
                setTargetHostId(id)
              }}
              close={() => {
                if (!isSession) close()
              }}
            />
          )
        }
      </Popover>

      <Popover
        side="top"
        panelClassName="w-auto"
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
        panelClassName="w-auto"
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

      <Tooltip label={worktreeTip} side="top" className="shrink-0">
        <button
          type="button"
          onClick={toggleWorktree}
          disabled={locked || (!isSession && !env?.repoRoot)}
          aria-pressed={isWorktree}
          className={cn(
            triggerClass,
            'inline-flex',
            isWorktree && 'bg-[var(--t-bg-active)] text-text',
          )}
        >
          <GitFork size={12} className={isWorktree ? 'text-text-soft' : 'text-muted'} />
          <span>Worktree</span>
          <span
            className={cn(
              'relative ml-0.5 h-[12px] w-[20px] shrink-0 rounded-full transition-colors',
              isWorktree ? 'bg-text-soft' : 'bg-[var(--t-border-strong)]',
            )}
          >
            <span
              className={cn(
                'absolute top-[2px] size-2 rounded-full bg-bg transition-[left]',
                isWorktree ? 'left-[10px]' : 'left-[2px]',
              )}
            />
          </span>
        </button>
      </Tooltip>
      {migration && (
        <span className="ml-2 shrink-0 truncate text-[11px] text-muted">
          已迁移到 {migration}
        </span>
      )}
    </div>
  )
}
