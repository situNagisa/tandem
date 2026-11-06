import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Check,
  FolderGit2,
  History,
  Loader2,
  Search,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import type { ExternalSession, ExternalSource, Session } from '@tandem/protocol'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useIsMobile } from '../lib/hooks'
import { basename, formatRelative } from '../lib/format'
import { defaultChoiceFor } from '../lib/profileModels'
import { navigate } from '../lib/router'
import { cn } from '../lib/cn'
import { Modal } from './ui/Modal'
import { AssistantMessage, UserMessage } from './MessageList'

const SOURCES: Array<{ id: ExternalSource; label: string; short: string }> = [
  { id: 'claude-code', label: 'Claude Code', short: 'CC' },
  { id: 'codex', label: 'Codex', short: 'Codex' },
]

function sourceLabel(source: ExternalSource): string {
  return SOURCES.find((s) => s.id === source)?.label ?? source
}

interface ProjectGroup {
  cwd: string
  items: ExternalSession[]
}

function PreviewMessages({ session }: { session: Session }) {
  return (
    <div className="flex flex-col gap-5 pb-2">
      {session.messages.map((m) =>
        m.role === 'user' ? (
          <UserMessage key={m.id} message={m} animate={false} />
        ) : (
          <AssistantMessage key={m.id} message={m} streaming={false} animate={false} />
        ),
      )}
      {session.messages.length === 0 && (
        <p className="py-10 text-center text-[12px] text-muted">这个会话没有可预览的消息。</p>
      )}
    </div>
  )
}

export function ExternalSessionsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const isMobile = useIsMobile()
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const refreshExternalSessions = useAppStore((s) => s.refreshExternalSessions)
  const importExternalSession = useAppStore((s) => s.importExternalSession)
  const toast = useUiStore((s) => s.toast)

  const [hostId, setHostId] = useState('')
  const [source, setSource] = useState<ExternalSource>('claude-code')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ExternalSession | null>(null)
  const [preview, setPreview] = useState<Session | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [importProfileId, setImportProfileId] = useState('')
  const [importGroupId, setImportGroupId] = useState<string | undefined>(undefined)
  const [importModel, setImportModel] = useState('')
  const [importing, setImporting] = useState(false)

  const host = hosts.find((h) => h.id === hostId) ?? null
  const runtime = hostId ? runtimes[hostId] : undefined
  const sessions = runtime?.externalSessions ?? []
  const profiles = runtime?.profiles ?? []

  useEffect(() => {
    if (!open) return
    const fallback = activeHostId ?? hosts[0]?.id ?? ''
    setHostId((prev) => (prev && hosts.some((h) => h.id === prev) ? prev : fallback))
    setSelected(null)
    setPreview(null)
    setQuery('')
  }, [open, activeHostId, hosts])

  useEffect(() => {
    if (!open || !hostId) return
    void refreshExternalSessions(hostId, true)
  }, [open, hostId, refreshExternalSessions])

  useEffect(() => {
    if (!open || !selected || !host) return
    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)
    api
      .externalSession(host, selected.source, selected.id)
      .then((session) => {
        if (cancelled) return
        setPreview(session)
        setPreviewLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setPreview(null)
        setPreviewError(err instanceof Error ? err.message : '读取会话失败')
        setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, selected, host])

  useEffect(() => {
    if (!open || profiles.length === 0) return
    const current = profiles.find((p) => p.id === importProfileId)
    if (current) return
    const p = profiles[0]
    const choice = defaultChoiceFor(p)
    setImportProfileId(p.id)
    setImportGroupId(choice?.groupId)
    setImportModel(choice?.model ?? '')
  }, [open, profiles, importProfileId])

  const importProfile = profiles.find((p) => p.id === importProfileId) ?? profiles[0] ?? null
  const importModelList = useMemo(() => {
    if (!importProfile) return []
    if (importGroupId) {
      const g = importProfile.groups?.find((x) => x.id === importGroupId)
      if (g) return g.models.length ? g.models : [g.defaultModel].filter(Boolean)
    }
    return importProfile.models.length
      ? importProfile.models
      : [importProfile.defaultModel].filter(Boolean)
  }, [importProfile, importGroupId])
  const importModelValue = importModelList.includes(importModel)
    ? importModel
    : (importModelList[0] ?? '')

  const counts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const s of sessions) map[s.source] = (map[s.source] ?? 0) + 1
    return map
  }, [sessions])

  const projects = useMemo<ProjectGroup[]>(() => {
    const q = query.trim().toLowerCase()
    const map = new Map<string, ExternalSession[]>()
    for (const s of sessions) {
      if (s.source !== source) continue
      if (
        q &&
        !s.title.toLowerCase().includes(q) &&
        !s.cwd.toLowerCase().includes(q) &&
        !s.id.toLowerCase().includes(q)
      ) {
        continue
      }
      const list = map.get(s.cwd) ?? []
      list.push(s)
      map.set(s.cwd, list)
    }
    return [...map.entries()]
      .map(([cwd, items]) => ({
        cwd,
        items: items.slice().sort((a, b) => b.updatedAt - a.updatedAt),
      }))
      .sort((a, b) => (b.items[0]?.updatedAt ?? 0) - (a.items[0]?.updatedAt ?? 0))
  }, [sessions, source, query])

  const closePanel = () => {
    setSelected(null)
    setPreview(null)
    onClose()
  }

  const chooseSession = (s: ExternalSession) => {
    setSelected(s)
    setPreview(null)
    setPreviewError(null)
  }

  const openImported = (sessionId: string) => {
    if (!hostId) return
    closePanel()
    navigate({ kind: 'session', hostId, sessionId })
  }

  const startImport = async () => {
    if (!selected || !hostId) return
    if (!importProfile) {
      toast('先在设置里添加一个账号', 'error')
      return
    }
    setImporting(true)
    const created = await importExternalSession(hostId, selected.source, selected.id, {
      profileId: importProfile.id,
      ...(importGroupId ? { groupId: importGroupId } : {}),
      ...(importModelValue ? { model: importModelValue } : {}),
    })
    setImporting(false)
    if (created) closePanel()
  }

  const previewContent = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        {isMobile && (
          <button
            onClick={() => setSelected(null)}
            aria-label="返回列表"
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
          >
            <ArrowLeft size={14} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] text-muted">
            <span>{selected ? sourceLabel(selected.source) : ''}</span>
            {selected && (
              <>
                <span>·</span>
                <span>{formatRelative(selected.updatedAt)}</span>
                <span>·</span>
                <span>{selected.messageCount} 条消息</span>
              </>
            )}
          </div>
          <h4 className="mt-0.5 truncate text-[13px] font-semibold">
            {selected?.title || '只读预览'}
          </h4>
          {selected && (
            <p className="mt-0.5 truncate font-mono text-[10px] text-muted" title={selected.cwd}>
              {selected.cwd}
            </p>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {previewLoading && (
          <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-muted">
            <Loader2 size={14} className="animate-spin" /> 正在读取会话…
          </div>
        )}
        {!previewLoading && previewError && (
          <div className="mx-auto mt-10 flex max-w-[320px] items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-3 py-2 text-[11.5px] leading-5 text-danger">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            {previewError}
          </div>
        )}
        {!previewLoading && !previewError && preview && <PreviewMessages session={preview} />}
        {!previewLoading && !previewError && !preview && selected && (
          <p className="py-16 text-center text-[12px] text-muted">正在准备预览…</p>
        )}
      </div>

      {selected && (
        <div className="border-t border-border bg-bg/40 px-4 py-3">
          {selected.importedSessionId ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-[11.5px] text-muted">
                <Check size={12} className="text-success" /> 已导入到 Tandem
              </span>
              <span className="flex-1" />
              <button
                onClick={() => openImported(selected.importedSessionId!)}
                className="flex h-8 items-center gap-1 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
              >
                打开会话
              </button>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="flex items-center gap-1 text-[10.5px] text-muted">
                  <Sparkles size={11} /> 导入后可换任意模型继续
                </span>
                <span className="flex-1" />
                <span className="text-[10px] text-muted">可选账号与模型</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  value={importProfile?.id ?? ''}
                  onChange={(e) => {
                    const p = profiles.find((x) => x.id === e.target.value)
                    const choice = defaultChoiceFor(p)
                    setImportProfileId(e.target.value)
                    setImportGroupId(choice?.groupId)
                    setImportModel(choice?.model ?? '')
                  }}
                  aria-label="导入到账号"
                  className="h-8 max-w-[150px] min-w-0 rounded-lg border border-border bg-surface px-1.5 text-[11px] outline-none focus:border-border-strong"
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {importProfile?.groups?.length ? (
                  <select
                    value={importGroupId ?? ''}
                    onChange={(e) => {
                      const gid = e.target.value || undefined
                      const g = importProfile.groups?.find((x) => x.id === gid)
                      setImportGroupId(gid)
                      setImportModel(g ? g.defaultModel || g.models[0] || '' : '')
                    }}
                    aria-label="导入到分组"
                    className="h-8 max-w-[130px] min-w-0 rounded-lg border border-border bg-surface px-1.5 text-[11px] outline-none focus:border-border-strong"
                  >
                    {importProfile.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <select
                  value={importModelValue}
                  onChange={(e) => setImportModel(e.target.value)}
                  aria-label="导入后使用的模型"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-surface px-1.5 font-mono text-[10.5px] outline-none focus:border-border-strong"
                >
                  {importModelList.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void startImport()}
                  disabled={importing || !importProfile}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-[11.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-60"
                >
                  {importing ? <Loader2 size={12} className="animate-spin" /> : null}
                  在 Tandem 中继续
                </button>
              </div>
              {profiles.length === 0 && (
                <p className="mt-2 text-[10.5px] text-muted">
                  还没有账号，请先在设置里添加账号，再导入会话。
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={closePanel}
      title="导入会话"
      description="只读读取本机已有的 Claude Code / Codex 会话，导入后复制为 Tandem 会话，不会修改原软件的文件。"
      className="max-w-5xl"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
    >
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {(!isMobile || !selected) && (
          <aside className="flex min-h-0 w-full shrink-0 flex-col border-b border-border sm:w-[310px] sm:border-b-0 sm:border-r">
            <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5 pt-3">
              {hosts.length > 1 ? (
                <select
                  value={hostId}
                  onChange={(e) => {
                    setHostId(e.target.value)
                    setSelected(null)
                  }}
                  aria-label="选择 Host"
                  className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-bg px-1.5 text-[11px] outline-none focus:border-border-strong"
                >
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
                  {host?.name ?? '未连接 Host'}
                </span>
              )}
              <button
                onClick={() => hostId && void refreshExternalSessions(hostId, true)}
                disabled={runtime?.externalLoading}
                className="flex h-8 items-center gap-1 rounded-lg border border-border px-2 text-[10.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
              >
                <History size={11} className={runtime?.externalLoading ? 'animate-pulse' : ''} />
                重新扫描
              </button>
            </div>

            <div className="flex gap-1 px-3 pb-1.5">
              {SOURCES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSource(s.id)
                    setSelected(null)
                  }}
                  className={cn(
                    'flex h-8 flex-1 items-center justify-center gap-1 rounded-lg text-[11.5px] transition-colors',
                    source === s.id
                      ? 'bg-[var(--t-bg-active)] font-medium text-text'
                      : 'text-muted hover:bg-[var(--t-bg-hover)] hover:text-text',
                  )}
                >
                  {s.label}
                  <span className="text-[9.5px] tabular-nums opacity-70">
                    {counts[s.id] ?? 0}
                  </span>
                </button>
              ))}
            </div>

            <div className="px-3 pb-2">
              <div className="relative">
                <Search
                  size={12}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索标题或项目路径"
                  aria-label="搜索外部会话"
                  className="h-8 w-full rounded-lg border border-border bg-bg pl-7 pr-2 text-[11.5px] outline-none focus:border-border-strong"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {runtime?.externalLoading && sessions.length === 0 && (
                <div className="space-y-1.5 p-1">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2 px-2 py-2">
                      <div className="skeleton size-3 rounded" />
                      <div className="skeleton h-3 flex-1" />
                    </div>
                  ))}
                </div>
              )}
              {!runtime?.externalLoading && runtime?.externalError && sessions.length === 0 && (
                <div className="mx-1 mt-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[11px] leading-5 text-danger">
                  {runtime.externalError}
                </div>
              )}
              {!runtime?.externalLoading && !runtime?.externalError && projects.length === 0 && (
                <p className="px-3 py-10 text-center text-[11.5px] leading-5 text-muted">
                  {sessions.length === 0
                    ? `没有找到 ${sourceLabel(source)} 的会话记录。`
                    : '没有匹配的会话。'}
                </p>
              )}
              {projects.map((project) => (
                <div key={project.cwd} className="mb-1.5">
                  <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[10.5px] text-muted">
                    <FolderGit2 size={11} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={project.cwd}>
                      {basename(project.cwd) || project.cwd}
                    </span>
                    <span className="shrink-0 tabular-nums">{project.items.length}</span>
                  </div>
                  <div className="space-y-0.5">
                    {project.items.map((s) => (
                      <button
                        key={`${s.source}:${s.id}`}
                        onClick={() => chooseSession(s)}
                        className={cn(
                          'w-full rounded-lg px-2 py-1.5 text-left transition-colors',
                          selected?.source === s.source && selected.id === s.id
                            ? 'bg-[var(--t-bg-active)]'
                            : 'hover:bg-[var(--t-bg-hover)]',
                        )}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-[12px] text-text-soft">
                            {s.title || '未命名会话'}
                          </span>
                          {s.importedSessionId && (
                            <span className="shrink-0 text-[9px] text-muted">已导入</span>
                          )}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1 text-[9.5px] text-muted">
                          <span>{formatRelative(s.updatedAt)}</span>
                          <span>·</span>
                          <span>{s.messageCount} 条</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </aside>
        )}

        {(!isMobile || selected) && (
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selected ? (
              previewContent
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                <span className="flex size-12 items-center justify-center rounded-2xl bg-[var(--t-bg-hover)] text-muted">
                  <History size={22} />
                </span>
                <p className="mt-4 text-[13px] font-medium text-text-soft">选择一个会话查看</p>
                <p className="mt-1 max-w-[280px] text-[11.5px] leading-5 text-muted">
                  左侧按项目列出本机已有的会话，点击即可只读预览。「在 Tandem 中继续」会复制一份，
                  原软件里的记录保持不变。
                </p>
              </div>
            )}
          </section>
        )}
      </div>
    </Modal>
  )
}
