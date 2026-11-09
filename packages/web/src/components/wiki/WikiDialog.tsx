// 项目 Wiki 视图：左侧页面树 + 全文搜索，右侧 Markdown；支持手写段落与增量更新。
import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  CalendarClock,
  FileText,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import type { WikiPage, WikiSearchHit } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { rememberWikiHost, useWikiStore } from '../../store/useWikiStore'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { formatAgo } from '../../lib/format'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { PanelBar, PanelBody } from '../ui/Panel'
import { Input, Select, Textarea } from '../ui/Controls'
import { Markdown } from '../Markdown'
import { WikiGenerateDialog } from './WikiGenerateDialog'

const KIND_LABEL: Record<string, string> = {
  overview: '概览',
  module: '模块',
  glossary: '术语',
}

export function WikiDialog() {
  const openState = useUiStore((s) => s.wikiOpen)
  const closeWiki = useUiStore((s) => s.closeWiki)
  const toast = useUiStore((s) => s.toast)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.active?.hostId) ?? null)
  const project = openState?.project ?? ''
  const key = host && project ? `${host.id}\u0000${project}` : ''
  const entry = useWikiStore((s) => (key ? s.entries[key] : undefined))
  const refresh = useWikiStore((s) => s.refresh)
  const loadPage = useWikiStore((s) => s.loadPage)
  const saveManual = useWikiStore((s) => s.saveManual)
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WikiSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [generateMode, setGenerateMode] = useState<'generate' | 'update'>('generate')

  const meta = entry?.meta ?? null
  const pages = meta?.pages ?? []
  const page: WikiPage | undefined = selected ? entry?.pages[selected] : undefined
  const running = entry?.jobs.find((job) => job.status === 'running')

  useEffect(() => {
    if (!openState) return
    setQuery('')
    setResults([])
    setEditing(false)
    setSelected(openState.page ?? '')
    if (openState.generate) {
      setGenerateMode(openState.generate)
      setGenerateOpen(true)
    } else {
      setGenerateOpen(false)
    }
  }, [openState])

  useEffect(() => {
    if (!host || !project) return
    rememberWikiHost(host)
    void refresh(host, project, openState?.page)
  }, [host, project, openState?.page, refresh])

  useEffect(() => {
    if (!host || !project) return
    if (!selected) return
    void loadPage(host, project, selected)
    setEditing(false)
  }, [host, project, selected, loadPage])

  // 生成/更新过程中当前页可能被重写：元数据时间变化时强制重读。
  const metaUpdatedAt = meta?.updatedAt ?? 0
  useEffect(() => {
    if (!host || !project || !selected || !metaUpdatedAt) return
    void loadPage(host, project, selected, true)
  }, [host, project, selected, metaUpdatedAt, loadPage])

  useEffect(() => {
    if (!selected && pages.length > 0) setSelected(pages[0]!.id)
  }, [selected, pages])

  useEffect(() => {
    if (!host || !project || !query.trim()) {
      setResults([])
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = window.setTimeout(() => {
      api
        .wikiSearch(host, project, query.trim(), 12)
        .then((result) => {
          if (!cancelled) setResults(result.hits)
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [host, project, query])

  useEffect(() => {
    if (!host || !project || !running) return
    const timer = window.setInterval(() => void refresh(host, project, selected), 2500)
    return () => window.clearInterval(timer)
  }, [host, project, running?.id, selected, refresh])

  const groups = useMemo(() => {
    const overview = pages.filter((item) => item.kind === 'overview')
    const modules = pages.filter((item) => item.kind === 'module')
    const glossary = pages.filter((item) => item.kind === 'glossary')
    return [
      { label: '概览', items: overview },
      { label: '模块', items: modules },
      { label: '术语', items: glossary },
    ].filter((group) => group.items.length > 0)
  }, [pages])

  const startEdit = () => {
    if (!page) return
    setDraft(page.manual)
    setEditing(true)
  }

  const saveEdit = async () => {
    if (!host || !page) return
    setSaving(true)
    const saved = await saveManual(host, project, page.id, draft)
    setSaving(false)
    if (saved) {
      setEditing(false)
      toast('已保存手写段落')
      void refresh(host, project, page.id)
    } else {
      toast('保存失败', 'error')
    }
  }

  const setDaily = async () => {
    if (!host) return
    try {
      const schedule = await api.wikiSchedule(host, project)
      toast(`已设置每天更新（${schedule.cron}）`)
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  const cancelJob = async () => {
    if (!host || !running) return
    try {
      await api.wikiCancelJob(host, running.id)
      toast('已请求取消')
    } catch (err) {
      toast((err as Error).message, 'error')
    }
  }

  const body = page
    ? [page.auto, page.manual ? `## 手写笔记\n\n${page.manual}` : ''].filter(Boolean).join('\n\n')
    : ''

  return (
    <>
      <Modal
        open={!!openState}
        onClose={closeWiki}
        ariaLabel="项目 Wiki"
        title={
          <span className="flex items-center gap-2">
            <BookOpen size={16} className="text-text-tertiary" />
            项目 Wiki
            {meta?.name ? <span className="text-[12px] font-normal text-muted">{meta.name}</span> : null}
          </span>
        }
        className="h-[80dvh] w-[1120px] max-w-[94vw]"
        bodyClassName="p-0 overflow-hidden"
      >
        <div className="flex h-full min-h-0 flex-col md:flex-row">
          <aside className="hidden w-[250px] shrink-0 flex-col border-r border-border bg-[var(--t-sidebar)]/45 md:flex">
            <div className="space-y-2 border-b border-border p-3">
              <div className="relative">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索 Wiki…"
                  className="pl-8"
                  aria-label="搜索 Wiki"
                />
              </div>
              {query ? (
                <p className="text-[12px] text-muted">
                  {searching ? '搜索中…' : `${results.length} 个结果`}
                </p>
              ) : null}
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Wiki 页面">
              {query ? (
                results.length === 0 ? (
                  <p className="px-2 py-3 text-[12px] text-muted">{searching ? '搜索中…' : '没有匹配页面'}</p>
                ) : (
                  <ul className="space-y-0.5">
                    {results.map((hit) => (
                      <li key={hit.pageId}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelected(hit.pageId)
                            setQuery('')
                          }}
                          className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
                        >
                          <span className="block truncate text-[12.5px] text-text">{hit.title}</span>
                          <span className="mt-0.5 line-clamp-2 block text-[12px] leading-4 text-muted">{hit.snippet}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )
              ) : groups.length === 0 ? (
                <p className="px-2 py-3 text-[12px] leading-5 text-muted">还没有页面。点右上角「生成 Wiki」。</p>
              ) : (
                groups.map((group) => (
                  <div key={group.label} className="mb-2">
                    <p className="px-2 pb-1 text-[12px] font-medium uppercase tracking-[0.12em] text-text-tertiary">
                      {group.label}
                    </p>
                    <ul className="space-y-0.5">
                      {group.items.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => setSelected(item.id)}
                            className={cn(
                              'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12.5px] leading-4 transition-colors',
                              selected === item.id
                                ? 'bg-[var(--t-bg-active)] text-text'
                                : 'text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text',
                            )}
                          >
                            <FileText size={12} className="shrink-0 text-muted" />
                            <span className="min-w-0 flex-1 truncate">{item.title}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </nav>
            <div className="border-t border-border p-2">
              <Button
                size="sm"
                variant="secondary"
                className="w-full"
                onClick={() => {
                  setGenerateMode(meta?.exists ? 'update' : 'generate')
                  setGenerateOpen(true)
                }}
              >
                <Sparkles size={12} /> {meta?.exists ? '更新 Wiki' : '生成 Wiki'}
              </Button>
            </div>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
              <Select
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                aria-label="选择 Wiki 页面"
              >
                {pages.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </Select>
            </div>
            <div className="border-b border-border px-3 py-2 md:hidden">
              <div className="relative">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索 Wiki…"
                  className="pl-8"
                  aria-label="搜索 Wiki（手机）"
                />
              </div>
              {query ? (
                <div className="mt-1 max-h-40 overflow-y-auto">
                  {searching ? (
                    <p className="px-1 py-1 text-[12px] text-muted">搜索中…</p>
                  ) : results.length === 0 ? (
                    <p className="px-1 py-1 text-[12px] text-muted">没有匹配页面</p>
                  ) : (
                    results.map((hit) => (
                      <button
                        key={hit.pageId}
                        type="button"
                        onClick={() => {
                          setSelected(hit.pageId)
                          setQuery('')
                        }}
                        className="block w-full rounded-md px-2 py-1.5 text-left text-[12px] text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text"
                      >
                        <span className="block truncate">{hit.title}</span>
                        <span className="line-clamp-1 block text-[12px] text-muted">{hit.snippet}</span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            <PanelBar autoHeight className="flex-col gap-2 px-4 py-2.5 md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">
                  {page?.title ?? (meta?.exists ? '选择页面' : '项目还没有 Wiki')}
                </p>
                {meta?.exists ? (
                  <p className="mt-0.5 truncate text-[12px] text-muted">
                    基于 {page?.commit || meta.commit ? `commit ${page?.commit || meta.commit}` : '生成时的代码'}
                    {page?.updatedAt || meta.updatedAt ? ` · ${formatAgo(page?.updatedAt || meta.updatedAt || 0)}` : ''}
                    {meta.changedFiles > 0 ? ` · 之后有 ${meta.changedFiles} 个文件改动` : ' · 没有新改动'}
                  </p>
                ) : (
                  <p className="mt-0.5 text-[12px] text-muted">生成后可供人和 agent 检索项目架构。</p>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-start gap-1.5 md:justify-end">
                {meta?.exists ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!page || editing || !!running}
                      onClick={startEdit}
                    >
                      <Pencil size={12} /> 编辑手写段落
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!running}
                      onClick={() => {
                        setGenerateMode('update')
                        setGenerateOpen(true)
                      }}
                    >
                      <RefreshCw size={12} /> 更新
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!!running} onClick={() => void setDaily()}>
                      <CalendarClock size={12} /> 每天更新
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setGenerateMode('generate')
                      setGenerateOpen(true)
                    }}
                  >
                    <Sparkles size={12} /> 生成 Wiki
                  </Button>
                )}
              </div>
            </PanelBar>

            {running ? (
              <div className="border-b border-border bg-[var(--t-surface-2)]/50 px-4 py-2">
                <div className="flex items-center gap-2 text-[12px] text-text-soft">
                  <Spinner size={12} />
                  <span className="min-w-0 flex-1 truncate">
                    {running.current ? `正在生成：${running.current}` : '准备生成…'}
                  </span>
                  <span className="tabular-nums text-muted">
                    {running.done}/{running.total}
                  </span>
                  <button
                    type="button"
                    onClick={() => void cancelJob()}
                    className="rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-[var(--t-bg-hover)] hover:text-text"
                  >
                    取消
                  </button>
                </div>
                <div className="mt-1.5 h-0.5 overflow-hidden rounded-full bg-[var(--t-bg-active)]/60">
                  <div
                    className="h-full rounded-full bg-[var(--t-text-tertiary)]/70 transition-[width] duration-300"
                    style={{ width: `${running.total ? (running.done / running.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ) : null}

            <PanelBody scroll className="px-6 py-5" style={{ scrollbarGutter: 'stable' }}>
              {entry?.error ? (
                <p className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">
                  {entry.error}
                </p>
              ) : null}
              {editing && page ? (
                <div className="space-y-3">
                  <p className="text-[12px] leading-5 text-muted">
                    自动段落会在增量更新时重写；这里只编辑「手写段落」，更新 Wiki 时原样保留。
                  </p>
                  <Textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    className="min-h-[380px] font-mono text-[12.5px] leading-5"
                    placeholder="记录只有人知道的背景、坑、约定……（Markdown）"
                    aria-label="手写段落"
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="primary" disabled={saving} onClick={() => void saveEdit()}>
                      {saving ? '保存中…' : '保存'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : page ? (
                <div className="wiki-markdown mx-auto w-full min-w-0 max-w-[780px]">
                  <Markdown text={body} cwd={project} />
                  {!page.manual ? (
                    <p className="mt-6 border-t border-border pt-3 text-[12px] text-muted">
                      还没有手写段落。点上方「编辑手写段落」补充自动生成之外的信息。
                    </p>
                  ) : null}
                </div>
              ) : meta?.exists ? (
                <div className="flex h-full items-center justify-center text-[12px] text-muted">
                  <Spinner size={14} className="mr-2" /> 正在读取页面…
                </div>
              ) : (
                <div className="mx-auto flex h-full max-w-[440px] flex-col items-center justify-center gap-3 text-center">
                  <BookOpen size={28} className="text-text-tertiary" />
                  <p className="text-[14px] font-medium">为这个项目生成 Wiki</p>
                  <p className="text-[12px] leading-5 text-muted">
                    后台只读阅读代码，产出概览、主要模块页与术语表。生成后可全文搜索、手动补充，agent 也能用 WikiSearch 检索。
                  </p>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      setGenerateMode('generate')
                      setGenerateOpen(true)
                    }}
                  >
                    <Sparkles size={12} /> 生成 Wiki
                  </Button>
                </div>
              )}
            </PanelBody>
          </section>
        </div>
      </Modal>

      <WikiGenerateDialog
        host={host}
        project={project}
        mode={generateMode}
        open={!!openState && generateOpen}
        onClose={() => setGenerateOpen(false)}
        onStarted={() => {
          if (host && project) void refresh(host, project, selected)
        }}
      />
    </>
  )
}
