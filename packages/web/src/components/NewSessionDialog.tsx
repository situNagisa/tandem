import { useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Settings2,
  TriangleAlert,
  ArrowUp,
} from 'lucide-react'
import type { FsEntry } from '@tandem/protocol'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { loadRecentDirs, rememberDir } from '../lib/storage'
import { dirname, basename } from '../lib/format'
import { cn } from '../lib/cn'
import { Modal } from './ui/Modal'
import { ConnectionDot } from './StatusDot'

const inputCls =
  'h-11 w-full rounded-lg border border-border bg-surface px-2.5 text-[12.5px] text-text outline-none transition-colors focus:border-border-strong disabled:opacity-60 sm:h-9'

export function NewSessionDialog() {
  const open = useUiStore((s) => s.newSessionOpen)
  const setOpen = useUiStore((s) => s.setNewSessionOpen)
  const openSettings = useUiStore((s) => s.openSettings)
  const toast = useUiStore((s) => s.toast)
  const hosts = useAppStore((s) => s.hosts)
  const createSession = useAppStore((s) => s.createSession)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const runtimes = useAppStore((s) => s.runtimes)

  const [hostId, setHostId] = useState<string | null>(null)
  const [path, setPath] = useState('')
  const [pathDraft, setPathDraft] = useState('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [dirError, setDirError] = useState<string | null>(null)
  const [profileId, setProfileId] = useState('')
  const [model, setModel] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recents, setRecents] = useState<string[]>([])

  const host = hosts.find((h) => h.id === hostId) ?? null
  const runtime = hostId ? runtimes[hostId] : undefined
  const profiles = runtime?.profiles ?? []
  const profilesLoading = runtime?.profilesLoading ?? false
  const selectedProfile = profiles.find((p) => p.id === profileId) ?? null
  const online = runtime?.status === 'online'

  useEffect(() => {
    if (!open) return
    const st = useAppStore.getState()
    const id = st.activeHostId ?? st.hosts[0]?.id ?? null
    setHostId(id)
    setError(null)
    setCreating(false)
    setDirError(null)
    setProfileId('')
    setModel('')
    if (id) {
      const rt = st.runtimes[id]
      const recent = loadRecentDirs(id)
      const p = recent[0] ?? rt?.info?.homeDir ?? ''
      setPath(p)
      setPathDraft(p)
      setRecents(recent)
      void refreshProfiles(id)
    } else {
      setPath('')
      setPathDraft('')
      setRecents([])
    }
  }, [open, refreshProfiles])

  useEffect(() => {
    if (!open || !host) return
    let cancelled = false
    setLoading(true)
    setDirError(null)
    api
      .fsList(host, path)
      .then((list) => {
        if (cancelled) return
        const dirs = list
          .filter((e) => e.isDir)
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
        setEntries(dirs)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setEntries([])
        setDirError(err instanceof Error ? err.message : '无法读取目录')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, host, path, refreshKey])

  useEffect(() => {
    if (!profiles.length) return
    if (!profiles.some((p) => p.id === profileId)) {
      const p = profiles[0]
      setProfileId(p.id)
      setModel(p.defaultModel || p.models[0] || '')
    }
  }, [profiles, profileId])

  const parent = useMemo(() => dirname(path), [path])
  const models = useMemo(() => {
    if (!selectedProfile) return []
    return selectedProfile.models.length
      ? selectedProfile.models
      : [selectedProfile.defaultModel].filter(Boolean)
  }, [selectedProfile])

  const go = (target: string) => {
    setPath(target)
    setPathDraft(target)
    setRefreshKey((k) => k + 1)
  }

  const commitPath = () => {
    const next = pathDraft.trim()
    if (!next || next === path) return
    go(next)
  }

  const changeHost = (id: string) => {
    setHostId(id)
    setProfileId('')
    setModel('')
    const st = useAppStore.getState()
    const rt = st.runtimes[id]
    const recent = loadRecentDirs(id)
    const p = recent[0] ?? rt?.info?.homeDir ?? ''
    setPath(p)
    setPathDraft(p)
    setRecents(recent)
    setError(null)
    void refreshProfiles(id)
  }

  const handleCreate = async () => {
    if (!hostId || !online) return
    const cwd = (pathDraft.trim() || path.trim()).trim()
    if (!cwd) {
      setError('请选择一个工作目录')
      return
    }
    if (!profileId || !model) {
      setError('请选择账号与模型')
      return
    }
    setCreating(true)
    setError(null)
    try {
      await createSession(hostId, { cwd, profileId, model })
      rememberDir(hostId, cwd)
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建会话失败')
      toast(err instanceof Error ? err.message : '创建会话失败', 'error')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="新建会话"
      description="选择 Host、工作目录与账号模型，开始一次新的协作。"
      className="max-w-2xl"
      bodyClassName="p-0"
      footer={
        <>
          <button
            onClick={() => setOpen(false)}
            className="min-h-11 rounded-lg border border-border bg-surface px-3.5 text-[12.5px] text-text-soft transition-colors hover:bg-surface-2 sm:min-h-10"
          >
            取消
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !online || !hostId || !profileId || !model}
            className={cn(
              'flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 text-[12.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50 sm:min-h-10',
            )}
          >
            {creating && <Loader2 size={14} className="animate-spin" />}
            创建会话
          </button>
        </>
      }
    >
      <div className="divide-y divide-border">
        {error && (
          <div className="flex items-start gap-2 bg-danger-soft/60 px-4 py-2.5 text-[12px] text-danger">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        )}

        <section className="p-4">
          <label className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-muted">
            Host
            {runtime && <ConnectionDot state={runtime.status} />}
            {runtime && (
              <span className="text-[10.5px] text-muted">
                {runtime.status === 'online' ? '在线' : runtime.status === 'connecting' ? '连接中' : '离线'}
              </span>
            )}
          </label>
          <div className="flex items-center gap-2">
            <select
              value={hostId ?? ''}
              onChange={(e) => changeHost(e.target.value)}
              className={inputCls}
              disabled={hosts.length === 0}
            >
              {hosts.length === 0 && <option value="">还没有 Host</option>}
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} — {h.url.replace(/^https?:\/\//, '')}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                setOpen(false)
                openSettings('hosts')
              }}
              title="管理 Host"
              aria-label="管理 Host"
              className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-surface-2 hover:text-text sm:size-9"
            >
              <Settings2 size={14} />
            </button>
          </div>
          {host && !online && (
            <p className="mt-2 text-[11.5px] text-warning">
              这台 Host 当前不可用，连上后才能创建会话。
            </p>
          )}
        </section>

        <section className="p-4">
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] font-medium text-muted">
            <span>工作目录</span>
            <span className="text-[10px] font-normal text-muted/80">
              {path ? basename(path) : '主目录'}
            </span>
            <span className="flex-1" />
            <button
              onClick={() => go(runtime?.info?.homeDir ?? '')}
              className="rounded-md px-2 py-1 text-[10.5px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              主目录
            </button>
          </div>

          {recents.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {recents.slice(0, 4).map((dir) => (
                <button
                  key={dir}
                  onClick={() => go(dir)}
                  title={dir}
                  className={cn(
                    'max-w-full truncate rounded-md border px-2 py-1 font-mono text-[10.5px] transition-colors',
                    dir === path
                      ? 'border-accent/40 bg-accent-soft/60 text-accent'
                      : 'border-border bg-surface text-muted hover:bg-surface-2 hover:text-text',
                  )}
                >
                  {basename(dir) || dir}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => parent && go(parent)}
              disabled={!parent || loading}
              title="上一级"
              aria-label="上一级目录"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
            >
              <ArrowUp size={14} />
            </button>
            <input
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitPath()
                }
              }}
              placeholder="输入目录路径后回车"
              aria-label="工作目录路径"
              spellCheck={false}
              className={cn(inputCls, 'font-mono text-[11.5px]')}
            />
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={loading}
              title="刷新目录"
              aria-label="刷新目录"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="mt-2 h-[190px] overflow-y-auto rounded-lg border border-border bg-bg/40 p-1 sm:h-[168px]">
            {loading && entries.length === 0 && (
              <div className="flex h-full items-center justify-center gap-2 text-[11.5px] text-muted">
                <Loader2 size={13} className="animate-spin" /> 读取目录…
              </div>
            )}
            {!loading && dirError && (
              <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-[11.5px] text-danger">
                <TriangleAlert size={15} />
                <span>{dirError}</span>
              </div>
            )}
            {!loading && !dirError && entries.length === 0 && (
              <div className="flex h-full items-center justify-center text-[11.5px] text-muted">
                这个目录下没有子文件夹
              </div>
            )}
            {!dirError &&
              entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => go(entry.path)}
                  className="group flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text sm:min-h-8"
                >
                  <Folder size={13} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <ChevronRight
                    size={12}
                    className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </button>
              ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-muted">
            <FolderOpen size={12} className="shrink-0" />
            <span className="min-w-0 truncate font-mono" title={pathDraft}>
              将在 {pathDraft.trim() || path || '主目录'} 中工作
            </span>
          </div>
        </section>

        <section className="grid gap-3 p-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-muted">账号</label>
            <select
              value={profileId}
              onChange={(e) => {
                const p = profiles.find((x) => x.id === e.target.value)
                setProfileId(e.target.value)
                setModel(p?.defaultModel || p?.models[0] || '')
              }}
              className={inputCls}
              disabled={profiles.length === 0}
            >
              {profiles.length === 0 && (
                <option value="">{profilesLoading ? '加载账号…' : '没有可用账号'}</option>
              )}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {!profilesLoading && profiles.length === 0 && (
              <button
                onClick={() => {
                  setOpen(false)
                  openSettings('profiles')
                }}
                className="mt-1.5 text-[11px] text-accent hover:underline"
              >
                去设置里添加账号 →
              </button>
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-muted">模型</label>
            {models.length > 0 ? (
              <select value={model} onChange={(e) => setModel(e.target.value)} className={inputCls}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="模型 ID"
                className={cn(inputCls, 'font-mono')}
              />
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}
