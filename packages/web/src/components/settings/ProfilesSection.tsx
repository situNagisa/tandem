import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Wifi,
} from 'lucide-react'
import type { Profile, ProfileInput, ProviderKind } from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { PROVIDER_PRESETS, type ProviderPreset } from '../../lib/presets'
import { PROVIDER_KIND_LABELS } from '../../lib/types'
import { cn } from '../../lib/cn'

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-[12.5px] text-text outline-none transition-colors focus:border-border-strong'
const labelCls = 'mb-1.5 block text-[11px] font-medium text-muted'

interface FormState {
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  modelsText: string
  defaultModel: string
}

function emptyForm(): FormState {
  return {
    name: '',
    kind: 'anthropic',
    baseUrl: '',
    apiKey: '',
    modelsText: '',
    defaultModel: '',
  }
}

function formFromProfile(p: Profile): FormState {
  return {
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl ?? '',
    apiKey: '',
    modelsText: p.models.join('\n'),
    defaultModel: p.defaultModel,
  }
}

function parseModels(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[\n,]/)) {
    const m = raw.trim()
    if (!m || seen.has(m)) continue
    seen.add(m)
    out.push(m)
  }
  return out
}

function applyPreset(form: FormState, preset: ProviderPreset): FormState {
  return {
    ...form,
    name: form.name.trim() || preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    modelsText: preset.models.join('\n'),
    defaultModel: preset.defaultModel,
  }
}

export function ProfilesSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const toast = useUiStore((s) => s.toast)

  const [hostId, setHostId] = useState<string | null>(activeHostId ?? hosts[0]?.id ?? null)
  const [editing, setEditing] = useState<'new' | string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string }>>({})

  const host = hosts.find((h) => h.id === hostId) ?? null
  const runtime = hostId ? runtimes[hostId] : undefined
  const profiles = runtime?.profiles ?? []
  const loading = runtime?.profilesLoading ?? false
  const models = useMemo(() => parseModels(form.modelsText), [form.modelsText])
  const editingProfile =
    editing && editing !== 'new' ? profiles.find((p) => p.id === editing) ?? null : null

  useEffect(() => {
    if (!hostId || !hosts.some((h) => h.id === hostId)) {
      const fallback = activeHostId ?? hosts[0]?.id ?? null
      if (fallback && fallback !== hostId) setHostId(fallback)
      return
    }
    const rt = useAppStore.getState().runtimes[hostId]
    if (!rt?.profilesLoaded && !rt?.profilesLoading) void refreshProfiles(hostId)
  }, [hostId, activeHostId, hosts, refreshProfiles])

  useEffect(() => {
    if (editingProfile && editing !== 'new') {
      setForm(formFromProfile(editingProfile))
      setError(null)
    }
  }, [editing, editingProfile])

  const startNew = () => {
    setEditing('new')
    setForm(emptyForm())
    setError(null)
    setShowKey(false)
  }

  const startEdit = (p: Profile) => {
    setEditing(p.id)
    setForm(formFromProfile(p))
    setError(null)
    setShowKey(false)
  }

  const save = async () => {
    if (!host) return
    const name = form.name.trim()
    const modelList = parseModels(form.modelsText)
    if (!name) {
      setError('请填写账号名称')
      return
    }
    if (modelList.length === 0) {
      setError('至少填写一个模型')
      return
    }
    const defaultModel = modelList.includes(form.defaultModel)
      ? form.defaultModel
      : modelList[0]
    const input: ProfileInput = {
      name,
      kind: form.kind,
      baseUrl: form.baseUrl.trim() || undefined,
      apiKey: form.apiKey.trim() || undefined,
      models: modelList,
      defaultModel,
    }
    setSaving(true)
    setError(null)
    try {
      if (editing === 'new') {
        await api.createProfile(host, input)
        toast('账号已创建', 'success')
      } else if (editing) {
        await api.updateProfile(host, editing, input)
        toast('账号已更新', 'success')
      }
      await refreshProfiles(host.id)
      setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (p: Profile) => {
    if (!host) return
    if (!window.confirm(`删除账号「${p.name}」？使用它的会话需要重新选择账号。`)) return
    try {
      await api.deleteProfile(host, p.id)
      await refreshProfiles(host.id)
      if (editing === p.id) setEditing(null)
      toast('账号已删除', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  const test = async (p: Profile) => {
    if (!host) return
    setTestingId(p.id)
    try {
      const res = await api.testProfile(host, p.id)
      setTestResults((prev) => ({ ...prev, [p.id]: res }))
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [p.id]: { ok: false, error: err instanceof Error ? err.message : '测试失败' },
      }))
    } finally {
      setTestingId(null)
    }
  }

  if (!host) {
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-muted">
        先添加一台 Host，再配置账号。
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">账号与模型</h3>
        <span className="hidden text-[11px] text-muted sm:inline">保存在 Host 端，Key 不会下发明文</span>
        <span className="flex-1" />
        {hosts.length > 1 && (
          <select
            value={hostId ?? ''}
            onChange={(e) => {
              setHostId(e.target.value)
              setEditing(null)
            }}
            className={cn(inputCls, 'h-8 w-auto max-w-[180px] text-[11.5px]')}
          >
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => host && void refreshProfiles(host.id)}
          disabled={loading}
          title="刷新"
          aria-label="刷新账号"
          className="flex size-11 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50 sm:size-8"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={startNew}
          className="flex min-h-11 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover sm:min-h-8"
        >
          <Plus size={13} /> 新建账号
        </button>
      </div>

      {runtime?.authError && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft/50 px-3 py-2 text-[11.5px] text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {runtime.authError}
        </div>
      )}
      {!runtime?.authError && runtime?.error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft/50 px-3 py-2 text-[11.5px] text-warning">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {runtime.error}
        </div>
      )}

      {editing ? (
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="mb-3 flex items-center gap-2">
            <button
              onClick={() => setEditing(null)}
              className="flex size-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
              aria-label="返回账号列表"
            >
              <ArrowLeft size={14} />
            </button>
            <h4 className="text-[13px] font-semibold">
              {editing === 'new' ? '新建账号' : `编辑「${editingProfile?.name ?? '账号'}」`}
            </h4>
          </div>

          {editing === 'new' && (
            <div className="mb-4">
              <div className={labelCls}>快速预设</div>
              <div className="flex flex-wrap gap-1.5">
                {PROVIDER_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setForm((f) => applyPreset(f, p))
                      setError(null)
                    }}
                    className="rounded-md border border-border bg-bg/40 px-2 py-1 text-[11px] text-text-soft transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-text"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>名称</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="例如：公司 Anthropic"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>接口类型</label>
              <select
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as ProviderKind }))}
                className={inputCls}
              >
                {Object.entries(PROVIDER_KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls}>Base URL（可选）</label>
              <input
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://api.anthropic.com"
                spellCheck={false}
                className={cn(inputCls, 'font-mono text-[11.5px]')}
              />
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls}>API Key</label>
              <div className="relative">
                <input
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  type={showKey ? 'text' : 'password'}
                  placeholder={
                    editing !== 'new'
                      ? `已保存：${editingProfile?.apiKeyMasked ?? '••••'}（留空不修改）`
                      : 'sk-…'
                  }
                  spellCheck={false}
                  autoComplete="off"
                  className={cn(inputCls, 'pr-9 font-mono text-[11.5px]')}
                />
                <button
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? '隐藏 Key' : '显示 Key'}
                  className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
                >
                  {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>
            <div>
              <label className={labelCls}>模型列表（每行一个）</label>
              <textarea
                value={form.modelsText}
                onChange={(e) => setForm((f) => ({ ...f, modelsText: e.target.value }))}
                rows={4}
                spellCheck={false}
                placeholder={'claude-sonnet-4-5\nclaude-haiku-4-5'}
                className="w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-2 font-mono text-[11.5px] outline-none transition-colors focus:border-border-strong"
              />
            </div>
            <div>
              <label className={labelCls}>默认模型</label>
              {models.length > 0 ? (
                <select
                  value={form.defaultModel}
                  onChange={(e) => setForm((f) => ({ ...f, defaultModel: e.target.value }))}
                  className={cn(inputCls, 'font-mono text-[11.5px]')}
                >
                  {!models.includes(form.defaultModel) && <option value="">选择默认模型</option>}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex h-9 items-center rounded-lg border border-dashed border-border px-2.5 text-[11.5px] text-muted">
                  先填写模型列表
                </div>
              )}
              {editing !== 'new' && form.apiKey.trim() === '' && (
                <p className="mt-2 text-[10.5px] leading-4 text-muted">
                  留空会保留原来的 Key；修改其他字段不影响密钥。
                </p>
              )}
            </div>
          </div>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft/50 px-3 py-2 text-[11.5px] text-danger">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {editingProfile && (
              <>
                <button
                  onClick={() => void test(editingProfile)}
                  disabled={testingId === editingProfile.id}
                  className="flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-60"
                >
                  {testingId === editingProfile.id ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Wifi size={13} />
                  )}
                  测试连接
                </button>
                {testResults[editingProfile.id] && (
                  <span
                    className={cn(
                      'text-[11px]',
                      testResults[editingProfile.id].ok ? 'text-success' : 'text-danger',
                    )}
                  >
                    {testResults[editingProfile.id].ok
                      ? '连接成功'
                      : testResults[editingProfile.id].error || '连接失败'}
                  </span>
                )}
                <span className="flex-1" />
                <button
                  onClick={() => void remove(editingProfile)}
                  className="flex min-h-9 items-center gap-1.5 rounded-lg border border-danger/25 px-3 text-[12px] text-danger transition-colors hover:bg-danger-soft/50"
                >
                  <Trash2 size={13} /> 删除
                </button>
              </>
            )}
            {!editingProfile && <span className="flex-1" />}
            <button
              onClick={() => setEditing(null)}
              className="min-h-9 rounded-lg border border-border bg-surface px-3 text-[12px] text-text-soft transition-colors hover:bg-surface-2"
            >
              取消
            </button>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {saving && <Loader2 size={13} className="animate-spin" />}
              保存账号
            </button>
          </div>
        </div>
      ) : (
        <div>
          {loading && profiles.length === 0 && (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
                  <div className="skeleton size-8 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <div className="skeleton h-3 w-1/3" />
                    <div className="skeleton h-2.5 w-2/3" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && profiles.length === 0 && (
            <div className="rounded-xl border border-dashed border-border bg-bg/30 px-4 py-8 text-center">
              <KeyRound size={22} className="mx-auto text-muted" />
              <p className="mt-2 text-[12.5px] text-text-soft">还没有配置账号</p>
              <p className="mt-1 text-[11.5px] text-muted">
                新建一个账号，或从常用预设开始（Anthropic、OpenAI、DeepSeek…）。
              </p>
              <button
                onClick={startNew}
                className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
              >
                <Plus size={13} /> 新建账号
              </button>
            </div>
          )}

          <div className="space-y-2">
            {profiles.map((p) => {
              const result = testResults[p.id]
              return (
                <div
                  key={p.id}
                  className="rounded-xl border border-border bg-surface p-3 transition-colors hover:border-border-strong/60"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                      <KeyRound size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-semibold">{p.name}</span>
                        <span className="rounded border border-border/70 px-1 text-[9.5px] text-muted">
                          {PROVIDER_KIND_LABELS[p.kind] ?? p.kind}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted">
                        <span className="font-mono">{p.apiKeyMasked || '无 Key'}</span>
                        <span>·</span>
                        <span className="font-mono">{p.defaultModel}</span>
                        <span>·</span>
                        <span>{p.models.length} 个模型</span>
                        {p.baseUrl && (
                          <>
                            <span className="hidden sm:inline">·</span>
                            <span className="hidden max-w-[180px] truncate font-mono sm:inline">
                              {p.baseUrl}
                            </span>
                          </>
                        )}
                      </div>
                      {result && (
                        <div
                          className={cn(
                            'mt-1 flex items-center gap-1 text-[10.5px]',
                            result.ok ? 'text-success' : 'text-danger',
                          )}
                        >
                          {result.ok ? <Check size={11} /> : <TriangleAlert size={11} />}
                          {result.ok ? '测试通过' : result.error || '测试失败'}
                        </div>
                      )}
                    </div>
                    <div className="hidden shrink-0 items-center gap-1 sm:flex">
                      <button
                        onClick={() => void test(p)}
                        disabled={testingId === p.id}
                        className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[10.5px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
                      >
                        {testingId === p.id ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Wifi size={11} />
                        )}
                        测试
                      </button>
                      <button
                        onClick={() => startEdit(p)}
                        aria-label={`编辑 ${p.name}`}
                        className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={() => void remove(p)}
                        aria-label={`删除 ${p.name}`}
                        className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger-soft hover:text-danger"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-end gap-1.5 border-t border-border/60 pt-2 sm:hidden">
                    <button
                      onClick={() => void test(p)}
                      disabled={testingId === p.id}
                      className="mr-auto flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
                    >
                      {testingId === p.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Wifi size={12} />
                      )}
                      测试连接
                    </button>
                    <button
                      onClick={() => startEdit(p)}
                      className="flex min-h-10 items-center gap-1 rounded-lg border border-border px-2.5 text-[11px] text-text-soft transition-colors hover:bg-surface-2 hover:text-text"
                    >
                      <Pencil size={12} /> 编辑
                    </button>
                    <button
                      onClick={() => void remove(p)}
                      aria-label={`删除 ${p.name}`}
                      className="flex min-h-10 items-center gap-1 rounded-lg border border-danger/25 px-2.5 text-[11px] text-danger transition-colors hover:bg-danger-soft"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {profiles.length > 0 && (
            <p className="mt-3 text-[10.5px] leading-4 text-muted">
              提示：切换账号/模型只会影响后续回合；当前回合会继续使用原来的模型。
            </p>
          )}
        </div>
      )}
    </div>
  )
}
