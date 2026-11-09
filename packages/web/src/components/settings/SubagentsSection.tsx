import { useEffect, useMemo, useState } from 'react'
import { Bot, FileCode2, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type {
  DelegationStrategy,
  HostSettings,
  PermissionMode,
  Profile,
  ReasoningEffort,
  SubagentPreset,
  SubagentPresetInput,
} from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { EFFORT_LABEL } from '../../lib/effort'
import { DELEGATION_META, DELEGATION_ORDER } from '../../lib/routeLabels'
import { profileModelGroups } from '../../lib/profileModels'
import { Button, IconButton } from '../ui/Button'
import { Input, Select, Switch } from '../ui/Controls'

const MODE_LABEL: Record<PermissionMode, string> = {
  default: '默认（按规则审批）',
  acceptEdits: '自动接受编辑',
  plan: '计划模式',
  bypassPermissions: '跳过审批',
}

const TOOL_OPTIONS: Array<{ name: string; label: string }> = [
  { name: 'Read', label: '读取文件' },
  { name: 'Glob', label: '按模式找文件' },
  { name: 'Grep', label: '搜索内容' },
  { name: 'Bash', label: '运行命令' },
  { name: 'Write', label: '写入文件' },
  { name: 'Edit', label: '编辑文件' },
  { name: 'WebFetch', label: '访问网页' },
  { name: 'TodoWrite', label: '维护待办' },
  { name: 'Skill', label: '加载技能' },
  { name: 'Task', label: '继续派发子代理' },
]

interface Draft {
  id?: string
  name: string
  description: string
  profileId: string
  groupId: string
  model: string
  effort: '' | ReasoningEffort
  permissionMode: '' | PermissionMode
  delegation: '' | DelegationStrategy
  allowedTools: string[]
  systemPrompt: string
}

function emptyDraft(): Draft {
  return {
    name: '',
    description: '',
    profileId: '',
    groupId: '',
    model: '',
    effort: '',
    permissionMode: '',
    delegation: '',
    allowedTools: [],
    systemPrompt: '',
  }
}

function draftOf(input: SubagentPresetInput): Draft {
  return {
    ...(input.id ? { id: input.id } : {}),
    name: input.name,
    description: input.description ?? '',
    profileId: input.profileId ?? '',
    groupId: input.groupId ?? '',
    model: input.model ?? '',
    effort: input.effort ?? '',
    permissionMode: input.permissionMode ?? '',
    delegation: input.delegation ?? '',
    allowedTools: [...(input.allowedTools ?? [])],
    systemPrompt: input.systemPrompt ?? '',
  }
}

function toInput(draft: Draft): SubagentPresetInput {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(draft.profileId ? { profileId: draft.profileId } : {}),
    ...(draft.groupId ? { groupId: draft.groupId } : {}),
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.effort ? { effort: draft.effort } : {}),
    ...(draft.permissionMode ? { permissionMode: draft.permissionMode } : {}),
    ...(draft.delegation ? { delegation: draft.delegation } : {}),
    ...(draft.allowedTools.length ? { allowedTools: [...draft.allowedTools] } : {}),
    ...(draft.systemPrompt.trim() ? { systemPrompt: draft.systemPrompt.trim() } : {}),
  }
}

function modelChoices(profiles: Profile[], profileId: string, groupId: string): string[] {
  const profile = profiles.find((item) => item.id === profileId)
  if (!profile) return []
  const groups = profileModelGroups(profile)
  const group = groups.find((item) => (item.groupId ?? '') === groupId)
  const models = group ? group.models : groups.flatMap((item) => item.models)
  return [...new Set(models)]
}

export function SubagentsSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const active = useAppStore((s) => s.active)
  const runtimes = useAppStore((s) => s.runtimes)
  const toast = useUiStore((s) => s.toast)
  const host = hosts.find((h) => h.id === (active?.hostId ?? activeHostId)) ?? null
  const runtime = host ? runtimes[host.id] : undefined
  const profiles = runtime?.profiles ?? []
  const cwd = active?.summary?.cwd ?? runtime?.info?.homeDir
  const hostReady = runtime?.status === 'online'

  const [presets, setPresets] = useState<SubagentPreset[]>([])
  const [custom, setCustom] = useState<SubagentPresetInput[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [settings, setSettings] = useState<HostSettings | null>(null)

  const load = () => {
    if (!host) {
      setPresets([])
      setCustom([])
      return
    }
    setLoading(true)
    setError(null)
    api
      .subagentPresets(host, cwd)
      .then(({ presets: list }) => {
        setPresets(list)
        setCustom(
          list
            .filter((item) => item.source === 'tandem')
            .map((item) => {
              const { source: _source, file: _file, modelAlias: _alias, ...input } = item
              return input
            }),
        )
        setDirty(false)
      })
      .catch((err) => setError(err instanceof Error ? err.message : '读取子代理预设失败'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [host, cwd])

  useEffect(() => {
    if (!host) {
      setSettings(null)
      return
    }
    let cancelled = false
    api
      .settings(host)
      .then((nextSettings) => {
        if (!cancelled) setSettings(nextSettings)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [host])

  const readOnly = useMemo(() => presets.filter((item) => item.source !== 'tandem'), [presets])

  const startCreate = () => setDraft(emptyDraft())
  const startEdit = (input: SubagentPresetInput) => setDraft(draftOf(input))

  const commitDraft = () => {
    if (!draft) return
    if (!draft.name.trim()) {
      toast('预设名称不能为空', 'error')
      return
    }
    setCustom((prev) => {
      const next = toInput(draft)
      const index = draft.id ? prev.findIndex((item) => item.id === draft.id) : -1
      if (index >= 0) return prev.map((item, i) => (i === index ? next : item))
      return [...prev, next]
    })
    setDraft(null)
    setDirty(true)
  }

  const remove = (id: string | undefined) => {
    setCustom((prev) => prev.filter((item) => item.id !== id))
    setDirty(true)
  }

  const save = async () => {
    if (!host || saving) return
    setSaving(true)
    try {
      const { presets: list } = await api.saveSubagentPresets(host, custom, cwd)
      setPresets(list)
      setCustom(
        list
          .filter((item) => item.source === 'tandem')
          .map((item) => {
            const { source: _source, file: _file, modelAlias: _alias, ...input } = item
            return input
          }),
      )
      setDirty(false)
      toast('子代理预设已保存', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const saveDefaultDelegation = async (value: DelegationStrategy) => {
    if (!host || !settings) return
    const previous = settings
    setSettings({ ...settings, defaultDelegation: value })
    try {
      const next = await api.updateSettings(host, { ...settings, defaultDelegation: value })
      setSettings(next)
      toast('新会话默认委派倾向已保存', 'success')
    } catch (err) {
      setSettings(previous)
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    }
  }

  if (!host) {
    return <p className="text-[13px] text-muted">先连接一台主机，再配置子代理预设。</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-[15px] font-medium text-text">
            <Bot size={15} className="text-muted" /> 子代理预设
          </h2>
          <p className="mt-1 text-[12.5px] leading-5 text-muted">
            预设名称会作为 Task 工具的 subagent_type 暴露给模型；可让子代理换用更便宜的账号/模型。
            同时只读加载 Claude Code 的 <code>~/.claude/agents/*.md</code> 与项目{' '}
            <code>.claude/agents/*.md</code>。
          </p>
        </div>
        <IconButton label="刷新" onClick={load} disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </IconButton>
        <Button data-setting-id="subagents.create" size="sm" variant="secondary" onClick={startCreate} icon={<Plus size={13} />}>
          新建预设
        </Button>
        <Button
          data-setting-id="subagents.presets"
          size="sm"
          variant="primary"
          onClick={save}
          disabled={!dirty || saving || !hostReady}
          icon={saving ? <Loader2 size={13} className="animate-spin" /> : undefined}
        >
          保存
        </Button>
      </div>

      <div data-setting-id="subagents.default-delegation" className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
        <span className="text-[12.5px] text-text-soft">新会话默认委派倾向</span>
        <Select
          aria-label="新会话默认委派倾向"
          value={settings?.defaultDelegation ?? 'less'}
          onChange={(e) => void saveDefaultDelegation(e.target.value as DelegationStrategy)}
          wrapperClassName="w-[240px] max-w-full"
        >
          {DELEGATION_ORDER.map((value) => (
            <option key={value} value={value}>
              {DELEGATION_META[value].longLabel}
            </option>
          ))}
        </Select>
        <span className="text-[12px] text-muted">会话内可在输入框底栏的「执行方式 → 委派倾向」随时切换。</span>
      </div>

      {error && <div className="rounded-lg border border-danger/25 bg-danger-soft/50 px-3 py-2 text-[12px] text-danger">{error}</div>}
      {!hostReady && <div className="text-[12px] text-warning">主机离线，暂时无法保存预设。</div>}

      {draft && (
        <div className="rounded-xl border border-border bg-surface p-3">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] font-medium">{draft.id ? '编辑预设' : '新建预设'}</span>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="text-[12px] text-muted hover:text-text"
            >
              取消
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-[12px] text-muted">
              名称（作为 subagent_type）
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="如 探索 / 测试 / 审查"
              />
            </label>
            <label className="space-y-1 text-[12px] text-muted">
              描述（给模型看）
              <Input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="只读搜索代码与定位实现"
              />
            </label>
            <label className="space-y-1 text-[12px] text-muted">
              账号
              <Select
                value={draft.profileId}
                onChange={(e) => {
                  const profileId = e.target.value
                  const profile = profiles.find((item) => item.id === profileId)
                  const group = profile ? profileModelGroups(profile)[0] : undefined
                  setDraft({
                    ...draft,
                    profileId,
                    groupId: group?.groupId ?? '',
                    model: group?.models[0] ?? '',
                  })
                }}
              >
                <option value="">继承主会话</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 text-[12px] text-muted">
              分组
              <Select
                value={draft.groupId}
                onChange={(e) => {
                  const current = profiles.find((item) => item.id === draft.profileId)
                  const group = (current ? profileModelGroups(current) : []).find(
                    (item) => (item.groupId ?? '') === e.target.value,
                  )
                  setDraft({ ...draft, groupId: e.target.value, model: group?.models[0] ?? draft.model })
                }}
                disabled={!draft.profileId}
              >
                <option value="">账号默认</option>
                {(profiles.find((item) => item.id === draft.profileId)
                  ? profileModelGroups(profiles.find((item) => item.id === draft.profileId)!)
                  : []
                ).map(
                  (group) => (
                    <option key={group.groupId ?? 'default'} value={group.groupId ?? ''}>
                      {group.name}
                    </option>
                  ),
                )}
              </Select>
            </label>
            <label className="space-y-1 text-[12px] text-muted">
              模型
              <Select
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                disabled={!draft.profileId}
              >
                <option value="">默认 / Claude 别名</option>
                <option value="auto">自动（按自动路由候选池）</option>
                {modelChoices(profiles, draft.profileId, draft.groupId).map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 text-[12px] text-muted">
              思考强度
              <Select
                value={draft.effort}
                onChange={(e) => setDraft({ ...draft, effort: e.target.value as Draft['effort'] })}
              >
                <option value="">继承主会话</option>
                {(Object.keys(EFFORT_LABEL) as ReasoningEffort[]).map((effort) => (
                  <option key={effort} value={effort}>
                    {EFFORT_LABEL[effort]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 text-[12px] text-muted">
              权限模式
              <Select
                value={draft.permissionMode}
                onChange={(e) =>
                  setDraft({ ...draft, permissionMode: e.target.value as Draft['permissionMode'] })
                }
              >
                <option value="">继承主会话</option>
                {(Object.keys(MODE_LABEL) as PermissionMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {MODE_LABEL[mode]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="space-y-1 text-[12px] text-muted">
              子代理委派倾向
              <Select
                value={draft.delegation}
                onChange={(e) =>
                  setDraft({ ...draft, delegation: e.target.value as Draft['delegation'] })
                }
              >
                <option value="">跟随主会话（默认）</option>
                {DELEGATION_ORDER.map((value) => (
                  <option key={value} value={value}>
                    {DELEGATION_META[value].longLabel}
                  </option>
                ))}
              </Select>
            </label>
            <label className="sm:col-span-2 space-y-1 text-[12px] text-muted">
              附加系统提示
              <textarea
                value={draft.systemPrompt}
                onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
                placeholder="例如：只做只读调研，不修改文件；输出中文结论。"
                rows={3}
                className="w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-2 text-[13px] text-text outline-none placeholder:text-muted focus:border-border-strong"
              />
            </label>
          </div>
          <div className="mt-3">
            <div className="mb-1.5 text-[12px] text-muted">可用工具（不选则继承主会话全部工具）</div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {TOOL_OPTIONS.map((tool) => (
                <div key={tool.name} className="flex items-center justify-between gap-2 rounded-md px-1 py-0.5">
                  <span className="min-w-0 truncate text-[12.5px] text-text-soft">
                    {tool.label} <span className="font-mono text-[12px] text-muted">{tool.name}</span>
                  </span>
                  <Switch
                    checked={draft.allowedTools.includes(tool.name)}
                    onChange={(checked) =>
                      setDraft({
                        ...draft,
                        allowedTools: checked
                          ? [...draft.allowedTools, tool.name]
                          : draft.allowedTools.filter((name) => name !== tool.name),
                      })
                    }
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="primary" onClick={commitDraft}>
              加入列表
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {custom.length === 0 && !draft && (
          <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-[12.5px] text-muted">
            还没有自定义子代理预设。新建一个「探索」或「测试」，让主会话把任务派给便宜模型。
          </div>
        )}
        {custom.map((preset) => {
          const profile = profiles.find((item) => item.id === preset.profileId)
          const model = preset.model || profile?.defaultModel || '继承主会话模型'
          return (
            <div
              key={preset.id ?? preset.name}
              className="flex items-start gap-2 rounded-xl border border-border bg-surface px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium text-text">{preset.name}</span>
                  <span className="rounded bg-[var(--t-bg-active)] px-1.5 py-px font-mono text-[12px] text-muted">
                    {model}
                  </span>
                  {preset.effort && (
                    <span className="text-[12px] text-muted">effort {preset.effort}</span>
                  )}
                  {preset.delegation && (
                    <span className="text-[12px] text-muted">
                      委派 {DELEGATION_META[preset.delegation].label}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[12px] text-muted">
                  {preset.description || '无描述'}
                  {profile ? ` · ${profile.name}` : ' · 继承主会话账号'}
                  {preset.allowedTools?.length ? ` · ${preset.allowedTools.length} 个工具` : ''}
                </div>
              </div>
              <IconButton label="编辑" onClick={() => startEdit(preset)}>
                <Pencil size={13} />
              </IconButton>
              <IconButton label="删除" onClick={() => remove(preset.id)}>
                <Trash2 size={13} />
              </IconButton>
            </div>
          )
        })}
      </div>

      {readOnly.length > 0 && (
        <div className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-[12.5px] font-medium text-text-soft">
            <FileCode2 size={13} className="text-muted" /> 从 Claude Code 读取（只读）
          </h3>
          {readOnly.map((preset) => (
            <div key={preset.id} className="rounded-xl border border-border/70 bg-bg/30 px-3 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] font-medium text-text-soft">{preset.name}</span>
                <span className="rounded bg-[var(--t-bg-hover)] px-1.5 py-px text-[12px] text-muted">
                  {preset.source === 'project' ? '项目 agents/' : '~/.claude/agents/'}
                </span>
                <span className="font-mono text-[12px] text-muted">
                  {preset.modelAlias ? `${preset.modelAlias} → 已映射` : preset.model ?? '继承模型'}
                </span>
              </div>
              <div className={cn('mt-0.5 truncate text-[12px] text-muted')}>
                {preset.description || '无描述'}
                {preset.allowedTools?.length ? ` · ${preset.allowedTools.length} 个工具` : ''}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="border-t border-border pt-3 text-[12px] text-muted">提示词统一在「设置 → 提示词」中编辑；未修改时跟随内置默认。</p>
    </div>
  )
}
