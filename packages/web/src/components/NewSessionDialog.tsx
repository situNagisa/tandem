import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  GitFork,
  ScanLine,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  TriangleAlert,
} from 'lucide-react'
import type { ContentBlock, FsEntry, PermissionMode } from '@tandem/protocol'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { basename, dirname } from '../lib/format'
import { loadRecentDirs, rememberDir } from '../lib/storage'
import { defaultChoiceFor } from '../lib/profileModels'
import { cn } from '../lib/cn'
import { ConnectionDot } from './StatusDot'
import { Popover } from './ui/Popover'
import { Button, IconButton } from './ui/Button'
import { Input } from './ui/Controls'
import { Composer } from './Composer'
import { useGitRepo } from '../lib/useGitRepo'
import { QrScanDialog, scannerSupported } from './QrScanDialog'
import { parsePairLink, type PairTarget } from '../lib/pairLink'
import { RELAY_UNSUPPORTED_MESSAGE, useRelayCryptoSupport } from '../lib/relay'

const HINTS = [
  '介绍一下这个项目的结构和启动方式',
  '运行测试并修复失败的用例',
  '查看最近的 git 改动并总结风险',
]

function Picker({
  trigger,
  children,
  align = 'left',
  panelClass,
}: {
  trigger: (state: { open: boolean; toggle: () => void; close: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  panelClass?: string
}) {
  return (
    <Popover
      trigger={trigger}
      align={align}
      side="bottom"
      padded={false}
      panelClassName={cn('p-1.5', panelClass)}
    >
      {children}
    </Popover>
  )
}

function Pill({
  children,
  onClick,
  className,
  title,
  disabled,
  pressed,
}: {
  children: ReactNode
  onClick: () => void
  className?: string
  title?: string
  disabled?: boolean
  pressed?: boolean
}) {
  return (
    <Button
      variant="secondary"
      onClick={onClick}
      tooltip={title}
      disabled={disabled}
      aria-pressed={pressed}
      className={cn(
        'min-h-11 min-w-0 max-w-full shrink-0 rounded-full px-2.5 font-normal md:min-h-[32px]',
        className,
      )}
    >
      {children}
    </Button>
  )
}

function HostMenu({
  hostId,
  onChange,
  close,
}: {
  hostId: string
  onChange: (id: string) => void
  close: () => void
}) {
  const hosts = useAppStore((s) => s.hosts)
  const runtimes = useAppStore((s) => s.runtimes)
  return (
    <div className="w-[252px]">
      <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
        执行 Host
      </div>
      {hosts.map((h) => {
        const rt = runtimes[h.id]
        return (
          <button
            key={h.id}
            onClick={() => {
              onChange(h.id)
              close()
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
          >
            <ConnectionDot state={rt?.status ?? 'connecting'} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px]">{h.name}</span>
              <span className="block truncate font-mono text-[10px] text-muted">
                {h.url.replace(/^https?:\/\//, '')}
              </span>
            </span>
            {h.id === hostId && <Check size={13} className="shrink-0 text-text" />}
          </button>
        )
      })}
    </div>
  )
}

function FolderMenu({
  hostId,
  cwd,
  onSelect,
  close,
}: {
  hostId: string
  cwd: string
  onSelect: (path: string) => void
  close: () => void
}) {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const home = useAppStore((s) => (hostId ? s.runtimes[hostId]?.info?.homeDir : undefined))
  const recents = useMemo(() => loadRecentDirs(hostId), [hostId])
  const [path, setPath] = useState(cwd || home || '')
  const [draft, setDraft] = useState(cwd || home || '')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

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
          list
            .filter((e) => e.isDir)
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
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
      <div className="px-2 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
        工作目录
      </div>
      {recents.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1 pb-1.5">
          {recents.slice(0, 4).map((d) => (
            <button
              key={d}
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
          onClick={() => {
            onSelect(path)
            close()
          }}
          disabled={!path}
        >
          <Check size={11} /> 使用此目录
        </Button>
      </div>
    </div>
  )
}

export function NewSessionView() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const activateHost = useAppStore((s) => s.activateHost)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const startSession = useAppStore((s) => s.startSession)
  const seedPrompt = useUiStore((s) => s.seedPrompt)

  const [hostId, setHostId] = useState(activeHostId ?? hosts[0]?.id ?? '')
  const host = hosts.find((h) => h.id === hostId) ?? null
  const runtime = hostId ? runtimes[hostId] : undefined
  const profiles = runtime?.profiles ?? []
  const profilesLoading = runtime?.profilesLoading ?? false
  const hostReady = runtime?.status === 'online'

  const [cwd, setCwd] = useState('')
  const [profileId, setProfileId] = useState('')
  const [groupId, setGroupId] = useState<string | undefined>(undefined)
  const [model, setModel] = useState('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [worktree, setWorktree] = useState(false)
  const [worktreeBranch, setWorktreeBranch] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hour = new Date().getHours()
  const greeting = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  useEffect(() => {
    if (!hostId && hosts[0]) setHostId(hosts[0].id)
    else if (hostId && !hosts.some((h) => h.id === hostId)) setHostId(hosts[0]?.id ?? '')
  }, [hostId, hosts])

  useEffect(() => {
    if (activeHostId && activeHostId !== hostId && hosts.some((h) => h.id === activeHostId)) {
      setHostId(activeHostId)
    }
  }, [activeHostId, hostId, hosts])

  // Host 的 homeDir 通过 WS 稍后到达：hostId 首次渲染时 info 可能还没有，
  // 因此把 homeDir 也列入依赖，等它到达后再补上默认工作目录。
  const cwdHostRef = useRef('')
  const homeDir = runtime?.info?.homeDir
  useEffect(() => {
    if (!hostId) return
    const rt = useAppStore.getState().runtimes[hostId]
    const hostChanged = cwdHostRef.current !== hostId
    cwdHostRef.current = hostId
    const recent = loadRecentDirs(hostId)
    const fallback = recent[0] ?? rt?.info?.homeDir ?? ''
    setCwd((prev) => (hostChanged || !prev ? fallback : prev))
    void refreshProfiles(hostId)
  }, [hostId, homeDir, refreshProfiles])

  useEffect(() => {
    const onSeed = (e: Event) => {
      const detail = (e as CustomEvent<{ hostId?: string; cwd?: string }>).detail
      if (!detail) return
      if (detail.hostId) setHostId(detail.hostId)
      if (detail.cwd) setCwd(detail.cwd)
      setError(null)
    }
    window.addEventListener('tandem:new-session', onSeed)
    return () => window.removeEventListener('tandem:new-session', onSeed)
  }, [])

  useEffect(() => {
    if (!profiles.length) {
      setProfileId('')
      setGroupId(undefined)
      setModel('')
      return
    }
    const current = profiles.find((p) => p.id === profileId)
    if (!current) {
      const p = profiles[0]
      const choice = defaultChoiceFor(p)
      setProfileId(p.id)
      setGroupId(choice?.groupId)
      setModel(choice?.model ?? '')
      return
    }
    if (current.groups?.length) {
      if (!groupId || !current.groups.some((g) => g.id === groupId)) {
        const g = current.groups[0]
        setGroupId(g.id)
        setModel(g.defaultModel || g.models[0] || '')
      }
    } else if (groupId) {
      setGroupId(undefined)
    }
  }, [profiles, profileId, groupId])

  const gitRepo = useGitRepo(host, cwd)

  useEffect(() => {
    if (gitRepo === 'no') setWorktree(false)
  }, [gitRepo])

  const sendingRef = useRef(false)
  const submit = async (content: ContentBlock[]): Promise<boolean> => {
    if (sendingRef.current) return false
    if (!host) return false
    if (!hostReady) {
      setError('Host 未连接，暂时无法发送')
      return false
    }
    if (!cwd.trim()) {
      setError('先选择一个工作目录')
      return false
    }
    if (!profileId || !model) {
      setError('先选择账号与模型')
      return false
    }
    if (!content.length) return false
    sendingRef.current = true
    setSending(true)
    setError(null)
    try {
      await startSession(
        host.id,
        {
          cwd: cwd.trim(),
          profileId,
          ...(groupId ? { groupId } : {}),
          model,
          permissionMode,
          ...(worktree && gitRepo === 'yes'
            ? { worktree: { ...(worktreeBranch.trim() ? { branch: worktreeBranch.trim() } : {}) } }
            : {}),
        },
        content,
      )
      rememberDir(host.id, cwd.trim())
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建会话失败')
      sendingRef.current = false
      setSending(false)
      return false
    }
  }

  const chooseHost = (id: string) => {
    setHostId(id)
    activateHost(id)
    setError(null)
  }

  const chooseAccount = (pid: string, gid: string | undefined, m: string) => {
    setProfileId(pid)
    setGroupId(gid)
    setModel(m)
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-10 md:py-14">
      <div className="anim-slide-up w-full max-w-[680px]">
        <div className="mb-7 text-center md:mb-9">
          <h1 className="font-serif text-[30px] leading-tight tracking-[-0.015em] text-text md:text-[34px]">
            {greeting}，今天想做点什么？
          </h1>
          <p className="mt-2.5 text-[12.5px] text-muted">
            {host ? `在 ${host.name} 上开始一次新的协作` : '连接一台 Host 后即可开始'}
          </p>
        </div>

        <Composer
          sessionless
          model={model}
          profileId={profileId}
          groupId={groupId}
          permissionMode={permissionMode}
          onModelChange={chooseAccount}
          onPermissionModeChange={setPermissionMode}
          hostId={hostId}
          cwd={cwd}
          placeholder="描述一个任务，或粘贴一段代码…"
          autoFocus
          disabled={sending || !hostReady}
          onSubmit={submit}
        />

        {!hostReady && host && (
          <p className="mt-2 text-center text-[11px] text-warning">
            {runtime?.status === 'connecting' ? '正在连接 Host…' : 'Host 当前离线，连上后即可发送。'}
          </p>
        )}

        <div className="no-scrollbar mt-3 flex items-center gap-1.5 overflow-x-auto pb-0.5 max-md:-mx-4 max-md:px-4 md:flex-wrap md:justify-center">
          <Picker
            panelClass="w-auto"
            trigger={({ open, toggle }) => (
              <Pill onClick={toggle} title="选择 Host" className={open ? 'bg-[var(--t-bg-active)]' : undefined}>
                <ConnectionDot state={runtime?.status ?? 'connecting'} className="size-1.5" />
                <Server size={12} className="text-muted" />
                <span className="max-w-[120px] truncate">{host?.name ?? '选择 Host'}</span>
                <ChevronDown size={11} className="text-muted" />
              </Pill>
            )}
          >
            {(close) => <HostMenu hostId={hostId} onChange={chooseHost} close={close} />}
          </Picker>

          <Picker
            panelClass="w-auto"
            trigger={({ open, toggle }) => (
              <Pill onClick={toggle} title={cwd || '选择工作目录'} className={open ? 'bg-[var(--t-bg-active)]' : undefined}>
                <FolderOpen size={12} className="text-muted" />
                <span className="max-w-[160px] truncate">{cwd ? basename(cwd) || cwd : '工作目录'}</span>
                <ChevronDown size={11} className="text-muted" />
              </Pill>
            )}
          >
            {(close) =>
              host ? (
                <FolderMenu hostId={host.id} cwd={cwd} onSelect={setCwd} close={close} />
              ) : null
            }
          </Picker>

          <Pill
            onClick={() => {
              if (gitRepo !== 'yes') return
              setWorktree((v) => !v)
              setError(null)
            }}
            pressed={worktree}
            disabled={gitRepo !== 'yes'}
            title={
              gitRepo === 'checking'
                ? '正在检测 git 仓库…'
                : gitRepo === 'no'
                  ? '当前目录不在 git 仓库中，无法创建 worktree'
                  : '在隔离的 git worktree 中运行，改动不影响当前分支'
            }
            className={worktree ? 'bg-[var(--t-bg-active)] text-text' : undefined}
          >
            <GitFork size={12} className="text-muted" />
            {gitRepo === 'no' ? '隔离分支（需 Git 仓库）' : '隔离分支（worktree）'}
          </Pill>

          {worktree && gitRepo === 'yes' && (
            <label className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface/60 px-2.5 md:h-8">
              <GitFork size={11} className="shrink-0 text-muted" />
              <input
                value={worktreeBranch}
                onChange={(e) => setWorktreeBranch(e.target.value)}
                placeholder="分支名（自动 tandem/…）"
                spellCheck={false}
                className="w-[128px] bg-transparent font-mono text-[10.5px] text-text outline-none placeholder:text-muted"
              />
            </label>
          )}

        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft/60 px-3 py-2 text-[12px] text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        )}

        {!profiles.length && profilesLoading && (
          <p className="mt-4 text-center text-[11.5px] text-muted">正在加载账号…</p>
        )}

        {!profiles.length && !profilesLoading && hostReady && (
          <p className="mt-4 text-center text-[11.5px] text-muted">
            还没有账号，请先在设置中添加账号，再选择模型。
          </p>
        )}

        <div className="mt-8">
          <div className="mb-2 text-center text-[10px] font-medium uppercase tracking-[0.1em] text-muted">
            试试
          </div>
          <div className="flex flex-col items-center gap-1">
            {HINTS.map((hint) => (
              <Button
                key={hint}
                size="sm"
                variant="secondary"
                onClick={() => seedPrompt(hint)}
                className="max-w-full truncate rounded-full px-2.5 font-normal text-muted hover:text-text-soft"
              >
                {hint}
              </Button>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}

export function ConnectView() {
  const addHost = useAppStore((s) => s.addHost)
  const toast = useUiStore((s) => s.toast)
  const [link, setLink] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [parsed, setParsed] = useState<PairTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const canScan = useMemo(scannerSupported, [])
  const cryptoSupported = useRelayCryptoSupport()
  const coarsePointer = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
    [],
  )

  const parseLink = () => {
    setError(null)
    const raw = link.trim()
    if (!raw) {
      setError('先粘贴带 token 的 Host 链接')
      return
    }
    try {
      const target = parsePairLink(raw)
      if (!target) {
        setError('链接格式不正确，示例：http://192.168.1.10:7878/?token=xxxx')
        return
      }
      applyTarget(target)
      if (target.kind === 'direct' && !target.token) {
        setError('链接里没有 token，请手动填写 Token')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '链接格式不正确')
    }
  }

  const applyTarget = (target: PairTarget) => {
    setUrl(target.url)
    setToken(target.token)
    setParsed(target)
  }

  const connectTarget = async (target: PairTarget) => {
    setError(null)
    setOk(false)
    if (!target.url) {
      setError('请填写 Host 地址')
      return
    }
    if (!target.token) {
      setError('请填写 Host Token')
      return
    }
    if (target.kind === 'relay' && cryptoSupported === false) {
      setError(RELAY_UNSUPPORTED_MESSAGE)
      return
    }
    setBusy(true)
    try {
      const probe = {
        id: 'probe',
        name: 'probe',
        url: target.url,
        token: target.token,
        addedAt: Date.now(),
        ...(target.kind === 'relay'
          ? {
              mode: 'relay' as const,
              relayUrl: target.relayUrl,
              hostId: target.hostId,
              fingerprint: target.fingerprint,
            }
          : {}),
      }
      const info = await api.host(probe)
      const fallbackName =
        target.kind === 'relay'
          ? `${new URL(target.relayUrl).host} · ${target.hostId.slice(0, 8)}`
          : new URL(target.url.startsWith('http') ? target.url : 'http://' + target.url).host
      const host = addHost({
        name: info.name || fallbackName,
        url: target.url,
        token: target.token,
        ...(target.kind === 'relay'
          ? {
              mode: 'relay' as const,
              relayUrl: target.relayUrl,
              hostId: target.hostId,
              fingerprint: target.fingerprint,
            }
          : {}),
      })
      setOk(true)
      toast(`已连接 ${host.name}`, 'success')
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接失败，请检查地址与 Token')
    } finally {
      setBusy(false)
    }
  }

  const connect = () => {
    if (parsed?.kind === 'relay') {
      void connectTarget(parsed)
      return
    }
    void connectTarget({ kind: 'direct', url: url.trim(), token: token.trim() })
  }

  const onScanned = (raw: string) => {
    setScanOpen(false)
    try {
      const target = parsePairLink(raw)
      if (!target) throw new Error('二维码内容不是有效的 Tandem 配对链接')
      setLink(raw.trim())
      applyTarget(target)
      void connectTarget(target)
    } catch (err) {
      setError(err instanceof Error ? err.message : '二维码内容不是有效的 Tandem 配对链接')
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="anim-slide-up w-full max-w-[440px]">
        <div className="text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-surface shadow-[var(--t-shadow-sm)] ring-1 ring-border">
            <Server size={22} className="text-text-soft" />
          </div>
          <h1 className="mt-5 font-serif text-[27px] leading-tight tracking-[-0.01em] md:text-[30px]">
            连接你的 Host
          </h1>
          <p className="mx-auto mt-2 max-w-[340px] text-[12.5px] leading-6 text-muted">
            Host 是实际执行任务的机器。在目标机器启动 Tandem Host，把带 token 的链接粘贴到这里。
          </p>
        </div>

        <div className="mt-7 rounded-2xl border border-border bg-surface p-4 shadow-[var(--t-shadow-md)]">
          <label className="mb-1.5 block text-[11px] font-medium text-text-soft">
            配对链接
          </label>
          <div className="flex gap-1.5">
            <Input
              size="lg"
              value={link}
              onChange={(e) => {
                setLink(e.target.value)
                setParsed(null)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  parseLink()
                }
              }}
              placeholder="直连链接，或含 #pair=… 的中继配对链接"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 font-mono text-[12px]"
            />
            <Button size="lg" onClick={parseLink} className="shrink-0">
              解析
            </Button>
          </div>
          {parsed && (
            <div className="mt-2 rounded-lg bg-[var(--t-bg)] px-2.5 py-1.5 text-[10.5px] leading-4 text-muted">
              <div className="truncate font-mono">{parsed.url}</div>
              {parsed.kind === 'relay' ? (
                <>
                  <div className="truncate font-mono">中继 · 端到端加密</div>
                  <div className="truncate font-mono">
                    指纹 {parsed.fingerprint.slice(0, 16)}…
                  </div>
                </>
              ) : (
                <div className="truncate font-mono">
                  Token {parsed.token ? `· ${parsed.token.slice(0, 10)}…` : '· 未找到'}
                </div>
              )}
            </div>
          )}
          {parsed?.kind === 'relay' && cryptoSupported === false && (
            <div className="mt-2 rounded-lg border border-warning/30 bg-warning-soft/40 px-2.5 py-2 text-[10.5px] leading-5 text-warning">
              {RELAY_UNSUPPORTED_MESSAGE}
            </div>
          )}

          <div className="my-4 flex items-center gap-2 text-[10px] text-muted">
            <span className="h-px flex-1 bg-[var(--t-border)]" />
            或手动填写
            <span className="h-px flex-1 bg-[var(--t-border)]" />
          </div>

          <label className="mb-1.5 block text-[11px] font-medium text-text-soft">地址</label>
          <Input
            size="lg"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setError(null)
            }}
            placeholder="http://192.168.1.10:7878"
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-[12px]"
          />
          <label className="mb-1.5 mt-3 block text-[11px] font-medium text-text-soft">Token</label>
          <div className="relative">
            <Input
              size="lg"
              value={token}
              onChange={(e) => {
                setToken(e.target.value)
                setParsed(null)
                setError(null)
              }}
              type={showToken ? 'text' : 'password'}
              placeholder="Host 启动时输出的访问 Token"
              spellCheck={false}
              autoComplete="off"
              className="pr-9 font-mono text-[12px]"
            />
            <IconButton
              size="sm"
              onClick={() => setShowToken((v) => !v)}
              label={showToken ? '隐藏 Token' : '显示 Token'}
              className="absolute right-1 top-1/2 size-7 -translate-y-1/2 [&_svg]:size-[13px]"
            >
              {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
            </IconButton>
          </div>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/60 px-2.5 py-2 text-[11.5px] leading-5 text-danger">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
            </div>
          )}
          {ok && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-success/25 bg-success-soft/60 px-2.5 py-2 text-[11.5px] text-success">
              <Check size={13} /> 连接成功
            </div>
          )}

          {canScan && (
            <Button
              size="lg"
              onClick={() => setScanOpen(true)}
              disabled={busy}
              className="mt-2 w-full"
            >
              <ScanLine size={14} /> 扫码连接
            </Button>
          )}
          {!canScan && coarsePointer && (
            <p className="mt-2 rounded-lg border border-border bg-bg/50 px-2.5 py-2 text-[10.5px] leading-5 text-muted">
              当前浏览器不支持应用内扫码（如 iOS Safari）；可先用系统相机扫描电脑上的配对二维码，再打开链接。
            </p>
          )}

          <Button
            size="lg"
            variant="primary"
            onClick={connect}
            disabled={busy}
            className="mt-4 w-full"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            测试并连接
          </Button>
        </div>

        <p className="mt-4 text-center text-[10.5px] leading-5 text-muted">
          Token 只保存在本机浏览器中。手机与电脑连接同一 Host 时，会话实时同步。
        </p>
      </div>
      {scanOpen && <QrScanDialog onClose={() => setScanOpen(false)} onResult={onScanned} />}
    </div>
  )
}
