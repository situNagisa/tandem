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
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import type { FsEntry, Profile } from '@tandem/protocol'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useClickOutside } from '../lib/hooks'
import { basename, dirname } from '../lib/format'
import { loadRecentDirs, rememberDir } from '../lib/storage'
import { cn } from '../lib/cn'
import { ConnectionDot } from './StatusDot'

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
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, () => setOpen(false), open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v), close: () => setOpen(false) })}
      {open && (
        <div
          className={cn(
            'anim-pop absolute top-full z-50 mt-2 overflow-hidden rounded-xl border border-border bg-surface p-1.5 shadow-[var(--t-shadow-md)]',
            align === 'left' ? 'left-0' : 'right-0',
            panelClass,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function Pill({
  children,
  onClick,
  className,
  title,
}: {
  children: ReactNode
  onClick: () => void
  className?: string
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-10 min-w-0 items-center gap-1.5 rounded-full border border-border bg-transparent px-2.5 text-[11.5px] text-text-soft transition-colors duration-100 hover:bg-[var(--t-bg-hover)] hover:text-text md:h-8',
        className,
      )}
    >
      {children}
    </button>
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
            {h.id === hostId && <Check size={13} className="shrink-0 text-accent" />}
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
        <button
          onClick={() => parent && go(parent)}
          disabled={!parent}
          aria-label="上一级"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:opacity-30"
        >
          <ArrowUp size={13} />
        </button>
        <input
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
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-1.5 font-mono text-[10.5px] outline-none focus:border-border-strong"
        />
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          aria-label="刷新目录"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
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
        <button
          onClick={() => go(home ?? path)}
          className="rounded-md px-1.5 py-1 text-[10.5px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
        >
          主目录
        </button>
        <span className="flex-1" />
        <button
          onClick={() => {
            onSelect(path)
            close()
          }}
          disabled={!path}
          className="flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[11px] font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Check size={11} /> 使用此目录
        </button>
      </div>
    </div>
  )
}

function AccountMenu({
  hostId,
  profileId,
  model,
  onSelect,
  close,
}: {
  hostId: string
  profileId: string
  model: string
  onSelect: (profileId: string, model: string) => void
  close: () => void
}) {
  const openSettings = useUiStore((s) => s.openSettings)
  const runtime = useAppStore((s) => s.runtimes[hostId])
  const profiles = runtime?.profiles ?? []
  const [query, setQuery] = useState('')
  const selected = profiles.find((p) => p.id === profileId) ?? profiles[0] ?? null
  const [activeId, setActiveId] = useState(selected?.id ?? '')
  const active = profiles.find((p) => p.id === activeId) ?? selected
  const models = useMemo(() => {
    const list = active?.models?.length ? active.models : active?.defaultModel ? [active.defaultModel] : []
    const q = query.trim().toLowerCase()
    return q ? list.filter((m) => m.toLowerCase().includes(q)) : list
  }, [active, query])

  if (profiles.length === 0) {
    return (
      <div className="w-[280px] px-3 py-4 text-center">
        <p className="text-[12.5px] text-text-soft">还没有配置账号</p>
        <p className="mt-1 text-[11px] leading-5 text-muted">添加一个服务商账号后即可选择模型。</p>
        <button
          onClick={() => {
            close()
            openSettings('profiles')
          }}
          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
        >
          <Plus size={12} /> 添加账号
        </button>
      </div>
    )
  }

  return (
    <div className="w-[min(360px,calc(100vw-2rem))]">
      <div className="flex items-center gap-2 px-2 pb-1 pt-1">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted">账号</span>
        <button
          onClick={() => {
            close()
            openSettings('profiles')
          }}
          className="ml-auto text-[10.5px] text-accent transition-opacity hover:opacity-80"
        >
          管理账号
        </button>
      </div>
      <div className="flex gap-1 overflow-x-auto pb-1.5">
        {profiles.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              setActiveId(p.id)
              if (p.id !== profileId) onSelect(p.id, p.defaultModel || p.models[0] || '')
            }}
            className={cn(
              'flex shrink-0 flex-col items-start rounded-lg border px-2 py-1.5 text-left transition-colors',
              p.id === active?.id
                ? 'border-accent/40 bg-accent-soft text-text'
                : 'border-transparent text-text-soft hover:bg-[var(--t-bg-hover)]',
            )}
          >
            <span className="max-w-[120px] truncate text-[11.5px] font-medium">{p.name}</span>
            <span className="max-w-[120px] truncate text-[9.5px] text-muted">{p.defaultModel}</span>
          </button>
        ))}
      </div>
      <div className="border-t border-border pt-1.5">
        <div className="flex items-center gap-1.5 px-2 pb-1">
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted">模型</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型"
            className="ml-auto h-6 w-[120px] rounded-md border border-border bg-bg px-1.5 text-[10.5px] outline-none focus:border-border-strong"
          />
        </div>
        <div className="max-h-[174px] overflow-y-auto">
          {models.map((m) => {
            const isCurrent = active?.id === profileId && m === model
            return (
              <button
                key={m}
                onClick={() => {
                  if (!active) return
                  onSelect(active.id, m)
                  close()
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-soft">{m}</span>
                {isCurrent && <Check size={12} className="shrink-0 text-accent" />}
              </button>
            )
          })}
          {models.length === 0 && (
            <p className="px-2 py-3 text-[11px] text-muted">该账号还没有模型，请到设置中刷新模型列表。</p>
          )}
        </div>
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
  const openSettings = useUiStore((s) => s.openSettings)

  const [hostId, setHostId] = useState(activeHostId ?? hosts[0]?.id ?? '')
  const host = hosts.find((h) => h.id === hostId) ?? null
  const runtime = hostId ? runtimes[hostId] : undefined
  const profiles = runtime?.profiles ?? []
  const hostReady = runtime?.status === 'online'

  const [cwd, setCwd] = useState('')
  const [profileId, setProfileId] = useState('')
  const [model, setModel] = useState('')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)

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

  useEffect(() => {
    if (!hostId) return
    const rt = useAppStore.getState().runtimes[hostId]
    const recent = loadRecentDirs(hostId)
    setCwd(recent[0] ?? rt?.info?.homeDir ?? '')
    void refreshProfiles(hostId)
  }, [hostId, refreshProfiles])

  useEffect(() => {
    if (!profiles.length) {
      setProfileId('')
      setModel('')
      return
    }
    const current = profiles.find((p) => p.id === profileId)
    if (!current) {
      const p = profiles[0]
      setProfileId(p.id)
      setModel(p.defaultModel || p.models[0] || '')
    }
  }, [profiles, profileId])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(200, Math.max(48, el.scrollHeight))}px`
  }, [text])

  const selectedProfile = profiles.find((p) => p.id === profileId) ?? null
  const canSend =
    !!host &&
    hostReady &&
    !!cwd.trim() &&
    !!profileId &&
    !!model &&
    !!text.trim() &&
    !sending

  const submit = async () => {
    if (!canSend || !host) return
    const body = text.trim()
    if (!body) return
    setSending(true)
    setError(null)
    try {
      await startSession(
        host.id,
        { cwd: cwd.trim(), profileId, model, permissionMode: 'default' },
        body,
      )
      rememberDir(host.id, cwd.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建会话失败')
      setSending(false)
    }
  }

  const chooseHost = (id: string) => {
    setHostId(id)
    activateHost(id)
    setError(null)
  }

  const chooseAccount = (pid: string, m: string) => {
    setProfileId(pid)
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

        <div className="rounded-[20px] border border-border bg-surface shadow-[var(--t-shadow-md)] transition-colors duration-150 focus-within:border-border-strong">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={() => {
              composingRef.current = false
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
                e.preventDefault()
                void submit()
              }
            }}
            autoFocus
            rows={2}
            placeholder="描述一个任务，或粘贴一段代码…"
            aria-label="输入第一条消息"
            className="block max-h-[200px] min-h-[70px] w-full resize-none bg-transparent px-4 pt-3.5 text-[14.5px] leading-6 text-text outline-none placeholder:text-muted"
          />
          <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
            <span className="hidden text-[10.5px] text-muted sm:block">
              Enter 发送 · Shift+Enter 换行
            </span>
            <span className="flex-1" />
            {!hostReady && host && (
              <span className="text-[10.5px] text-warning">
                {runtime?.status === 'connecting' ? '连接中…' : 'Host 离线'}
              </span>
            )}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label="发送"
              title="发送"
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-full transition-all duration-150 md:size-8',
                canSend
                  ? 'bg-accent text-on-accent shadow-sm hover:bg-accent-hover active:scale-95'
                  : 'bg-[var(--t-bg-active)] text-muted',
              )}
            >
              {sending ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={16} />}
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
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
                <span className="max-w-[160px] truncate">{basename(cwd) || '工作目录'}</span>
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

          <Picker
            panelClass="w-auto"
            trigger={({ open, toggle }) => (
              <Pill onClick={toggle} title="选择账号与模型" className={open ? 'bg-[var(--t-bg-active)]' : undefined}>
                <Sparkles size={12} className="text-muted" />
                <span className="max-w-[110px] truncate">
                  {selectedProfile?.name ?? '账号'}
                </span>
                {model && (
                  <span className="max-w-[130px] truncate font-mono text-[10.5px] text-muted">
                    {model}
                  </span>
                )}
                <ChevronDown size={11} className="text-muted" />
              </Pill>
            )}
          >
            {(close) =>
              host ? (
                <AccountMenu
                  hostId={host.id}
                  profileId={profileId}
                  model={model}
                  onSelect={chooseAccount}
                  close={close}
                />
              ) : null
            }
          </Picker>
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft/60 px-3 py-2 text-[12px] text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        )}

        {!profiles.length && hostReady && (
          <p className="mt-4 text-center text-[11.5px] text-muted">
            还没有账号，
            <button
              onClick={() => openSettings('profiles')}
              className="text-accent underline-offset-2 hover:underline"
            >
              添加一个账号
            </button>
            ，选择模型后即可开始。
          </p>
        )}

        <div className="mt-8">
          <div className="mb-2 text-center text-[10px] font-medium uppercase tracking-[0.1em] text-muted/80">
            试试
          </div>
          <div className="flex flex-col items-center gap-1">
            {HINTS.map((hint) => (
              <button
                key={hint}
                onClick={() => {
                  setText(hint)
                  textareaRef.current?.focus()
                }}
                className="max-w-full truncate rounded-md px-2 py-1 text-[11.5px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text-soft"
              >
                {hint}
              </button>
            ))}
          </div>
        </div>

        {host && (
          <div className="mt-8 flex items-center justify-center gap-3 text-[10px] text-muted/80">
            <span className="flex items-center gap-1">
              <GitBranch size={10} />
              {cwd ? basename(cwd) : '未选择目录'}
            </span>
            <span>·</span>
            <span>{model || '未选择模型'}</span>
          </div>
        )}
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
  const [parsed, setParsed] = useState<{ url: string; token: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  const parseLink = () => {
    setError(null)
    const raw = link.trim()
    if (!raw) {
      setError('先粘贴带 token 的 Host 链接')
      return
    }
    try {
      let candidate = raw
      if (!/^https?:\/\//i.test(candidate)) candidate = 'http://' + candidate
      const u = new URL(candidate)
      const t = u.searchParams.get('token') ?? ''
      u.searchParams.delete('token')
      const base = (u.origin + u.pathname).replace(/\/+$/, '')
      setUrl(base)
      if (t) setToken(t)
      setParsed({ url: base, token: t })
      if (!t) setError('链接里没有 token，请手动填写 Token')
    } catch {
      setError('链接格式不正确，示例：http://192.168.1.10:7878/?token=xxxx')
    }
  }

  const connect = async () => {
    setError(null)
    setOk(false)
    const targetUrl = url.trim()
    const targetToken = token.trim()
    if (!targetUrl) {
      setError('请填写 Host 地址')
      return
    }
    if (!targetToken) {
      setError('请填写 Host Token')
      return
    }
    setBusy(true)
    try {
      const probe = {
        id: 'probe',
        name: 'probe',
        url: targetUrl,
        token: targetToken,
        addedAt: Date.now(),
      }
      const info = await api.host(probe)
      const host = addHost({
        name: info.name || new URL(targetUrl.startsWith('http') ? targetUrl : 'http://' + targetUrl).host,
        url: targetUrl,
        token: targetToken,
      })
      setOk(true)
      toast(`已连接 ${host.name}`, 'success')
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接失败，请检查地址与 Token')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="anim-slide-up w-full max-w-[440px]">
        <div className="text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-surface shadow-[var(--t-shadow-sm)] ring-1 ring-border">
            <Server size={22} className="text-accent" />
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
            <input
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
              placeholder="http://192.168.1.10:7878/?token=…"
              spellCheck={false}
              autoComplete="off"
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-bg px-2.5 font-mono text-[11.5px] outline-none transition-colors focus:border-border-strong"
            />
            <button
              onClick={parseLink}
              className="h-9 shrink-0 rounded-lg border border-border px-3 text-[11.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)]"
            >
              解析
            </button>
          </div>
          {parsed && (
            <div className="mt-2 rounded-lg bg-[var(--t-bg)] px-2.5 py-1.5 text-[10.5px] leading-4 text-muted">
              <div className="truncate font-mono">{parsed.url}</div>
              <div className="truncate font-mono">
                Token {parsed.token ? `· ${parsed.token.slice(0, 10)}…` : '· 未找到'}
              </div>
            </div>
          )}

          <div className="my-4 flex items-center gap-2 text-[10px] text-muted">
            <span className="h-px flex-1 bg-[var(--t-border)]" />
            或手动填写
            <span className="h-px flex-1 bg-[var(--t-border)]" />
          </div>

          <label className="mb-1.5 block text-[11px] font-medium text-text-soft">地址</label>
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setError(null)
            }}
            placeholder="http://192.168.1.10:7878"
            spellCheck={false}
            autoComplete="off"
            className="h-9 w-full rounded-lg border border-border bg-bg px-2.5 font-mono text-[11.5px] outline-none transition-colors focus:border-border-strong"
          />
          <label className="mb-1.5 mt-3 block text-[11px] font-medium text-text-soft">Token</label>
          <div className="relative">
            <input
              value={token}
              onChange={(e) => {
                setToken(e.target.value)
                setError(null)
              }}
              type={showToken ? 'text' : 'password'}
              placeholder="Host 启动时输出的访问 Token"
              spellCheck={false}
              autoComplete="off"
              className="h-9 w-full rounded-lg border border-border bg-bg px-2.5 pr-9 font-mono text-[11.5px] outline-none transition-colors focus:border-border-strong"
            />
            <button
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? '隐藏 Token' : '显示 Token'}
              className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-[var(--t-bg-hover)] hover:text-text"
            >
              {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
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

          <button
            onClick={() => void connect()}
            disabled={busy}
            className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[12.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            测试并连接
          </button>
        </div>

        <p className="mt-4 text-center text-[10.5px] leading-5 text-muted">
          Token 只保存在本机浏览器中。手机与电脑连接同一 Host 时，会话实时同步。
        </p>
      </div>
    </div>
  )
}
