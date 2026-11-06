import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wifi,
  X,
} from 'lucide-react'
import type { ModelInfo, Profile, ProfileInput, ProviderKind } from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { PROVIDER_PRESETS, presetForProfile, type ProviderPreset } from '../../lib/presets'
import { PROVIDER_KIND_LABELS } from '../../lib/types'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-bg px-2.5 text-[12.5px] text-text outline-none transition-colors focus:border-border-strong'
const labelCls = 'mb-1.5 block text-[11px] font-medium text-text-soft'

type Step = 1 | 2 | 3

interface FormState {
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
}

function emptyForm(): FormState {
  return { name: '', kind: 'openai-compatible', baseUrl: '', apiKey: '' }
}

function initialOf(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  return /[a-zA-Z]/.test(trimmed[0]) ? trimmed[0].toUpperCase() : trimmed[0]
}

function ProviderLogo({ preset, size = 34 }: { preset?: ProviderPreset; size?: number }) {
  const color = preset?.color ?? 'var(--t-accent)'
  const label = preset ? initialOf(preset.name) : '自'
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg font-semibold text-white"
      style={{ background: color, width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {label}
    </span>
  )
}

function Steps({ step }: { step: Step }) {
  const items = ['服务商', '密钥', '模型']
  return (
    <div className="mb-4 flex items-center gap-1">
      {items.map((label, i) => {
        const n = (i + 1) as Step
        return (
          <div key={label} className="flex items-center gap-1">
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] transition-colors',
                n === step
                  ? 'bg-accent-soft font-medium text-accent'
                  : n < step
                    ? 'text-text-soft'
                    : 'text-muted',
              )}
            >
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-full text-[9px]',
                  n === step
                    ? 'bg-accent text-on-accent'
                    : n < step
                      ? 'bg-[var(--t-bg-active)] text-text-soft'
                      : 'border border-border text-muted',
                )}
              >
                {n < step ? <Check size={9} /> : n}
              </span>
              {label}
            </span>
            {i < items.length - 1 && <span className="h-px w-4 bg-[var(--t-border)]" />}
          </div>
        )
      })}
    </div>
  )
}

export function ProfilesSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const toast = useUiStore((s) => s.toast)

  const [hostId, setHostId] = useState<string | null>(activeHostId ?? hosts[0]?.id ?? null)
  const [editing, setEditing] = useState<'new' | string | null>(null)
  const [step, setStep] = useState<Step>(1)
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [available, setAvailable] = useState<ModelInfo[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [modelQuery, setModelQuery] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [manualMode, setManualMode] = useState(false)
  const [manualInput, setManualInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string }>>({})
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null)
  const lastAutoFetch = useRef('')
  const fetchInFlight = useRef(false)

  const host = hosts.find((h) => h.id === hostId) ?? null
  const runtime = hostId ? runtimes[hostId] : undefined
  const profiles = runtime?.profiles ?? []
  const loading = runtime?.profilesLoading ?? false
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

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase()
    if (!q) return available
    return available.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.displayName ?? '').toLowerCase().includes(q),
    )
  }, [available, modelQuery])

  const reset = () => {
    setEditing(null)
    setStep(1)
    setPreset(null)
    setForm(emptyForm())
    setAvailable([])
    setSelected([])
    setDefaultModel('')
    setModelQuery('')
    setFetchError(null)
    setManualMode(false)
    setManualInput('')
    setError(null)
    setShowKey(false)
    setShowAdvanced(false)
    lastAutoFetch.current = ''
  }

  const startNew = () => {
    reset()
    setEditing('new')
    setStep(1)
  }

  const startEdit = (p: Profile) => {
    reset()
    setEditing(p.id)
    setStep(2)
    const brand = presetForProfile(p)
    setPreset(brand ?? null)
    setForm({
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl ?? brand?.baseUrl ?? '',
      apiKey: '',
    })
    setAvailable(p.models.map((id) => ({ id })))
    setSelected(p.models)
    setDefaultModel(p.defaultModel || p.models[0] || '')
    setShowAdvanced(!!p.baseUrl && p.baseUrl !== brand?.baseUrl)
  }

  const choosePreset = (p: ProviderPreset | null) => {
    setPreset(p)
    setStep(2)
    setFetchError(null)
    setError(null)
    setForm({
      name: p?.name ?? '',
      kind: p?.kind ?? 'openai-compatible',
      baseUrl: p?.baseUrl ?? '',
      apiKey: '',
    })
    setAvailable((p?.models ?? []).map((id) => ({ id })))
    setSelected(p?.models ?? [])
    setDefaultModel(p?.defaultModel ?? p?.models[0] ?? '')
    setManualMode(false)
  }

  const applyFetched = (list: ModelInfo[], keepProfileModels: boolean) => {
    const sorted = list
      .slice()
      .sort((a, b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id, 'zh-Hans-CN'))
    if (sorted.length === 0) {
      setFetchError('服务商没有返回可用模型。可以手动输入模型 ID。')
      setManualMode(true)
      return
    }
    const ids = new Set(sorted.map((m) => m.id))
    const existing = keepProfileModels ? selected.filter((id) => ids.has(id)) : []
    const recommended = (preset?.models ?? []).filter((id) => ids.has(id))
    const initial = existing.length
      ? existing
      : recommended.length
        ? recommended
        : list.slice(0, 3).map((m) => m.id)
    setAvailable(sorted)
    setSelected(initial)
    setDefaultModel((prev) =>
      initial.includes(prev) ? prev : initial.includes(preset?.defaultModel ?? '') ? preset!.defaultModel : initial[0] ?? '',
    )
  }

  const fetchModels = async (useProfileId: boolean) => {
    if (!host || fetching || fetchInFlight.current) return
    const apiKey = form.apiKey.trim()
    const canUseProfile = useProfileId && !!editingProfile
    if (!canUseProfile && !apiKey) {
      setStep(3)
      setFetchError('需要先填写 API Key 才能获取模型列表。')
      setManualMode(true)
      return
    }
    setStep(3)
    setFetching(true)
    fetchInFlight.current = true
    setFetchError(null)
    setManualMode(false)
    try {
      const res = await api.listModels(host, {
        kind: form.kind,
        baseUrl: form.baseUrl.trim() || undefined,
        ...(canUseProfile ? { profileId: editingProfile!.id } : { apiKey }),
      })
      if (!res.ok) throw new Error(res.error || '无法获取模型列表')
      applyFetched(res.models ?? [], canUseProfile)
    } catch (err) {
      setFetchError(
        err instanceof Error && err.message
          ? err.message
          : '无法获取模型列表，请检查 Key、Base URL 与网络。',
      )
      setManualMode(available.length === 0)
    } finally {
      fetchInFlight.current = false
      setFetching(false)
    }
  }

  const maybeAutoFetch = () => {
    if (!form.apiKey.trim() || editing) return
    const sig = `${form.kind}:${form.baseUrl}:${form.apiKey.trim().slice(-6)}`
    if (lastAutoFetch.current === sig || fetching) return
    lastAutoFetch.current = sig
    void fetchModels(false)
  }

  const toggleModel = (id: string) => {
    setSelected((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      setDefaultModel((d) => (next.includes(d) ? d : next[0] ?? ''))
      return next
    })
  }

  const addManualModel = () => {
    const id = manualInput.trim()
    if (!id) return
    if (!available.some((m) => m.id === id)) setAvailable((prev) => [...prev, { id }])
    setSelected((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setDefaultModel((d) => d || id)
    setManualInput('')
  }

  const save = async () => {
    if (!host) return
    const name = form.name.trim()
    const modelList = selected.filter((id) => id.trim())
    if (!name) {
      setError('请填写账号名称')
      setStep(2)
      return
    }
    if (editing === 'new' && !form.apiKey.trim()) {
      setError('请填写 API Key')
      setStep(2)
      return
    }
    if (modelList.length === 0) {
      setError('至少选择一个模型')
      setStep(3)
      return
    }
    const def = modelList.includes(defaultModel) ? defaultModel : modelList[0]
    const input: ProfileInput = {
      name,
      kind: form.kind,
      baseUrl: form.baseUrl.trim() || undefined,
      apiKey: form.apiKey.trim() || undefined,
      models: modelList,
      defaultModel: def,
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
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (p: Profile) => {
    if (!host) return
    try {
      await api.deleteProfile(host, p.id)
      await refreshProfiles(host.id)
      if (editing === p.id) reset()
      setDeleteTarget(null)
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

  const selectedModels = available.filter((m) => selected.includes(m.id))

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">账号与模型</h3>
        <span className="hidden text-[11px] text-muted sm:inline">
          Key 保存在 Host 端，不会下发明文
        </span>
        <span className="flex-1" />
        {hosts.length > 1 && (
          <select
            value={hostId ?? ''}
            onChange={(e) => {
              setHostId(e.target.value)
              reset()
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
          className="flex size-11 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:opacity-50 sm:size-8"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
        {!editing && (
          <button
            onClick={startNew}
            className="flex min-h-11 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover sm:min-h-8"
          >
            <Plus size={13} /> 新建账号
          </button>
        )}
      </div>

      {runtime?.authError && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft/50 px-3 py-2 text-[11.5px] text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {runtime.authError}
        </div>
      )}

      {editing ? (
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="mb-3 flex items-center gap-2">
            <button
              onClick={() => (step === 1 ? reset() : setStep((s) => (s === 3 ? 2 : 1)))}
              className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
              aria-label="返回"
            >
              <ArrowLeft size={15} />
            </button>
            <div className="min-w-0 flex-1">
              <h4 className="text-[13px] font-semibold">
                {editing === 'new' ? '新建账号' : `编辑「${editingProfile?.name ?? '账号'}」`}
              </h4>
              <p className="text-[10.5px] text-muted">
                {editing === 'new' ? '三步完成，模型自动获取' : '修改后会立即保存到 Host'}
              </p>
            </div>
            <button
              onClick={reset}
              className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </div>

          <Steps step={step} />

          {step === 1 && (
            <div>
              <p className="mb-2.5 text-[11.5px] text-muted">选择服务商，预设会自动填好接口地址和推荐模型。</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PROVIDER_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => choosePreset(p)}
                    className="group flex items-center gap-2.5 rounded-xl border border-border bg-bg/40 p-2.5 text-left transition-colors duration-100 hover:border-border-strong hover:bg-[var(--t-bg-hover)]"
                  >
                    <ProviderLogo preset={p} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium">{p.name}</span>
                      <span className="block truncate text-[10px] text-muted">
                        {PROVIDER_KIND_LABELS[p.kind] ?? p.kind}
                      </span>
                    </span>
                  </button>
                ))}
                <button
                  onClick={() => choosePreset(null)}
                  className="flex items-center gap-2.5 rounded-xl border border-dashed border-border bg-transparent p-2.5 text-left transition-colors duration-100 hover:border-border-strong hover:bg-[var(--t-bg-hover)]"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted">
                    <Plus size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium">自定义</span>
                    <span className="block truncate text-[10px] text-muted">OpenAI 兼容接口</span>
                  </span>
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="mb-3 flex items-center gap-2.5 rounded-xl bg-[var(--t-bg)] px-3 py-2">
                <ProviderLogo preset={preset ?? undefined} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">
                    {preset?.name ?? '自定义接口'}
                  </span>
                  <span className="block truncate text-[10px] text-muted">
                    {PROVIDER_KIND_LABELS[form.kind] ?? form.kind}
                  </span>
                </span>
                <button
                  onClick={() => setStep(1)}
                  className="text-[10.5px] text-muted underline-offset-2 hover:text-text hover:underline"
                >
                  更换
                </button>
              </div>

              <div className="space-y-3">
                <div>
                  <label className={labelCls}>账号名称</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="例如：公司 Anthropic"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>API Key</label>
                  <div className="relative">
                    <input
                      value={form.apiKey}
                      onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                      onBlur={maybeAutoFetch}
                      type={showKey ? 'text' : 'password'}
                      placeholder={
                        editingProfile
                          ? `已保存：${editingProfile.apiKeyMasked ?? '••••'}（留空不修改）`
                          : 'sk-…'
                      }
                      spellCheck={false}
                      autoComplete="off"
                      className={cn(inputCls, 'pr-9 font-mono text-[11.5px]')}
                    />
                    <button
                      onClick={() => setShowKey((v) => !v)}
                      aria-label={showKey ? '隐藏 Key' : '显示 Key'}
                      className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-[var(--t-bg-hover)] hover:text-text"
                    >
                      {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-muted">
                    {editingProfile
                      ? '留空保留原 Key；失焦后会用已保存的 Key 获取模型。'
                      : '失焦或点击「获取模型」时自动拉取可用模型。'}
                  </p>
                </div>

                <div>
                  <button
                    onClick={() => setShowAdvanced((v) => !v)}
                    className="flex items-center gap-1 text-[10.5px] text-muted transition-colors hover:text-text"
                  >
                    <ChevronDown
                      size={11}
                      className={cn('transition-transform duration-150', showAdvanced && 'rotate-180')}
                    />
                    高级设置（接口类型与 Base URL）
                  </button>
                  {showAdvanced && (
                    <div className="mt-2 grid gap-2 rounded-lg border border-border bg-bg/40 p-2.5 sm:grid-cols-2">
                      <div>
                        <label className={labelCls}>接口类型</label>
                        <select
                          value={form.kind}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, kind: e.target.value as ProviderKind }))
                          }
                          className={inputCls}
                        >
                          {Object.entries(PROVIDER_KIND_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className={labelCls}>Base URL</label>
                        <input
                          value={form.baseUrl}
                          onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                          onBlur={() => {
                            if (form.apiKey.trim()) maybeAutoFetch()
                          }}
                          placeholder="https://api.example.com/v1"
                          spellCheck={false}
                          className={cn(inputCls, 'font-mono text-[11px]')}
                        />
                      </div>
                    </div>
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
                  <button
                    onClick={() => void fetchModels(true)}
                    disabled={fetching}
                    className="flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:opacity-60"
                  >
                    {fetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                    刷新模型列表
                  </button>
                )}
                <span className="flex-1" />
                <button
                  onClick={() => void fetchModels(!!editingProfile)}
                  disabled={fetching}
                  className="flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:opacity-60"
                >
                  <Sparkles size={13} /> 获取模型
                </button>
                <button
                  onClick={() => setStep(3)}
                  className="flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
                >
                  下一步 <ArrowRight size={13} />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <div className="mb-3 flex items-center gap-2">
                <ProviderLogo preset={preset ?? undefined} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium">{form.name || preset?.name || '选择模型'}</div>
                  <div className="text-[10px] text-muted">
                    {available.length > 0 ? `${available.length} 个可用模型` : '等待获取模型列表'}
                  </div>
                </div>
                <button
                  onClick={() => void fetchModels(!!editingProfile)}
                  disabled={fetching}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[10.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
                >
                  <RefreshCw size={11} className={fetching ? 'animate-spin' : ''} />
                  {editingProfile ? '刷新模型列表' : '重新获取'}
                </button>
              </div>

              {fetching ? (
                <div className="space-y-1.5">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
                      <div className="skeleton size-4 rounded" />
                      <div className="skeleton h-3 flex-1" style={{ maxWidth: `${70 - i * 6}%` }} />
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  {fetchError && (
                    <div className="mb-2 rounded-xl border border-danger/25 bg-danger-soft/50 p-3">
                      <div className="flex items-start gap-2 text-[11.5px] leading-5 text-danger">
                        <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                        <span className="min-w-0 flex-1">无法获取模型列表：{fetchError}</span>
                      </div>
                      <div className="mt-2 flex gap-1.5">
                        <button
                          onClick={() => void fetchModels(!!editingProfile)}
                          className="h-7 rounded-md border border-danger/30 px-2 text-[10.5px] text-danger transition-colors hover:bg-danger/10"
                        >
                          重试
                        </button>
                        <button
                          onClick={() => setManualMode(true)}
                          className="h-7 rounded-md border border-border px-2 text-[10.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)]"
                        >
                          手动输入模型
                        </button>
                      </div>
                    </div>
                  )}

                  {available.length > 0 && !manualMode && (
                    <>
                      <div className="relative mb-2">
                        <Search
                          size={12}
                          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
                        />
                        <input
                          value={modelQuery}
                          onChange={(e) => setModelQuery(e.target.value)}
                          placeholder="搜索模型"
                          className="h-8 w-full rounded-lg border border-border bg-bg pl-7 pr-2 text-[11.5px] outline-none focus:border-border-strong"
                        />
                      </div>
                      <div className="max-h-[230px] overflow-y-auto rounded-lg border border-border bg-bg/30 p-1">
                        {filteredModels.map((m) => {
                          const checked = selected.includes(m.id)
                          return (
                            <label
                              key={m.id}
                              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--t-bg-hover)]"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleModel(m.id)}
                                className="sr-only"
                              />
                              <span
                                className={cn(
                                  'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                                  checked
                                    ? 'border-accent bg-accent text-on-accent'
                                    : 'border-border-strong bg-surface',
                                )}
                              >
                                {checked && <Check size={10} strokeWidth={3} />}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[11.5px] text-text">
                                  {m.displayName || m.id}
                                </span>
                                {m.displayName && (
                                  <span className="block truncate font-mono text-[9.5px] text-muted">
                                    {m.id}
                                  </span>
                                )}
                              </span>
                              {checked && defaultModel === m.id && (
                                <span className="shrink-0 rounded bg-accent-soft px-1.5 py-px text-[9px] text-accent">
                                  默认
                                </span>
                              )}
                            </label>
                          )
                        })}
                        {filteredModels.length === 0 && (
                          <p className="px-2 py-4 text-center text-[11px] text-muted">没有匹配的模型</p>
                        )}
                      </div>
                    </>
                  )}

                  {(manualMode || available.length === 0) && (
                    <div className="rounded-lg border border-dashed border-border bg-bg/30 p-3">
                      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-text-soft">
                        <KeyRound size={12} className="text-muted" /> 手动输入模型
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          value={manualInput}
                          onChange={(e) => setManualInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              addManualModel()
                            }
                          }}
                          placeholder="例如 claude-sonnet-4-5"
                          spellCheck={false}
                          className={cn(inputCls, 'h-8 font-mono text-[11px]')}
                        />
                        <button
                          onClick={addManualModel}
                          disabled={!manualInput.trim()}
                          className="h-8 shrink-0 rounded-lg border border-border px-2.5 text-[11px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
                        >
                          添加
                        </button>
                      </div>
                      {selectedModels.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {selectedModels.map((m) => (
                            <span
                              key={m.id}
                              className="flex items-center gap-1 rounded-md bg-[var(--t-bg-active)] px-1.5 py-0.5 font-mono text-[10px] text-text-soft"
                            >
                              {m.id}
                              <button
                                onClick={() => toggleModel(m.id)}
                                aria-label={`移除 ${m.id}`}
                                className="text-muted hover:text-danger"
                              >
                                <X size={9} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      {!manualMode && available.length > 0 && (
                        <button
                          onClick={() => setManualMode(true)}
                          className="mt-2 text-[10.5px] text-accent hover:underline"
                        >
                          也可以手动添加模型
                        </button>
                      )}
                    </div>
                  )}

                  {selected.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--t-bg)] px-2.5 py-2">
                      <span className="text-[11px] text-muted">已选 {selected.length} 个</span>
                      <span className="flex-1" />
                      <label className="text-[11px] text-muted">默认</label>
                      <select
                        value={defaultModel}
                        onChange={(e) => setDefaultModel(e.target.value)}
                        className="h-7 max-w-[220px] rounded-md border border-border bg-surface px-1.5 font-mono text-[10.5px] outline-none focus:border-border-strong"
                      >
                        {selected.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </>
              )}

              {error && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft/50 px-3 py-2 text-[11.5px] text-danger">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                  {error}
                </div>
              )}

              <div className="mt-4 flex items-center gap-2">
                <button
                  onClick={() => setStep(2)}
                  className="flex min-h-9 items-center gap-1 rounded-lg px-2 text-[11.5px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
                >
                  <ArrowLeft size={12} /> 上一步
                </button>
                <span className="flex-1" />
                {editingProfile && (
                  <button
                    onClick={() => setDeleteTarget(editingProfile)}
                    className="flex min-h-9 items-center gap-1.5 rounded-lg border border-danger/25 px-3 text-[12px] text-danger transition-colors hover:bg-danger-soft/50"
                  >
                    <Trash2 size={12} /> 删除
                  </button>
                )}
                <button
                  onClick={() => void save()}
                  disabled={saving || fetching}
                  className="flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-60"
                >
                  {saving && <Loader2 size={13} className="animate-spin" />}
                  保存账号
                </button>
              </div>
            </div>
          )}
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
            <div className="rounded-xl border border-dashed border-border bg-bg/30 px-4 py-9 text-center">
              <span className="mx-auto flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <KeyRound size={19} />
              </span>
              <p className="mt-3 text-[12.5px] font-medium text-text-soft">还没有配置账号</p>
              <p className="mx-auto mt-1 max-w-[280px] text-[11.5px] leading-5 text-muted">
                选择服务商、粘贴 Key，模型列表会自动获取。支持 Anthropic、OpenAI、DeepSeek、Ollama 等。
              </p>
              <button
                onClick={startNew}
                className="mt-3.5 inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-hover"
              >
                <Plus size={13} /> 新建账号
              </button>
            </div>
          )}

          <div className="space-y-2">
            {profiles.map((p) => {
              const result = testResults[p.id]
              const brand = presetForProfile(p)
              return (
                <div
                  key={p.id}
                  className="rounded-xl border border-border bg-surface p-3 transition-colors hover:border-border-strong/60"
                >
                  <div className="flex items-start gap-2.5">
                    {brand ? (
                      <ProviderLogo preset={brand} size={32} />
                    ) : (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--t-bg-active)] text-[12px] font-semibold text-text-soft">
                        {initialOf(p.name)}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-semibold">{p.name}</span>
                        <span className="rounded border border-border px-1 text-[9.5px] text-muted">
                          {PROVIDER_KIND_LABELS[p.kind] ?? p.kind}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted">
                        <span className="font-mono">{p.apiKeyMasked || '无 Key'}</span>
                        <span>·</span>
                        <span className="max-w-[180px] truncate font-mono">{p.defaultModel}</span>
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
                        className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[10.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:opacity-50"
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
                        className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(p)}
                        aria-label={`删除 ${p.name}`}
                        className="flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger-soft hover:text-danger"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-end gap-1.5 border-t border-border pt-2 sm:hidden">
                    <button
                      onClick={() => void test(p)}
                      disabled={testingId === p.id}
                      className="mr-auto flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
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
                      className="flex min-h-10 items-center gap-1 rounded-lg border border-border px-2.5 text-[11px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)]"
                    >
                      <Pencil size={12} /> 编辑
                    </button>
                    <button
                      onClick={() => setDeleteTarget(p)}
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

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="删除账号"
        className="max-w-md"
        footer={
          <>
            <button
              onClick={() => setDeleteTarget(null)}
              className="min-h-9 rounded-lg border border-border bg-surface px-3.5 text-[12.5px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)]"
            >
              取消
            </button>
            <button
              onClick={() => deleteTarget && void remove(deleteTarget)}
              className="min-h-9 rounded-lg bg-danger px-3.5 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90"
            >
              删除
            </button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          删除账号「{deleteTarget?.name}」？使用它的会话需要重新选择账号。
        </p>
      </Modal>
    </div>
  )
}
