import { useEffect, useMemo, useState } from 'react'
import { Loader2, Lock, Plus, ShieldCheck, Trash2, Webhook } from 'lucide-react'
import type { HookEntry, HookEvent, HookSettings, HookSource } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { api } from '../../lib/api'
import { Button, IconButton } from '../ui/Button'
import { Input, Select } from '../ui/Controls'

const EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart']

const SOURCE_LABEL: Record<HookSource, string> = {
  tandem: 'Tandem（可编辑）',
  'claude-user': 'Claude Code 用户设置（只读）',
  'claude-project': '项目 Claude 设置（只读）',
  'claude-project-local': '项目本地 Claude 设置（只读）',
}

function isProjectSource(source: HookSource): boolean {
  return source === 'claude-project' || source === 'claude-project-local'
}

function normalize(entry: HookEntry): HookEntry {
  return {
    id: entry.id,
    event: entry.event,
    ...(entry.matcher?.trim() ? { matcher: entry.matcher.trim() } : {}),
    command: entry.command.trim(),
    ...(entry.timeout ? { timeout: entry.timeout } : {}),
    source: 'tandem',
  }
}

export function HooksSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const active = useAppStore((s) => s.active)
  const toast = useUiStore((s) => s.toast)
  const host =
    hosts.find((h) => h.id === (active?.hostId ?? activeHostId)) ?? null
  const cwd = active?.summary?.cwd

  const [data, setData] = useState<HookSettings | null>(null)
  const [draft, setDraft] = useState<HookEntry[]>([])
  const [saved, setSaved] = useState<HookEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [trusting, setTrusting] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!host) {
      setData(null)
      setDraft([])
      setSaved([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError(undefined)
    api
      .hooks(host, cwd)
      .then((settings) => {
        if (cancelled) return
        const tandem = settings.entries.filter((entry) => entry.source === 'tandem')
        setData(settings)
        setDraft(tandem)
        setSaved(tandem)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : '读取 Hooks 配置失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, cwd])

  const dirty = useMemo(
    () => JSON.stringify(draft.map(normalize)) !== JSON.stringify(saved.map(normalize)),
    [draft, saved],
  )

  const bySource = useMemo(() => {
    const map = new Map<HookSource, HookEntry[]>()
    for (const entry of data?.entries ?? []) {
      const list = map.get(entry.source) ?? []
      list.push(entry)
      map.set(entry.source, list)
    }
    return map
  }, [data])

  const update = (index: number, patch: Partial<HookEntry>) => {
    setDraft((prev) => prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  }

  const save = async () => {
    if (!host || saving) return
    setSaving(true)
    try {
      const settings = await api.saveHooks(host, draft.map(normalize), cwd)
      const tandem = settings.entries.filter((entry) => entry.source === 'tandem')
      setData(settings)
      setDraft(tandem)
      setSaved(tandem)
      toast('Hooks 已保存', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存 Hooks 失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const setTrust = async (trusted: boolean) => {
    if (!host || !cwd || trusting) return
    setTrusting(true)
    try {
      const settings = await api.trustHooks(host, cwd, trusted)
      setData(settings)
      toast(trusted ? '已信任此项目的 Hooks' : '已撤销项目 Hooks 信任', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新信任状态失败', 'error')
    } finally {
      setTrusting(false)
    }
  }

  if (!host) {
    return <p className="text-[12.5px] text-muted">先添加一台 Host 才能配置 Hooks。</p>
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted">
        <Loader2 size={16} className="animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <Webhook size={15} className="text-text-soft" />
          <h2 className="text-[14px] font-semibold">Hooks</h2>
          <span className="rounded bg-bg-hover px-1.5 py-0.5 text-[10.5px] text-muted">{host.name}</span>
        </div>
        <p className="mt-1 text-[12px] leading-5 text-muted">
          兼容 Claude Code 的 hooks 配置形状。命令通过 stdin 收到包含 session_id、cwd、hook_event_name、
          tool_name、tool_input、tool_response 的 JSON；退出码 0 继续，2 阻止并把 stderr 回填给模型，
          其他非 0 只记录警告。stdout 可返回 decision / reason / continue 字段，超时默认 60 秒。
        </p>
        {cwd ? (
          <p className="mt-1 break-all font-mono text-[10.5px] text-muted">项目目录：{cwd}</p>
        ) : (
          <p className="mt-1 text-[11px] text-muted">
            打开一个会话后可查看该项目的项目级 hooks；当前只显示用户级配置。
          </p>
        )}
      </div>

      {error ? (
        <p className="rounded-lg border border-danger/30 bg-danger-soft/40 px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      ) : (
        <div className="space-y-5">
          {data &&
            (['claude-user', 'claude-project', 'claude-project-local', 'tandem'] as HookSource[]).map(
              (source) => {
                const info = data.sources.find((item) => item.source === source)
                if (!info) return null
                const entries = source === 'tandem' ? [] : (bySource.get(source) ?? [])
                if (source === 'tandem') {
                  return (
                    <section key={source} className="space-y-2">
                      <SourceHeader label={SOURCE_LABEL[source]} path={info.path} readOnly={false} />
                      <div className="space-y-2">
                        {draft.length === 0 && (
                          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted">
                            暂无 Tandem Hooks。可添加命令在工具执行或消息提交前后运行。
                          </p>
                        )}
                        {draft.map((entry, index) => (
                          <div
                            key={entry.id || index}
                            className="space-y-1.5 rounded-lg border border-border bg-bg/40 px-2 py-2"
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Select
                                size="sm"
                                value={entry.event}
                                onChange={(e) => update(index, { event: e.target.value as HookEvent })}
                                aria-label="事件"
                                wrapperClassName="w-[132px] shrink-0"
                              >
                                {EVENTS.map((event) => (
                                  <option key={event} value={event}>
                                    {event}
                                  </option>
                                ))}
                              </Select>
                              <Input
                                size="sm"
                                value={entry.matcher ?? ''}
                                onChange={(e) =>
                                  update(index, { matcher: e.target.value || undefined })
                                }
                                placeholder="matcher：Bash|Edit（留空匹配全部）"
                                aria-label="matcher"
                                className="min-w-0 flex-1 font-mono"
                              />
                              <Input
                                size="sm"
                                type="number"
                                min={1}
                                max={600}
                                value={entry.timeout ?? ''}
                                onChange={(e) =>
                                  update(index, {
                                    timeout: e.target.value ? Number(e.target.value) : undefined,
                                  })
                                }
                                placeholder="60"
                                aria-label="超时（秒）"
                                className="w-[64px] shrink-0 text-center tabular-nums"
                              />
                              <IconButton
                                size="sm"
                                variant="danger-ghost"
                                onClick={() =>
                                  setDraft((prev) => prev.filter((_, i) => i !== index))
                                }
                                label="删除 Hook"
                                className="size-7 shrink-0 [&_svg]:size-3"
                              >
                                <Trash2 size={12} />
                              </IconButton>
                            </div>
                            <Input
                              size="sm"
                              value={entry.command}
                              onChange={(e) => update(index, { command: e.target.value })}
                              placeholder='命令，如 "$CLAUDE_PROJECT_DIR/.claude/hooks/lint.sh"'
                              aria-label="命令"
                              className="font-mono"
                            />
                          </div>
                        ))}
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="secondary"
                            onClick={() =>
                              setDraft((prev) => [
                                ...prev,
                                {
                                  id: `tandem:new:${Date.now()}`,
                                  event: 'PreToolUse',
                                  command: '',
                                  source: 'tandem',
                                },
                              ])
                            }
                            className="border-dashed"
                          >
                            <Plus size={13} /> 添加 Hook
                          </Button>
                          <span className="text-[11px] text-muted">
                            {dirty ? '有未保存的修改' : draft.length ? `共 ${draft.length} 条` : ''}
                          </span>
                          <span className="flex-1" />
                          {dirty && (
                            <Button size="sm" onClick={() => setDraft(saved)}>
                              撤销
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => void save()}
                            disabled={!dirty || saving}
                          >
                            {saving && <Loader2 size={11} className="animate-spin" />}
                            保存
                          </Button>
                        </div>
                      </div>
                    </section>
                  )
                }
                return (
                  <section key={source} className="space-y-2">
                    <SourceHeader label={SOURCE_LABEL[source]} path={info.path} readOnly />
                    {entries.length === 0 ? (
                      <p className="px-1 text-[11.5px] text-muted">
                        {info.exists ? '未配置 hooks。' : '文件不存在。'}
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {entries.map((entry) => (
                          <div
                            key={entry.id}
                            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-border/70 bg-bg/30 px-2.5 py-2 text-[12px]"
                          >
                            <span className="shrink-0 rounded bg-bg-hover px-1.5 py-0.5 font-mono text-[10.5px] text-text-secondary">
                              {entry.event}
                            </span>
                            {entry.matcher && (
                              <span className="shrink-0 font-mono text-[10.5px] text-muted">
                                /{entry.matcher}/
                              </span>
                            )}
                            <span className="min-w-0 flex-1 break-all font-mono text-[11px] leading-5 text-text-soft">
                              {entry.command}
                            </span>
                            {entry.timeout && (
                              <span className="shrink-0 text-[10.5px] tabular-nums text-muted">
                                {entry.timeout}s
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )
              },
            )}

          {data?.hasProjectHooks && (
            <div className="rounded-lg border border-border bg-bg/40 px-3 py-2.5">
              <div className="flex items-start gap-2">
                <ShieldCheck size={14} className="mt-0.5 shrink-0 text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-text">
                    项目 hooks {data.projectTrusted ? '已信任' : '尚未信任'}
                  </p>
                  <p className="mt-0.5 text-[11.5px] leading-5 text-muted">
                    来自项目目录的 hooks 会在工具执行前后运行任意命令，首次使用前需要你确认。
                    {data.projectTrusted
                      ? ' 当前项目的 hooks 会正常运行。'
                      : ' 在信任之前，这些 hooks 会被跳过。'}
                  </p>
                </div>
                {cwd && (
                  <Button
                    size="sm"
                    variant={data.projectTrusted ? 'ghost' : 'secondary'}
                    onClick={() => void setTrust(!data.projectTrusted)}
                    disabled={trusting}
                  >
                    {trusting && <Loader2 size={11} className="animate-spin" />}
                    {data.projectTrusted ? '撤销信任' : '信任此项目的 Hooks'}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SourceHeader({
  label,
  path,
  readOnly,
}: {
  label: string
  path: string
  readOnly: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-[12px] font-medium text-text-secondary">{label}</h3>
      {readOnly && (
        <span className="flex items-center gap-0.5 rounded border border-border px-1 py-px text-[9.5px] text-muted">
          <Lock size={9} /> 只读
        </span>
      )}
      <span className="min-w-0 truncate font-mono text-[10px] text-muted" title={path}>
        {path}
      </span>
    </div>
  )
}
