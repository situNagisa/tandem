import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
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
  Plus,
  Settings,
  Smartphone,
  TriangleAlert,
  Undo2,
  Usb,
} from 'lucide-react'
import { isDesktopLocalHost } from '../lib/desktopFolder'
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
import { Switch } from './ui/Controls'
import { Menu, MenuItem, MenuList } from './ui/Menu'
import { Modal } from './ui/Modal'

import { Tooltip } from './ui/Tooltip'

const EMPTY_DEVICE_MOUNTS: DeviceMount[] = []

/** 环境条三个胶囊的下拉统一宽度规则：内容自适应 + 同一最小宽度。 */
const ENV_MENU_CLASS = 'w-auto min-w-[200px]'

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
        return (
          <Menu.Item
            key={h.id}
            icon={<ConnectionDot state={rt?.status ?? 'connecting'} />}
            selected={h.id === hostId}
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

/**
 * 文件夹弹层主体：只列最近用过的目录；底部「打开文件夹…」由 Menu 的底部动作区渲染。
 * 目录浏览器不再常驻，按需在系统对话框（本机）或应用内对话框（其他主机）里打开。
 * 分组标题与行都走 ui/Menu 原语，和其他下拉的边距/行高保持一致（反馈1601#01 / R01）。
 */
function FolderPicker({
  hostId,
  cwd,
  onUse,
}: {
  hostId: string
  cwd?: string
  onUse: (path: string) => void
}) {
  const recent = useMemo(() => loadRecentDirs(hostId), [hostId])
  return (
    <div data-folder-picker="" className="min-w-0">
      {recent.length > 0 && <Menu.Label>最近</Menu.Label>}
      {recent.map((dir) => (
        <Menu.Item
          key={dir}
          icon={<Folder size={13} />}
          title={dir}
          selected={!!cwd && dir === cwd}
          onSelect={() => onUse(dir)}
        >
          {basename(dir) || dir}
        </Menu.Item>
      ))}
    </div>
  )
}

/**
 * 系统文件夹对话框只在桌面版、且所选主机就是这台电脑时可用。
 * 判定：所选主机的 HostInfo.id（Host 配置里的 hostId）等于桌面内嵌 Host 的 hostId
 * （主进程 `host:local-id` 返回）。网页 / 手机 / 远程主机 / WSL 里的 Host 与 Windows
 * 客户端不是同一文件系统；任一信息缺失都按非本机处理，回退到应用内目录浏览器。
 */
async function canPickFolderNatively(hostId: string): Promise<boolean> {
  const desktop = window.tandemDesktop
  if (typeof desktop?.host?.localId !== 'function') return false
  const selectedHostId = useAppStore.getState().runtimes[hostId]?.info?.id
  let localHostId: string | null = null
  try {
    localHostId = await desktop.host.localId()
  } catch {
    return false
  }
  return isDesktopLocalHost({
    isDesktop: desktop.isDesktop === true,
    selectedHostId,
    localHostId,
  })
}

/**
 * 分支下拉：与主机、文件夹共用 ui/Menu（同样的行样式、宽度规则与底部动作区）。
 * 顶部搜索框是 Menu 的通用能力：筛选已有分支，输入新名字则底部动作变成「新建分支 “…”」。
 */
function BranchMenu({
  hostId,
  sessionId,
  current,
  onSwitch,
  trigger,
  className,
}: {
  hostId: string
  sessionId: string | null
  current?: string
  onSwitch: () => void
  trigger: (state: { open: boolean }) => ReactElement
  className?: string
}) {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const toast = useUiStore((s) => s.toast)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // 每次打开重新拉分支；收起时清掉筛选词与忙碌状态，下次打开是新的会话。
  useEffect(() => {
    if (!open) {
      setQuery('')
      setBusy(false)
      return
    }
    if (!host || !sessionId) {
      setBranches([])
      setLoading(false)
      return
    }
    let cancelled = false
    setBranches([])
    setLoading(true)
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
  }, [open, host, sessionId, toast])

  const run = async (branch: string, create: boolean) => {
    if (!host || !sessionId || busy) return
    setBusy(true)
    try {
      await api.checkout(host, sessionId, branch, create)
      void useAppStore.getState().refreshSessions(hostId)
      toast(`已切换到分支 ${branch}`, 'success')
      onSwitch()
      setOpen(false)
    } catch (err) {
      toast(err instanceof Error ? err.message : '切换分支失败', 'error')
      setBusy(false)
    }
  }

  const typed = query.trim()
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return branches
    return branches.filter((branch) => branch.toLowerCase().includes(q))
  }, [branches, query])
  const exact = branches.find((branch) => branch === typed)
  const canCreate = !!typed && !exact

  /** ↑↓/Enter 落在列表行上：搜索框只负责筛选与建分支。 */
  const focusFirstRow = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const content = event.currentTarget.closest('[data-radix-menu-content]')
    content
      ?.querySelector<HTMLElement>('[data-menu-body] [role="menuitem"]:not([aria-disabled="true"])')
      ?.focus()
  }

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="left"
      modal={false}
      className={cn(ENV_MENU_CLASS, className)}
      bodyClassName="max-h-[260px]"
      aria-label="切换分支"
      header={
        <Menu.Search
          ref={searchRef}
          value={query}
          onChange={setQuery}
          label="筛选或新建分支"
          placeholder="筛选分支，或输入新分支名"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (canCreate) void run(typed, true)
              else if (exact) void run(exact, false)
              else focusFirstRow(event)
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              focusFirstRow(event)
            }
          }}
        />
      }
      footer={
        <Menu.Item
          icon={<Plus size={13} />}
          keepOpen={!canCreate}
          onSelect={() => {
            if (!canCreate) {
              // Radix 选中后会把焦点留在行上，下一帧再落回搜索框。
              window.requestAnimationFrame(() => searchRef.current?.focus())
              return
            }
            void run(typed, true)
          }}
        >
          {canCreate ? `新建分支 “${typed}”` : '新建分支…'}
        </Menu.Item>
      }
      trigger={trigger}
    >
      {loading && (
        // 用共享菜单行占位：与分支行同高，读回后面板尺寸不变（R52）。
        <Menu.Item icon={<Spinner size={12} />} disabled>
          读取分支…
        </Menu.Item>
      )}
      {!loading && branches.length === 0 && <Menu.Item disabled>当前目录不是 git 仓库</Menu.Item>}
      {!loading && branches.length > 0 && filtered.length === 0 && (
        <Menu.Item disabled>没有匹配的分支</Menu.Item>
      )}
      {filtered.map((branch) => (
        <Menu.Item
          key={branch}
          icon={<GitBranch size={13} />}
          selected={branch === current}
          title={branch}
          onSelect={() => void run(branch, false)}
        >
          <span className="font-mono text-[12.5px]">{branch}</span>
        </Menu.Item>
      ))}
    </Menu>
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
  /** 应用内目录浏览对话框：本机之外的 Host（网页、手机、远程、WSL）没有系统对话框。 */
  const [folderBrowserFor, setFolderBrowserFor] = useState<'current' | 'pending' | null>(null)
  const pendingHost = pendingHostId ? (hosts.find((h) => h.id === pendingHostId) ?? null) : null

  // 换会话/换主机时清掉待定状态，避免提示残留在别的会话上。
  useEffect(() => {
    setPendingHostId(null)
    setHostMenuOpen(false)
    setFolderOpen(false)
    setFolderBrowserFor(null)
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
  // 反馈1323#07 #08：目录探测完成且不是 git 仓库时，分支与 Worktree 都不渲染。
  // Host 只给 git 仓库的会话下发 env，缺少 env 即非仓库；新会话页探测期间 envLoading 为 true。
  const knownNonGit = !envLoading && !env?.repoRoot

  const applyFolder = (path: string, target: 'current' | 'pending') => {
    if (target === 'pending') {
      if (pendingHost && !migrating) void startMigration(pendingHost.id, path)
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
  }

  /** 本机用系统文件夹对话框；其他主机打开应用内目录浏览对话框。 */
  const openFolderPicker = async () => {
    const target: 'current' | 'pending' = pendingHost ? 'pending' : 'current'
    const targetHostId = pendingHost?.id ?? hostId
    const initial = target === 'pending' ? (loadRecentDirs(targetHostId)[0] ?? '') : cwd
    setFolderOpen(false)
    if (!targetHostId) return
    let native = false
    try {
      native = await canPickFolderNatively(targetHostId)
    } catch {
      native = false
    }
    if (!native) {
      // 等弹层收起、焦点落回环境条后再开对话框，避免刚打开就被判为焦点移出。
      window.setTimeout(() => setFolderBrowserFor(target), 80)
      return
    }
    try {
      const picked = await window.tandemDesktop?.folder?.pick(initial || undefined)
      if (picked) applyFolder(cleanDir(picked), target)
    } catch (err) {
      toast(err instanceof Error ? err.message : '打开文件夹失败', 'error')
    }
  }

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
        className={ENV_MENU_CLASS}
        aria-label={isSession ? '切换主机' : '选择主机'}
        footer={
          <>
            <Menu.Item
              icon={<Settings size={13} />}
              onSelect={() => useUiStore.getState().openSettings('hosts')}
            >
              管理主机…
            </Menu.Item>
            <Menu.Item
              icon={<Plus size={13} />}
              onSelect={() => useUiStore.getState().setAddHostOpen(true)}
            >
              添加主机…
            </Menu.Item>
          </>
        }
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
      <Menu
        side="top"
        align="left"
        modal={false}
        open={folderOpen}
        onOpenChange={setFolderOpen}
        className={ENV_MENU_CLASS}
        aria-label="选择工作目录"
        footer={
          <Menu.Item icon={<FolderOpen size={13} />} onSelect={() => void openFolderPicker()}>
            打开文件夹…
          </Menu.Item>
        }
        trigger={({ open }) => (
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
        {hostId || pendingHost ? (
          <FolderPicker
            hostId={pendingHost?.id ?? hostId}
            cwd={pendingHost ? undefined : cwd}
            onUse={(path) => applyFolder(path, pendingHost ? 'pending' : 'current')}
          />
        ) : null}
      </Menu>
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

      {!knownNonGit && (
        <BranchMenu
          hostId={hostId}
          sessionId={sessionId}
          current={env?.branch}
          onSwitch={() => void useAppStore.getState().refreshSessions(hostId)}
          className={cn(!isSession && !env?.repoRoot && 'max-sm:hidden')}
          trigger={({ open }) => (
            <EnvTrigger
              icon={
                isWorktree ? (
                  <GitFork size={12} className="text-muted" />
                ) : (
                  <GitBranch size={12} className="text-muted" />
                )
              }
              label={branch ?? '分支'}
              loading={!branch && !!envLoading}
              open={open}
              disabled={locked || !isSession || !sessionId || !env?.repoRoot}
              title={
                isSession
                  ? `切换分支${branch ? `（当前 ${branch}）` : ''}`
                  : '创建会话后可切换分支'
              }
            />
          )}
        />
      )}

      {!knownNonGit && (
      <Tooltip label={worktreeTip} side="top" className="shrink-0">
        <div
          className={cn(
            triggerClass,
            'inline-flex cursor-default',
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
      )}

      <Modal
        open={folderBrowserFor !== null}
        onClose={() => setFolderBrowserFor(null)}
        title="打开文件夹"
        description={`在 ${folderBrowserFor === 'pending' ? (pendingHost?.name ?? '目标主机') : (host?.name ?? '主机')} 上选择目录`}
        align="top"
        className="w-[min(420px,calc(100vw-1.5rem))] max-w-none"
        bodyClassName="p-3"
      >
        {folderBrowserFor !== null && (pendingHost?.id || hostId) && (
          <FolderBrowser
            hostId={folderBrowserFor === 'pending' ? (pendingHost?.id ?? hostId) : hostId}
            initial={
              folderBrowserFor === 'pending'
                ? (loadRecentDirs(pendingHost?.id ?? hostId)[0] ?? '')
                : cwd
            }
            onUse={(path) => {
              const target = folderBrowserFor ?? 'current'
              setFolderBrowserFor(null)
              applyFolder(path, target)
            }}
            useLabel={folderBrowserFor === 'pending' ? '使用并迁移' : '使用此目录'}
          />
        )}
      </Modal>
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
