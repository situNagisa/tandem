// 设置-提示词：统一注册表入口。左侧按类别列出全部提示词，右侧查看/编辑（只读项标注原因）。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PromptCategory, PromptTemplate, PromptTemplateKey } from '@tandem/protocol'
import { AlertTriangle, FileCode2, Loader2, Lock, RotateCcw, Save, ScrollText, Sparkles } from 'lucide-react'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { Button } from '../ui/Button'

const CATEGORY_LABEL: Record<PromptCategory, string> = {
  system: '系统提示',
  workflow: '工作流',
  command: '命令',
  aux: '辅助任务',
}

const CATEGORY_ORDER: PromptCategory[] = ['system', 'workflow', 'command', 'aux']

type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

/** 轻量行级 diff：提示词通常几十行，LCS 足够。 */
function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i++] })
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] })
    } else {
      out.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}

export function PromptsSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const active = useAppStore((s) => s.active)
  const runtimes = useAppStore((s) => s.runtimes)
  const toast = useUiStore((s) => s.toast)
  const host = hosts.find((h) => h.id === (active?.hostId ?? activeHostId)) ?? null
  const runtime = host ? runtimes[host.id] : undefined
  const cwd = active?.summary?.cwd ?? runtime?.info?.homeDir
  const hostReady = runtime?.status === 'online'

  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [drafts, setDrafts] = useState<Partial<Record<PromptTemplateKey, string>>>({})
  const [selectedKey, setSelectedKey] = useState<PromptTemplateKey | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)

  // 小屏下列表与编辑区上下堆叠：选中后把编辑区滚进视口，避免“点了没反应”。
  const selectItem = (key: PromptTemplateKey) => {
    setSelectedKey(key)
    setShowDiff(false)
    if (!window.matchMedia('(max-width: 639px)').matches) return
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        editorRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
      ),
    )
  }

  const load = () => {
    if (!host) return
    setLoading(true)
    api
      .promptTemplates(host, cwd)
      .then(({ templates: next }) => {
        setTemplates(next)
        setDrafts({})
        setError(null)
        setSelectedKey((prev) =>
          prev && next.some((item) => item.key === prev)
            ? prev
            : (next.find((item) => item.editable)?.key ?? next[0]?.key ?? null),
        )
      })
      .catch((err) => setError(err instanceof Error ? err.message : '加载提示词失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id, cwd])

  const grouped = useMemo(() => {
    const map = new Map<PromptCategory, PromptTemplate[]>()
    for (const category of CATEGORY_ORDER) map.set(category, [])
    for (const item of templates) map.get(item.category)?.push(item)
    return map
  }, [templates])

  const selected = templates.find((item) => item.key === selectedKey) ?? null
  const draft = selected ? (drafts[selected.key] ?? selected.text) : ''
  const dirty = selected?.editable ? draft !== selected.text : false
  const changedKeys = templates.filter(
    (item) => item.editable && drafts[item.key] !== undefined && drafts[item.key] !== item.text,
  )

  const save = async () => {
    if (!host || !changedKeys.length || saving) return
    setSaving(true)
    try {
      const values: Partial<Record<PromptTemplateKey, string>> = {}
      for (const item of changedKeys) {
        const next = drafts[item.key]!
        values[item.key] = next.trim() === '' || next === item.defaultText ? '' : next
      }
      const result = await api.savePromptTemplates(host, values, cwd)
      setTemplates(result.templates)
      setDrafts({})
      setShowDiff(false)
      toast('提示词已保存，下一轮请求生效', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const restoreDefault = () => {
    if (!selected?.editable) return
    setDrafts((prev) => ({ ...prev, [selected.key]: selected.defaultText }))
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-[15px] font-medium text-text">
            <ScrollText size={15} className="text-muted" /> 提示词
          </h2>
          <p className="mt-1 text-[12.5px] leading-5 text-muted">
            内置提示词统一在这里查看。可编辑项存 <code>~/.tandem/prompts.json</code>，未修改时跟随内置默认；
            项目根 <code>.tandem/prompts.json</code> 可覆盖（只读，优先级更高）。
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading || !hostReady} icon={loading ? <Loader2 size={13} className="animate-spin" /> : undefined}>
          刷新
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={save}
          disabled={!changedKeys.length || saving || !hostReady}
          icon={saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
        >
          保存{changedKeys.length ? `（${changedKeys.length}）` : ''}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}

      <div className="flex min-h-[420px] flex-col gap-3 sm:flex-row">
        <nav className="w-full shrink-0 space-y-2 sm:w-56 sm:border-r sm:border-border sm:pr-2">
          {CATEGORY_ORDER.map((category) => {
            const list = grouped.get(category) ?? []
            if (!list.length) return null
            return (
              <div key={category} className="space-y-0.5">
                <div className="px-2 py-1 text-[12px] font-medium uppercase tracking-wide text-muted">
                  {CATEGORY_LABEL[category]}
                </div>
                {list.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => selectItem(item.key)}
                    className={cn(
                      'flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors',
                      selectedKey === item.key
                        ? 'bg-[var(--t-bg-active)] text-text'
                        : 'text-text-soft hover:bg-[var(--t-bg-hover)]',
                    )}
                  >
                    {item.editable ? (
                      <Sparkles size={11} className="shrink-0 text-accent-text" />
                    ) : (
                      <Lock size={11} className="shrink-0 text-muted" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.modified && (
                      <span className="shrink-0 rounded bg-accent/15 px-1 py-px text-[12px] text-accent-text">
                        {item.source === 'project' ? '项目' : '已改'}
                      </span>
                    )}
                    {item.editable && drafts[item.key] !== undefined && drafts[item.key] !== item.text && (
                      <span className="size-1.5 shrink-0 rounded-full bg-accent" title="未保存" />
                    )}
                  </button>
                ))}
              </div>
            )
          })}
        </nav>

        <div ref={editorRef} className="min-w-0 flex-1 scroll-mt-2">
          {!selected ? (
            <div className="rounded-xl border border-border/70 px-3 py-6 text-center text-[12.5px] text-muted">
              {loading ? '正在加载提示词…' : '没有可展示的提示词'}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[13.5px] font-medium text-text">{selected.label}</h3>
                <span className="rounded bg-[var(--t-bg-hover)] px-1.5 py-px text-[12px] text-muted">
                  {CATEGORY_LABEL[selected.category]}
                </span>
                {selected.editable ? (
                  <span className="rounded bg-accent/10 px-1.5 py-px text-[12px] text-accent-text">可编辑</span>
                ) : (
                  <span className="flex items-center gap-1 rounded bg-[var(--t-bg-hover)] px-1.5 py-px text-[12px] text-muted">
                    <Lock size={9} /> 只读
                  </span>
                )}
                {selected.source === 'project' && (
                  <span className="rounded bg-[var(--t-bg-hover)] px-1.5 py-px text-[12px] text-text-soft">
                    项目覆盖
                  </span>
                )}
                {selected.modified && selected.source === 'user' && (
                  <span className="rounded bg-accent/15 px-1.5 py-px text-[12px] text-accent-text">已修改</span>
                )}
                {dirty && (
                  <span className="rounded bg-warning/15 px-1.5 py-px text-[12px] text-warning">未保存</span>
                )}
              </div>

              <p className="text-[12px] leading-5 text-muted">{selected.description}</p>

              {selected.variables?.length ? (
                <div className="flex flex-wrap items-center gap-1 text-[12px] text-muted">
                  可用变量：
                  {selected.variables.map((name) => (
                    <code key={name} className="rounded bg-[var(--t-bg-hover)] px-1 py-px font-mono">
                      {name}
                    </code>
                  ))}
                </div>
              ) : null}

              {selected.readOnlyReason && (
                <div className="flex items-start gap-1.5 rounded-lg border border-border/70 bg-[var(--t-bg-subtle)] px-2.5 py-2 text-[12px] leading-5 text-muted">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warning" />
                  <span>只读原因：{selected.readOnlyReason}</span>
                </div>
              )}

              {selected.source === 'project' && (
                <div className="flex items-start gap-1.5 rounded-lg border border-border/70 bg-[var(--t-bg-subtle)] px-2.5 py-2 text-[12px] leading-5 text-muted">
                  <FileCode2 size={12} className="mt-0.5 shrink-0" />
                  <span>
                    当前生效内容来自项目文件 <code>.tandem/prompts.json</code>
                    。在设置里保存会写入用户级，但项目覆盖仍然优先。
                  </span>
                </div>
              )}

              <textarea
                aria-label={`${selected.label}提示词`}
                value={draft}
                readOnly={!selected.editable}
                onChange={(e) =>
                  setDrafts((prev) => ({ ...prev, [selected.key]: e.target.value }))
                }
                rows={selected.key === 'toolGuidance' || selected.key === 'baseBehavior' ? 14 : 10}
                spellCheck={false}
                className={cn(
                  'w-full resize-y rounded-xl border border-border bg-surface px-3 py-2.5 font-mono text-[13px] leading-5 text-text outline-none placeholder:text-muted focus:border-border-strong',
                  !selected.editable && 'cursor-default bg-[var(--t-bg-subtle)] text-text-soft',
                )}
              />

              <div className="flex flex-wrap items-center gap-2">
                {selected.editable && (
                  <>
                    <Button size="sm" variant="secondary" onClick={restoreDefault} icon={<RotateCcw size={13} />}>
                      恢复默认
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setShowDiff((v) => !v)}
                      icon={<FileCode2 size={13} />}
                    >
                      {showDiff ? '收起 diff' : '与默认值 diff'}
                    </Button>
                    {selected.source === 'project' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setDrafts((prev) => ({ ...prev, [selected.key]: selected.projectText ?? selected.text }))}
                      >
                        复制项目文本到用户级
                      </Button>
                    )}
                  </>
                )}
                <span className="ml-auto text-[12px] text-muted">
                  {draft.length} 字 · 约 {Math.ceil(draft.length / 3.5)} tokens
                </span>
              </div>

              {showDiff && selected.editable && (
                <div className="max-h-[360px] overflow-auto rounded-xl border border-border bg-[var(--t-bg-subtle)]">
                  <div className="border-b border-border px-3 py-1.5 text-[12px] text-muted">
                    默认值 → 当前编辑内容（<span className="text-danger">− 删除</span> /{' '}
                    <span className="text-success">+ 新增</span>）
                  </div>
                  <pre className="px-3 py-2 font-mono text-[12px] leading-5">
                    {lineDiff(selected.defaultText, draft).map((line, index) => (
                      <div
                        key={index}
                        className={cn(
                          'whitespace-pre-wrap break-words',
                          line.kind === 'add' && 'bg-success/10 text-success',
                          line.kind === 'del' && 'bg-danger/10 text-danger',
                          line.kind === 'same' && 'text-text-soft',
                        )}
                      >
                        {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '− ' : '  '}
                        {line.text || ' '}
                      </div>
                    ))}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
