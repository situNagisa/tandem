import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  Eye,
  EyeOff,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitFork,
  ScanLine,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Server,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import type { ContentBlock, FsEntry, PermissionMode, ReasoningEffort } from '@tandem/protocol'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { basename, dirname } from '../lib/format'
import { loadRecentDirs, rememberDir } from '../lib/storage'
import { defaultChoiceFor } from '../lib/profileModels'
import { loadLastEffort } from '../lib/effort'
import { cn } from '../lib/cn'
import { ConnectionDot } from './StatusDot'
import { Popover } from './ui/Popover'
import { MenuItem, MenuList } from './ui/Menu'
import { Button, IconButton } from './ui/Button'
import { Input } from './ui/Controls'
import { Composer } from './Composer'
import { EnvBar } from './EnvBar'
import { useGitRepo } from '../lib/useGitRepo'
import { QrScanDialog, scannerSupported } from './QrScanDialog'
import { parsePairLink, type PairTarget } from '../lib/pairLink'
import { RELAY_UNSUPPORTED_MESSAGE, useRelayCryptoSupport } from '../lib/relay'

const HINTS = [
  {
    icon: Search,
    label: '介绍项目',
    prompt: '介绍一下这个项目的结构和启动方式。',
  },
  {
    icon: Wrench,
    label: '修复测试',
    prompt: '运行测试并修复失败的用例。',
  },
  {
    icon: GitBranch,
    label: '总结改动',
    prompt: '查看最近的 git 改动并总结风险。',
  },
  {
    icon: FileText,
    label: '写文档',
    prompt: '阅读这个仓库并补一份清晰的中文 README。',
  },
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
    <MenuList aria-label="执行 Host" className="w-[220px]">
      {hosts.map((h) => {
        const rt = runtimes[h.id]
        return (
          <MenuItem
            key={h.id}
            icon={<ConnectionDot state={rt?.status ?? 'connecting'} />}
            hint={`${rt?.info?.platform ? `${rt.info.platform} · ` : ''}${h.url.replace(/^https?:\/\//, '')}`}
            selected={h.id === hostId}
            role="menuitemradio"
            ariaChecked={h.id === hostId}
            onSelect={() => {
              onChange(h.id)
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
      <div className="px-2 pb-1.5 pt-1 text-[12px] font-medium uppercase tracking-[0.08em] text-muted">
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
                'max-w-[140px] truncate rounded-md px-1.5 py-0.5 text-[12px] transition-colors',
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
          className="min-w-0 flex-1 font-mono text-[12px]"
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
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted">
            <Loader2 size={12} className="animate-spin" /> 读取目录…
          </div>
        )}
        {!loading && error && (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-[12px] text-danger">
            <TriangleAlert size={14} />
            {error}
          </div>
        )}
        {!loading && !error && entries.length === 0 && (
          <div className="flex h-full items-center justify-center text-[13px] text-muted">
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
        <Button size="sm" variant="ghost" onClick={() => go(home ?? path)} className="text-[12px]">
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
  const [effort, setEffort] = useState<ReasoningEffort>(loadLastEffort)
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
          effort,
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
      <div className="anim-slide-up w-full max-w-[720px]">
        <div className="mb-7 text-center md:mb-9">
          <h1 className="font-serif text-[30px] leading-tight tracking-[-0.015em] text-text md:text-[34px]">
            {greeting}，今天想做点什么？
          </h1>
          <p className="mt-2.5 text-[13px] text-muted">
            {host ? `在 ${host.name} 上开始一次新的协作` : '连接一台 Host 后即可开始'}
          </p>
        </div>

        <div className="mb-1">
          <EnvBar
            variant="new"
            hostId={hostId}
            cwd={cwd}
            env={gitRepo === 'yes' ? { repoRoot: cwd } : undefined}
            worktreeOn={worktree}
            onHostChange={chooseHost}
            onCwdChange={setCwd}
            onWorktreeChange={(on) => {
              setWorktree(on)
              setError(null)
            }}
          />
        </div>

        <Composer
          sessionless
          model={model}
          profileId={profileId}
          groupId={groupId}
          permissionMode={permissionMode}
          effort={effort}
          onModelChange={chooseAccount}
          onPermissionModeChange={setPermissionMode}
          onEffortChange={setEffort}
          hostId={hostId}
          cwd={cwd}
          placeholder="描述一个任务，或粘贴一段代码…"
          autoFocus
          disabled={sending || !hostReady}
          onSubmit={submit}
        />

        {!hostReady && host && (
          <p className="mt-2 text-center text-[12px] text-warning">
            {runtime?.status === 'connecting' ? '正在连接 Host…' : 'Host 当前离线，连上后即可发送。'}
          </p>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft/60 px-3 py-2 text-[12px] text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        )}

        {!profiles.length && profilesLoading && (
          <p className="mt-4 text-center text-[13px] text-muted">正在加载账号…</p>
        )}

        {!profiles.length && !profilesLoading && hostReady && (
          <p className="mt-4 text-center text-[13px] text-muted">
            还没有账号，请先在设置中添加账号，再选择模型。
          </p>
        )}

        <div className="no-scrollbar mt-3 flex items-center gap-1.5 overflow-x-auto pb-0.5 max-md:-mx-4 max-md:px-4 md:justify-center">
          {HINTS.map(({ icon: Icon, label, prompt }) => (
            <button
              key={label}
              type="button"
              onClick={() => seedPrompt(prompt)}
              className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--t-bg-subtle)] px-2.5 text-[13px] font-normal text-text-soft transition-colors duration-[120ms] hover:bg-[color-mix(in_srgb,var(--t-text)_10%,var(--t-bg-subtle))] hover:text-text max-md:h-11"
            >
              <Icon size={12} className="shrink-0 text-muted" />
              <span className="whitespace-nowrap">{label}</span>
            </button>
          ))}
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
          <h1 className="mt-5 text-[27px] font-medium leading-tight tracking-[-0.01em] md:text-[30px]">
            连接你的 Host
          </h1>
          <p className="mx-auto mt-2 max-w-[340px] text-[13px] leading-6 text-muted">
            Host 是实际执行任务的机器。在目标机器启动 Tandem Host，把带 token 的链接粘贴到这里。
          </p>
        </div>

        <div className="mt-7 rounded-2xl border border-border bg-surface p-4 shadow-[var(--t-shadow-md)]">
          <label className="mb-1.5 block text-[12px] font-medium text-text-soft">
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
            <div className="mt-2 rounded-lg bg-[var(--t-bg)] px-2.5 py-1.5 text-[12px] leading-4 text-muted">
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
            <div className="mt-2 rounded-lg border border-warning/30 bg-warning-soft/40 px-2.5 py-2 text-[12px] leading-5 text-warning">
              {RELAY_UNSUPPORTED_MESSAGE}
            </div>
          )}

          <div className="my-4 flex items-center gap-2 text-[12px] text-muted">
            <span className="h-px flex-1 bg-[var(--t-border)]" />
            或手动填写
            <span className="h-px flex-1 bg-[var(--t-border)]" />
          </div>

          <label className="mb-1.5 block text-[12px] font-medium text-text-soft">地址</label>
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
          <label className="mb-1.5 mt-3 block text-[12px] font-medium text-text-soft">Token</label>
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
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/60 px-2.5 py-2 text-[13px] leading-5 text-danger">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
            </div>
          )}
          {ok && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-success/25 bg-success-soft/60 px-2.5 py-2 text-[13px] text-success">
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
            <p className="mt-2 rounded-lg border border-border bg-bg/50 px-2.5 py-2 text-[12px] leading-5 text-muted">
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

        <p className="mt-4 text-center text-[12px] leading-5 text-muted">
          Token 只保存在本机浏览器中。手机与电脑连接同一 Host 时，会话实时同步。
        </p>
      </div>
      {scanOpen && <QrScanDialog onClose={() => setScanOpen(false)} onResult={onScanned} />}
    </div>
  )
}
