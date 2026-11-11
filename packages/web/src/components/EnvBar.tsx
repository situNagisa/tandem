import { forwardRef, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  CornerDownLeft,
  Folder,
  FolderOpen,
  GitBranch,
  GitFork,
  Monitor,
  Smartphone,
  TriangleAlert,
  Undo2,
  Usb,
} from 'lucide-react'
import { Spinner } from './ui/Spinner'
import type { DeviceMount, FsEntry, SessionEnv } from '@tandem/protocol'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useDevicesStore } from '../store/useDevicesStore'
import { basename, dirname } from '../lib/format'
import { loadMigration, loadRecentDirs, rememberDir, rememberMigration } from '../lib/storage'
import { navigate } from '../lib/router'
import { useSessionView } from './session/SessionScope'
import { cn } from '../lib/cn'
import { ConnectionDot } from './StatusDot'
import { Button, IconButton } from './ui/Button'
import { Input, Switch } from './ui/Controls'
import { Menu, MenuItem, MenuList } from './ui/Menu'
import { Popover } from './ui/Popover'

import { Tooltip } from './ui/Tooltip'

const EMPTY_DEVICE_MOUNTS: DeviceMount[] = []

/* 透明底：环境条直接坐在对话背景上，只在悬停/展开时给一点底色。 */
const triggerClass =
  'flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] leading-4 text-text-secondary outline-none transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:pointer-events-none disabled:opacity-40 max-sm:h-11 max-sm:px-2'

interface EnvTriggerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  icon: ReactNode
  label: ReactNode
  onClick?: () => void
  open?: boolean
  title?: string
  pressed?: boolean
  /** 数据未就绪：显示骨架而不是“分支”这类占位词。 */
  loading?: boolean
}

/**
 * 环境条触发器。Radix 的 Menu.Trigger 会通过 asChild 注入 pointerdown/keydown/ref，
 * 必须原样转发到真实 button，否则“选择主机”点了没反应（反馈 #11）。
 */
const EnvTrigger = forwardRef<HTMLButtonElement, EnvTriggerProps>(function EnvTrigger(
  { icon, label, onClick, open, disabled, title, pressed, loading, className, ...rest },
  ref,
) {
  return (
    <button data-raw-button
      {...rest}
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-tip={title}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-pressed={pressed}
      className={cn(
        triggerClass,
        (open || pressed) && 'bg-[var(--t-bg-active)] text-text',
        disabled && 'opacity-40',
        className,
      )}
    >
      {icon}
      {loading ? (
        <span
          role="status"
          aria-label="读取中"
          className="inline-block h-3 w-12 animate-pulse rounded bg-[var(--t-bg-active)]"
        />
      ) : (
        <span className="max-w-[160px] truncate max-sm:max-w-[96px]">{label}</span>
      )}
      {!pressed && <ChevronDown size={11} className="shrink-0 text-muted max-sm:hidden" />}
    </button>
  )
})

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
  pendingHostId,
  onPick,
  keepOpen,
}: {
  hostId: string
  pendingHostId?: string | null
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
          h.mode === 'relay' ? '加密隧道' : '直连',
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
            trailing={
              h.id === pendingHostId ? (
                <span data-host-tag="pending" className="text-[11px] text-text-soft">
                  待切换
                </span>
              ) : h.id === hostId ? (
                <span data-host-tag="current" className="text-[11px] text-muted">
                  当前
                </span>
              ) : undefined
            }
            onSelect={() => {
              if (h.id !== hostId && h.id !== pendingHostId) onPick(h.id)
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
        <button data-raw-button
          type="button"
          onClick={useCurrent}
          aria-label={useLabel}
          data-tip={`${useLabel} (Enter)`}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-[var(--t-bg-active)] hover:text-text"
        >
          <CornerDownLeft size={13} />
        </button>
      </div>

      {/* 固定高度：目录异步读回、切换目录时面板尺寸不变（R52 复发：点开先抖一下）。 */}
      <div ref={listRef} className="h-[264px] overflow-y-auto">
        <MenuList aria-label="选择文件夹" className="p-0">
          <MenuItem
            icon={<ArrowUp size={13} />}
            disabled={!parent}
            disabledReason="已经是根目录"
            onSelect={() => parent && open(parent)}
          >
            ..
          </MenuItem>
          {loading && entries.length === 0 && (
            <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted">
              <Spinner size={12} /> 读取目录…
            </div>
          )}
          {!loading && error && (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-[12px] text-danger">
              <TriangleAlert size={14} />
              {error}
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="flex h-full items-center justify-center text-[12px] text-muted">
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
      {/* 固定高度：分支异步读回时面板尺寸不变（R52 复发）。 */}
      <MenuList aria-label="切换分支" className="h-[220px] overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 px-2 py-2 text-[12px] text-muted">
            <Spinner size={12} /> 读取分支…
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
          <p className="px-2 py-2 text-[12px] text-muted">当前目录不是 git 仓库</p>
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
              className="min-w-0 flex-1 font-mono text-[12px]"
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

export interface PendingHostSwitch {
  hostId: string
  hostName: string
  currentHostName: string
}

export interface EnvBarProps {
  variant: 'session' | 'new'
  hostId: string
  cwd: string
  env?: SessionEnv
  worktree?: { branch: string; baseBranch: string }
  /** 新会话页的本地 worktree 开关。 */
  worktreeOn?: boolean
  /** 目录的 git 环境仍在探测：分支触发器显示骨架。 */
  envLoading?: boolean
  onHostChange?: (hostId: string) => void
  onCwdChange?: (cwd: string) => void
  onWorktreeChange?: (on: boolean) => void
  /** 会话内选了另一台主机、还没选文件夹时的待定状态；输入框据此禁用。 */
  onPendingChange?: (pending: PendingHostSwitch | null) => void
  disabled?: boolean
  /** 分屏窄窗格：只保留图标，文字折叠。 */
  compact?: boolean
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
  envLoading,
  onHostChange,
  onCwdChange,
  onWorktreeChange,
  onPendingChange,
  disabled,
  compact = false,
}: EnvBarProps) {
  const hosts = useAppStore((s) => s.hosts)
  const host = hosts.find((h) => h.id === hostId) ?? null
  const summary = useSessionView((s) => s?.summary ?? null)
  const sessionId = useSessionView((s) => s?.sessionId ?? null)
  const running = useSessionView((s) => s?.running ?? false)
  const toast = useUiStore((s) => s.toast)
  const sessionMounts = useDevicesStore((s) => (sessionId ? s.sessionMounts[`${hostId}:${sessionId}`] ?? EMPTY_DEVICE_MOUNTS : EMPTY_DEVICE_MOUNTS))
  const openTerminal = useDevicesStore((s) => s.openTerminal)
  const setWorkstationOpen = useDevicesStore((s) => s.setWorkstationOpen)

  const [migrating, setMigrating] = useState(false)
  // 反馈13#02：选了另一台主机后先不切换，等用户在「文件夹」胶囊里选好目标目录。
  const [pendingHostId, setPendingHostId] = useState<string | null>(null)
  const [hostMenuOpen, setHostMenuOpen] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const pendingHost = pendingHostId ? (hosts.find((h) => h.id === pendingHostId) ?? null) : null

  // 换会话/换主机时清掉待定状态，避免提示残留在别的会话上。
  useEffect(() => {
    setPendingHostId(null)
    setHostMenuOpen(false)
    setFolderOpen(false)
  }, [hostId, sessionId])

  // 选中新主机后直接打开该主机的文件夹选择；等主机菜单收起、焦点回到环境条后再打开，
  // 否则菜单关闭时的焦点恢复会把刚打开的文件选择弹层当成「焦点移出」收掉。
  useEffect(() => {
    if (!pendingHostId) return
    const timer = window.setTimeout(() => setFolderOpen(true), 80)
    return () => window.clearTimeout(timer)
  }, [pendingHostId])

  useEffect(() => {
    onPendingChange?.(
      pendingHost && host
        ? { hostId: pendingHost.id, hostName: pendingHost.name, currentHostName: host.name }
        : null,
    )
  }, [pendingHost?.id, pendingHost?.name, host?.name, onPendingChange])

  const isSession = variant === 'session'
  useEffect(() => {
    if (!isSession || !sessionId || !host) return
    void useDevicesStore.getState().refreshSession(host, sessionId)
  }, [host?.id, sessionId, isSession])

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
      setPendingHostId(null)
      setFolderOpen(false)
      await useAppStore.getState().refreshSessions(target.id)
      toast(`会话已迁移到 ${target.name}`, 'success')
      navigate({ kind: 'session', hostId: target.id, sessionId: created.id })
    } catch (err) {
      toast(err instanceof Error ? err.message : '迁移会话失败', 'error')
    } finally {
      setMigrating(false)
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
    <div className="flex min-w-0 flex-col bg-transparent" data-env-bar="">
    <div
      data-env-bar-row=""
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-0.5 bg-transparent pb-1.5 sm:flex-nowrap sm:gap-1',
        'max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:pb-1',
        compact &&
          'flex-nowrap gap-0.5 pb-1 sm:[&_button>span]:hidden sm:[&_button>svg.lucide-chevron-down]:hidden',
      )}
    >
      <Menu
        open={hostMenuOpen}
        onOpenChange={setHostMenuOpen}
        side="top"
        align="left"
        modal={false}
        className="w-auto min-w-[200px]"
        aria-label={isSession ? '切换主机' : '选择主机'}
        trigger={({ open }) => (
          <EnvTrigger
            icon={
              migrating ? (
                <Spinner size={12} className="text-muted" />
              ) : (
                <Monitor size={12} className="text-muted" />
              )
            }
            label={migrating ? '迁移中…' : (pendingHost?.name ?? host?.name ?? '主机')}
            open={open}
            disabled={!!locked && !migrating}
            title={
              pendingHost
                ? `切换到 ${pendingHost.name}，选择文件夹后迁移`
                : isSession
                  ? '切换主机（会话将迁移到目标主机）'
                  : '选择主机'
            }
          />
        )}
      >
        <HostMenu
          hostId={hostId}
          pendingHostId={pendingHostId}
          onPick={(id) => {
            if (!isSession) {
              onHostChange?.(id)
              setHostMenuOpen(false)
              return
            }
            setHostMenuOpen(false)
            setPendingHostId(id)
          }}
        />
      </Menu>
      <Popover
        side="top"
        padded={false}
        open={folderOpen}
        onOpenChange={setFolderOpen}
        panelClassName="w-auto rounded-[10px] p-[5px]"
        trigger={({ open, toggle }) => (
          <EnvTrigger
            icon={<FolderOpen size={12} className="text-muted" />}
            label={
              pendingHost ? (
                <span className="text-text">待选</span>
              ) : cwd ? (
                basename(cwd) || cwd
              ) : (
                '文件夹'
              )
            }
            onClick={toggle}
            open={open}
            pressed={!!pendingHost}
            disabled={migrating || (!!locked && !pendingHost)}
            title={
              pendingHost
                ? `选择 ${pendingHost.name} 上的文件夹`
                : cwd
            }
          />
        )}
      >
        {(close) =>
          hostId || pendingHost ? (
            <FolderBrowser
              hostId={pendingHost?.id ?? hostId}
              initial={
                pendingHost ? (loadRecentDirs(pendingHost.id)[0] ?? '') : cwd
              }
              onUse={(path) => {
                if (pendingHost) {
                  close()
                  if (!migrating) void startMigration(pendingHost.id, path)
                  return
                }
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
              useLabel={pendingHost ? '使用并迁移' : '使用此目录'}
            />
          ) : null
        }
      </Popover>
      {pendingHost ? (
        <IconButton
          data-env-pending-cancel="true"
          size="sm"
          onClick={() => {
            setPendingHostId(null)
            setFolderOpen(false)
          }}
          label="取消切换"
          tooltip="取消切换"
          tooltipSide="top"
          className="max-sm:size-11"
        >
          <Undo2 size={13} />
        </IconButton>
      ) : null}

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
            loading={!branch && !!envLoading}
            onClick={toggle}
            open={open}
            disabled={locked || !isSession || !sessionId || !env?.repoRoot}
            title={
              isSession
                ? `切换分支${branch ? `（当前 ${branch}）` : ''}`
                : '创建会话后可切换分支'
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
        <div
          className={cn(
            triggerClass,
            'inline-flex cursor-default',
            !env?.repoRoot && 'max-sm:hidden',
            isWorktree && 'bg-[var(--t-bg-active)] text-text',
          )}
        >
          <GitFork size={12} className={isWorktree ? 'text-text-soft' : 'text-muted'} />
          <span>Worktree</span>
          <Switch
            checked={isWorktree}
            onChange={toggleWorktree}
            disabled={locked || (!isSession && !env?.repoRoot)}
            label="Worktree"
            className="ml-0.5"
          />
        </div>
      </Tooltip>
      {isSession && sessionId && sessionMounts.length > 0 && (
        <div className="flex min-w-0 items-center gap-0.5">
          {sessionMounts.map((mount) => (
            <Button
              key={mount.id}
              size="sm"
              variant="ghost"
              className="max-w-[170px] px-1.5 text-[12px] text-text-secondary"
              icon={mount.kind === 'adb' ? <Smartphone size={12} /> : <Usb size={12} />}
              tooltip={`${mount.deviceId} · ${mount.source.hostName}${mount.kind === 'serial' ? ' · 打开串口终端' : ''}`}
              tooltipSide="top"
              onClick={() => {
                if (mount.kind === 'serial') {
                  if (host) void openTerminal(host, sessionId, mount)
                } else {
                  setWorkstationOpen(true)
                }
              }}
            >
              <span className="truncate">{mount.name}</span>
            </Button>
          ))}
        </div>
      )}
      {migration && (
        <span className="ml-2 shrink-0 truncate text-[12px] text-muted">
          已迁移到 {migration}
        </span>
      )}
    </div>
    </div>
  )
}
