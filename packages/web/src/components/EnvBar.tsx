import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  Folder,
  FolderOpen,
  GitBranch,
  GitFork,
  Loader2,
  RefreshCw,
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
import { Button, IconButton } from './ui/Button'
import { Input } from './ui/Controls'
import { Popover } from './ui/Popover'

const triggerClass =
  'flex h-[26px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[12.5px] leading-4 text-text-soft outline-none transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:pointer-events-none disabled:opacity-40'

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
        'flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] transition-colors hover:bg-[var(--t-bg-hover)]',
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
    <div className="w-[248px]">
      {hosts.map((h) => {
        const rt = runtimes[h.id]
        return (
          <MenuRow
            key={h.id}
            active={h.id === hostId}
            onClick={() => {
              if (h.id !== hostId) onPick(h.id)
              close()
            }}
          >
            <ConnectionDot state={rt?.status ?? 'connecting'} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{h.name}</span>
              <span className="block truncate font-mono text-[10px] text-muted">
                {h.url.replace(/^https?:\/\//, '')}
              </span>
            </span>
            {h.id === hostId && <Check size={13} className="shrink-0 text-text" />}
          </MenuRow>
        )
      })}
    </div>
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

  const go = (next: string) => {
    setPath(next)
    setDraft(next)
    setRefreshKey((k) => k + 1)
  }
  const parent = dirname(path)

  return (
    <div className="w-[min(340px,calc(100vw-2rem))]">
      {recents.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1 pb-1.5">
          {recents.slice(0, 4).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => go(d)}
              title={d}
              className={cn(
                'max-w-[140px] truncate rounded-md px-1.5 py-0.5 text-[10.5px] transition-colors',
                d === path
                  ? 'bg-[var(--t-bg-active)] text-text'
                  : 'text-muted hover:bg-[var(--t-bg-hover)] hover:text-text',
              )}
            >
              {basename(d) || d}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1 px-1 pb-1.5">
        <IconButton
          size="sm"
          onClick={() => parent && go(parent)}
          disabled={!parent}
          label="上一级"
          className="size-7 [&_svg]:size-[13px]"
        >
          <ArrowUp size={13} />
        </IconButton>
        <Input
          size="sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const next = draft.trim()
              if (next) go(next)
            }
          }}
          spellCheck={false}
          aria-label="目录路径"
          className="min-w-0 flex-1 font-mono text-[11px]"
        />
        <IconButton
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
          label="刷新目录"
          className="size-7 [&_svg]:size-3"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>
      <div className="h-[188px] overflow-y-auto rounded-lg bg-[var(--t-bg)] p-1">
        {loading && entries.length === 0 && (
          <div className="flex h-full items-center justify-center gap-2 text-[11.5px] text-muted">
            <Loader2 size={12} className="animate-spin" /> 读取目录…
          </div>
        )}
        {!loading && error && (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-[11px] text-danger">
            <TriangleAlert size={14} />
            {error}
          </div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="flex h-full items-center justify-center text-[11.5px] text-muted">
            没有子文件夹
          </div>
        )}
        {entries.map((entry) => (
          <button
            type="button"
            key={entry.path}
            onClick={() => go(entry.path)}
            className="flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
          >
            <Folder size={13} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <ChevronLeft size={11} className="shrink-0 rotate-180 text-muted opacity-40" />
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 px-1">
        <Button size="sm" variant="ghost" onClick={() => go(home ?? path)} className="text-[10.5px]">
          主目录
        </Button>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="primary"
          onClick={() => onUse(path)}
          disabled={!path}
        >
          <Check size={11} /> {useLabel}
        </Button>
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
  const [busyWorktree, setBusyWorktree] = useState(false)

  const isSession = variant === 'session'
  const migration = isSession && sessionId ? loadMigration(hostId, sessionId) : undefined
  const locked = disabled || (isSession && running) || migrating
  const branch = worktree?.branch || env?.branch
  const isWorktree = isSession ? !!summary?.worktree : !!worktreeOn

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

  const toggleWorktree = async () => {
    if (!isSession) {
      onWorktreeChange?.(!worktreeOn)
      return
    }
    if (!host || !sessionId || busyWorktree) return
    if (summary?.worktree) {
      toast('会话已在 worktree 中，可在会话菜单合并回基准分支')
      return
    }
    setBusyWorktree(true)
    try {
      await api.worktree(host, sessionId)
      void useAppStore.getState().refreshSessions(hostId)
      toast('已在 worktree 中继续', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建 worktree 失败', 'error')
    } finally {
      setBusyWorktree(false)
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto py-0.5 pb-1.5">
      <Popover
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

      <button
        type="button"
        onClick={() => void toggleWorktree()}
        disabled={locked || busyWorktree || (!isSession && !env?.repoRoot)}
        title={
          isWorktree
            ? `worktree：${worktree?.branch ?? branch ?? ''}`
            : isSession
              ? '在当前仓库创建 worktree 并切换过去'
              : env?.repoRoot
                ? '在隔离的 git worktree 中运行'
                : '当前目录不在 git 仓库中'
        }
        aria-pressed={isWorktree}
        className={cn(
          triggerClass,
          isWorktree && 'bg-[var(--t-bg-active)] text-text',
        )}
      >
        {busyWorktree ? (
          <Loader2 size={12} className="animate-spin text-muted" />
        ) : (
          <GitFork size={12} className={isWorktree ? 'text-text-soft' : 'text-muted'} />
        )}
        <span>Worktree</span>
        <span
          className={cn(
            'relative ml-0.5 h-[12px] w-[20px] shrink-0 rounded-full transition-colors',
            isWorktree ? 'bg-text-soft' : 'bg-[var(--t-bg-active)]',
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
      {migration && (
        <span className="ml-2 shrink-0 truncate text-[11px] text-muted">
          已迁移到 {migration}
        </span>
      )}
    </div>
  )
}
