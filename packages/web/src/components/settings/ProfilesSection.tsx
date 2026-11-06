import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
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
import type {
  ModelInfo,
  Profile,
  ProfileGroupInput,
  ProfileInput,
  ProviderKind,
} from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { PROVIDER_PRESETS, presetForProfile, type ProviderPreset } from '../../lib/presets'
import { PROVIDER_KIND_LABELS, type HostConfig } from '../../lib/types'
import { cn } from '../../lib/cn'
import { Modal } from '../ui/Modal'
import { Button, IconButton } from '../ui/Button'
import { MenuSelect } from '../ui/Menu'

const inputCls =
  'h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] text-text outline-none transition-colors placeholder:text-muted focus:border-border-strong'
const labelCls = 'settings-label'

/** 分组协议下拉的简短名称（与用户熟悉的叫法一致）。 */
const GROUP_KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI 兼容',
  gemini: 'Gemini',
}

type Step = 1 | 2 | 3

type PriceMap = Record<string, { input: number; output: number }>

function PriceOverrides({
  models,
  price,
  onChange,
}: {
  models: string[]
  price: PriceMap
  onChange: (next: PriceMap) => void
}) {
  const [model, setModel] = useState('')
  const candidates = models.filter((id) => !price[id])
  const add = () => {
    const id = model.trim()
    if (!id) return
    onChange({ ...price, [id]: { input: 3, output: 15 } })
    setModel('')
  }
  const update = (id: string, key: 'input' | 'output', value: string) => {
    const n = Number(value)
    onChange({ ...price, [id]: { ...price[id], [key]: Number.isFinite(n) && n >= 0 ? n : 0 } })
  }
  return (
    <div className="mt-3 rounded-lg border border-border bg-bg/40 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[13px] font-medium text-text-soft">自定义单价</span>
        <span className="text-[13px] text-muted">每百万 token 美元，覆盖内置参考价</span>
      </div>
      {Object.keys(price).length > 0 && (
        <div className="mt-1.5 space-y-1">
          {Object.entries(price).map(([id, value]) => (
            <div key={id} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-soft" title={id}>
                {id}
              </span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={value.input}
                onChange={(e) => update(id, 'input', e.target.value)}
                aria-label={`${id} 输入单价`}
                className="h-6 w-14 rounded border border-border bg-surface px-1 text-right font-mono text-[13px] outline-none focus:border-border-strong"
              />
              <span className="text-[13px] text-muted">in</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={value.output}
                onChange={(e) => update(id, 'output', e.target.value)}
                aria-label={`${id} 输出单价`}
                className="h-6 w-14 rounded border border-border bg-surface px-1 text-right font-mono text-[13px] outline-none focus:border-border-strong"
              />
              <span className="text-[13px] text-muted">out</span>
              <button
                onClick={() => {
                  const next = { ...price }
                  delete next[id]
                  onChange(next)
                }}
                aria-label={`删除 ${id} 单价`}
                className="flex size-5 items-center justify-center rounded text-muted hover:text-danger"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          list="tandem-price-models"
          placeholder={candidates[0] ?? '模型 ID'}
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded border border-border bg-surface px-1.5 font-mono text-[13px] text-text outline-none focus:border-border-strong"
        />
        <datalist id="tandem-price-models">
          {candidates.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <button
          onClick={add}
          disabled={!model.trim()}
          className="h-6 shrink-0 rounded border border-border px-1.5 text-[13px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-40"
        >
          添加
        </button>
      </div>
    </div>
  )
}

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
                'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px] transition-colors',
                n === step
                  ? 'bg-[var(--t-bg-active)] font-medium text-text'
                  : n < step
                    ? 'text-text-soft'
                    : 'text-muted',
              )}
            >
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-full text-[11px]',
                  n === step
                    ? 'bg-[var(--t-text)] text-[var(--t-bg)]'
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

interface GroupDraft {
  id?: string
  name: string
  kind: ProviderKind
  apiKey: string
  apiKeyMasked?: string
  /** 老账号无分组时按账号字段合成的隐式分组，Key 留在账号上 */
  inheritedKey?: boolean
  baseUrl: string
  models: string[]
  defaultModel: string
}

function emptyGroupDraft(kind: ProviderKind = 'openai-compatible'): GroupDraft {
  return { name: '', kind, apiKey: '', baseUrl: '', models: [], defaultModel: '' }
}

function defaultGroupDraft(kind: ProviderKind, models: string[] = [], defaultModel = ''): GroupDraft {
  return {
    name: '默认',
    kind,
    apiKey: '',
    baseUrl: '',
    models,
    defaultModel: defaultModel || models[0] || '',
  }
}

/** 与服务端一致：分组协议与账号不同且未填 URL 时，去掉账号完整端点并补该协议常见版本段。 */
function inferGroupBaseUrl(baseUrl: string | undefined, kind: ProviderKind): string | undefined {
  const value = baseUrl?.trim()
  if (!value) return undefined
  let base = value.replace(/\/+$/, '')
  base = base
    .replace(/\/(?:v1\/)?messages$/i, '')
    .replace(/\/(?:v1\/)?chat\/completions$/i, '')
    .replace(/\/models$/i, '')
  if (!base) return undefined
  if (kind === 'anthropic') return base
  try {
    const pathname = new URL(base).pathname.replace(/\/+$/, '')
    if (!pathname || pathname === '/') {
      return `${base}/${kind === 'gemini' ? 'v1beta/openai' : 'v1'}`
    }
    if (kind === 'gemini' && pathname === '/v1beta') return `${base}/openai`
  } catch {
    /* 交给服务端报错 */
  }
  return base
}

/** 分组协议对应的 Base URL 提示（完整端点原样使用，否则由 provider 拼接路径）。 */
function groupBaseUrlPlaceholder(kind: ProviderKind): string {
  switch (kind) {
    case 'anthropic':
      return 'https://api.anthropic.com（自动拼接 /v1/messages）'
    case 'openai':
      return 'https://api.openai.com/v1（自动拼接 /chat/completions）'
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta/openai'
    default:
      return 'https://api.example.com/v1'
  }
}

function GroupEditor({
  host,
  kind: profileKind,
  profileId,
  profileBaseUrl,
  existing,
  onSave,
  onCancel,
}: {
  host: HostConfig
  /** 账号协议，分组未选协议时继承 */
  kind: ProviderKind
  profileId?: string
  profileBaseUrl?: string
  existing?: GroupDraft
  onSave: (draft: GroupDraft) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [kind, setKind] = useState<ProviderKind>(existing?.kind ?? profileKind)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '')
  const [showKey, setShowKey] = useState(false)
  const [available, setAvailable] = useState<ModelInfo[]>(
    () => (existing?.models ?? []).map((id) => ({ id })),
  )
  const [selected, setSelected] = useState<string[]>(existing?.models ?? [])
  const [defaultModel, setDefaultModel] = useState(
    existing?.defaultModel ?? existing?.models[0] ?? '',
  )
  const [query, setQuery] = useState('')
  const [manualInput, setManualInput] = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return available
    return available.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.displayName ?? '').toLowerCase().includes(q),
    )
  }, [available, query])

  const toggleModel = (id: string) => {
    setSelected((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      setDefaultModel((d) => (next.includes(d) ? d : next[0] ?? ''))
      return next
    })
  }

  const fetchModels = async () => {
    if (fetching) return
    const typed = apiKey.trim()
    const canUseStoredKey = !typed && !!profileId && (!!existing?.id || !!existing?.inheritedKey)
    if (!typed && !canUseStoredKey) {
      setFetchError('先填写这个分组的 Key，再获取模型。')
      return
    }
    setFetching(true)
    setFetchError(null)
    try {
      const targetBase =
        baseUrl.trim() ||
        (kind !== profileKind
          ? inferGroupBaseUrl(profileBaseUrl, kind)
          : profileBaseUrl) ||
        undefined
      const res = await api.listModels(host, {
        kind,
        baseUrl: targetBase,
        ...(typed
          ? { apiKey: typed }
          : {
              profileId: profileId!,
              ...(existing?.id ? { groupId: existing.id } : {}),
            }),
      })
      if (!res.ok) throw new Error(res.error || '无法获取模型列表')
      const sorted = (res.models ?? [])
        .slice()
        .sort((a, b) => (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id, 'zh-Hans-CN'))
      if (sorted.length === 0) {
        setFetchError('服务商没有返回可用模型，可以手动输入模型 ID。')
        return
      }
      const ids = new Set(sorted.map((m) => m.id))
      const kept = selected.filter((id) => ids.has(id))
      const initial = kept.length ? kept : sorted.slice(0, 3).map((m) => m.id)
      setAvailable(sorted)
      setSelected(initial)
      setDefaultModel((prev) => (initial.includes(prev) ? prev : initial[0] ?? ''))
    } catch (err) {
      setFetchError(
        err instanceof Error && err.message ? err.message : '无法获取模型列表，请检查 Key 与 Base URL。',
      )
    } finally {
      setFetching(false)
    }
  }

  const addManual = () => {
    const id = manualInput.trim()
    if (!id) return
    if (!available.some((m) => m.id === id)) setAvailable((prev) => [...prev, { id }])
    setSelected((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setDefaultModel((d) => d || id)
    setManualInput('')
  }

  const save = () => {
    if (!name.trim()) {
      setError('请填写分组名称')
      return
    }
    if (!existing?.id && !existing?.inheritedKey && !apiKey.trim()) {
      setError('新分组需要填写 Key')
      return
    }
    if (selected.length === 0) {
      setError('至少选择一个模型')
      return
    }
    onSave({
      id: existing?.id,
      name: name.trim(),
      kind,
      apiKey: apiKey.trim(),
      apiKeyMasked: existing?.apiKeyMasked,
      inheritedKey: existing?.inheritedKey,
      baseUrl: baseUrl.trim(),
      models: selected,
      defaultModel: selected.includes(defaultModel) ? defaultModel : selected[0],
    })
  }

  return (
    <div className="rounded-xl border border-border-strong/60 bg-bg/40 p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Layers size={13} className="text-text-soft" />
        <span className="text-[13px] font-medium">
          {existing ? `编辑分组「${existing.name}」` : '添加分组'}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className={labelCls}>分组名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：官方渠道 / 低价渠道"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>协议类型</label>
          <MenuSelect
            value={kind}
            onChange={(next) => setKind(next as ProviderKind)}
            aria-label="分组协议类型"
            options={Object.entries(GROUP_KIND_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </div>
        <div>
          <label className={labelCls}>分组 Key</label>
          <div className="relative">
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type={showKey ? 'text' : 'password'}
              placeholder={
                existing
                  ? `已保存：${existing.apiKeyMasked ?? '••••'}（留空不修改）`
                  : 'sk-…'
              }
              spellCheck={false}
              autoComplete="off"
              className={cn(inputCls, 'pr-9 font-mono text-[13px]')}
            />
            <span className="absolute right-1 top-1/2 -translate-y-1/2">
              <IconButton
                size="sm"
                onClick={() => setShowKey((v) => !v)}
                label={showKey ? '隐藏 Key' : '显示 Key'}
                className="size-7 [&_svg]:size-[13px]"
              >
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </IconButton>
            </span>
          </div>
        </div>
      </div>
      <div className="mt-2">
        <label className={labelCls}>Base URL（可选，缺省沿用账号）</label>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={profileBaseUrl || groupBaseUrlPlaceholder(kind)}
          spellCheck={false}
          className={cn(inputCls, 'font-mono text-[13px]')}
        />
        <p className="mt-1 text-[13px] leading-4 text-muted">
          {kind === 'anthropic'
            ? 'Anthropic 协议会自动拼接 /v1/messages；填完整端点也可以。'
            : 'OpenAI 系协议会自动拼接 /chat/completions。'}
          {kind !== profileKind &&
            ' 分组协议与账号不同时，未填 URL 会按该协议从账号 URL 推断（去掉原协议端点并补版本路径）。'}
        </p>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button onClick={() => void fetchModels()} disabled={fetching}>
          {fetching ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          自动拉取模型
        </Button>
        {existing && (
          <span className="text-[13px] text-muted">留空 Key 时使用已保存的 Key</span>
        )}
      </div>
      {fetchError && (
        <p className="mt-1.5 flex items-start gap-1 text-[13px] leading-4 text-danger">
          <TriangleAlert size={11} className="mt-0.5 shrink-0" /> {fetchError}
        </p>
      )}

      {available.length > 0 && (
        <>
          <div className="relative mt-2">
            <Search
              size={11}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型"
              className="h-7 w-full rounded-md border border-border bg-bg pl-6 pr-2 text-[13px] outline-none focus:border-border-strong"
            />
          </div>
          <div className="mt-1.5 max-h-[150px] overflow-y-auto rounded-lg border border-border bg-bg/30 p-1">
            {filtered.map((m) => {
              const checked = selected.includes(m.id)
              return (
                <label
                  key={m.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--t-bg-hover)]"
                >
                  <input type="checkbox" checked={checked} onChange={() => toggleModel(m.id)} className="sr-only" />
                  <span
                    className={cn(
                      'flex size-3.5 shrink-0 items-center justify-center rounded border transition-colors',
                      checked
                        ? 'border-[var(--t-text)] bg-[var(--t-text)] text-[var(--t-bg)]'
                        : 'border-border-strong bg-surface',
                    )}
                  >
                    {checked && <Check size={9} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-soft">
                    {m.id}
                  </span>
                  {checked && m.id === defaultModel && (
                    <span className="shrink-0 rounded bg-[var(--t-bg-active)] px-1 text-[11px] text-text-secondary">默认</span>
                  )}
                </label>
              )
            })}
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-center text-[13px] text-muted">没有匹配的模型</p>
            )}
          </div>
        </>
      )}

      <div className="mt-1.5 flex gap-1.5">
        <input
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addManual()
            }
          }}
          placeholder="手动添加模型 ID"
          spellCheck={false}
          className={cn(inputCls, 'h-7 font-mono text-[13px]')}
        />
        <button
          onClick={addManual}
          disabled={!manualInput.trim()}
          className="h-7 shrink-0 rounded-md border border-border px-2 text-[13px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] disabled:opacity-50"
        >
          添加
        </button>
      </div>

      {selected.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[13px] text-muted">已选 {selected.length} 个</span>
          <span className="flex-1" />
          <span className="text-[13px] text-muted">默认</span>
          <MenuSelect
            value={defaultModel}
            onChange={setDefaultModel}
            aria-label="默认模型"
            size="sm"
            options={selected.map((id) => ({ value: id, label: id }))}
            wrapperClassName="w-auto max-w-[200px]"
            className="font-mono text-[13px]"
          />
        </div>
      )}

      {error && (
        <p className="mt-1.5 flex items-start gap-1 text-[13px] text-danger">
          <TriangleAlert size={11} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      <div className="mt-2.5 flex justify-end gap-1.5">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" onClick={save}>
          保存分组
        </Button>
      </div>
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
  const [groups, setGroups] = useState<GroupDraft[]>([])
  const [groupEditor, setGroupEditor] = useState<{ index: number | 'new' } | null>(null)
  const [price, setPrice] = useState<PriceMap>({})
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
    setGroups([])
    setGroupEditor(null)
    setPrice({})
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
    setPrice(p.price ? { ...p.price } : {})
    setGroups(
      p.groups?.length
        ? p.groups.map((g) => ({
            id: g.id,
            name: g.name,
            kind: g.kind ?? p.kind,
            apiKey: '',
            apiKeyMasked: g.apiKeyMasked,
            baseUrl: g.baseUrl ?? '',
            models: g.models,
            defaultModel: g.defaultModel || g.models[0] || '',
          }))
        : [
            // 老账号没有分组：展示为一个隐式分组，保存时迁移为显式分组
            {
              name: '默认',
              kind: p.kind,
              apiKey: '',
              apiKeyMasked: p.apiKeyMasked,
              inheritedKey: true,
              baseUrl: '',
              models: p.models.length ? p.models : [p.defaultModel].filter(Boolean),
              defaultModel: p.defaultModel || p.models[0] || '',
            },
          ],
    )
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
    const models = p?.models ?? []
    setGroups([
      defaultGroupDraft(
        p?.kind ?? 'openai-compatible',
        models,
        p?.defaultModel ?? models[0] ?? '',
      ),
    ])
    setGroupEditor(null)
    setPrice({})
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
    if (!name) {
      setError('请填写账号名称')
      setStep(2)
      return
    }
    if (groups.length === 0) {
      setError('至少保留一个分组')
      setStep(2)
      return
    }
    for (const group of groups) {
      if (!group.name.trim()) {
        setError('分组名称不能为空')
        setStep(2)
        return
      }
      if (!group.id && !group.inheritedKey && !group.apiKey.trim()) {
        setError(`分组「${group.name}」需要填写 Key`)
        setStep(2)
        return
      }
      if (group.models.length === 0) {
        setError(`分组「${group.name}」至少选择一个模型`)
        setStep(2)
        return
      }
    }
    const primary = groups[0]
    const models = [...new Set(groups.flatMap((g) => g.models))]
    const def =
      primary.defaultModel ||
      primary.models.find((id) => id === primary.defaultModel) ||
      primary.models[0] ||
      models[0]
    const groupInputs: ProfileGroupInput[] = groups.map((g) => ({
      ...(g.id ? { id: g.id } : {}),
      name: g.name,
      kind: g.kind,
      ...(g.apiKey.trim() ? { apiKey: g.apiKey.trim() } : {}),
      ...(g.baseUrl.trim() ? { baseUrl: g.baseUrl.trim() } : {}),
      models: g.models,
      defaultModel: g.defaultModel || g.models[0] || '',
    }))
    const input: ProfileInput = {
      name,
      // 账号协议取首个分组，实际会话运行按各组 kind 覆盖
      kind: primary.kind,
      baseUrl: form.baseUrl.trim() || undefined,
      apiKey: form.apiKey.trim() || undefined,
      models,
      defaultModel: def,
      ...(Object.keys(price).length ? { price } : {}),
      groups: groupInputs,
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
      // 有分组时用首个分组的协议/Key 测试；账号自身可能没有 Key
      const res = await api.testProfile(host, p.id, p.groups?.[0]?.id)
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
      <div className="settings-empty">
        <span className="settings-empty-icon"><KeyRound size={17} /></span>
        <p className="settings-empty-title">还没有连接 Host</p>
        <p className="settings-empty-hint">先添加一台 Host，再配置账号与模型。</p>
      </div>
    )
  }

  const selectedModels = available.filter((m) => selected.includes(m.id))

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">账号与模型</h3>
        <span className="hidden text-[13px] text-muted sm:inline">
          Key 保存在 Host 端，不会下发明文
        </span>
        <span className="flex-1" />
        {hosts.length > 1 && (
          <MenuSelect
            value={hostId ?? ''}
            onChange={(id) => {
              setHostId(id)
              reset()
            }}
            aria-label="选择 Host"
            options={hosts.map((h) => ({ value: h.id, label: h.name }))}
            wrapperClassName="w-auto max-w-[180px]"
            className="text-[13px]"
          />
        )}
        <IconButton
          onClick={() => host && void refreshProfiles(host.id)}
          disabled={loading}
          label="刷新账号"
          tooltip="刷新"
          className="max-sm:size-11"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </IconButton>
        {!editing && (
          <Button
            variant="secondary"
            onClick={startNew}
            className="max-sm:min-h-11"
          >
            <Plus size={13} /> 新建账号
          </Button>
        )}
      </div>

      {runtime?.authError && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft/50 px-3 py-2 text-[13px] text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {runtime.authError}
        </div>
      )}

      {editing ? (
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="mb-3 flex items-center gap-2">
            <IconButton
              onClick={() => (step === 1 ? reset() : setStep((s) => (s === 3 ? 2 : 1)))}
              label="返回"
            >
              <ArrowLeft size={15} />
            </IconButton>
            <div className="min-w-0 flex-1">
              <h4 className="text-[13px] font-semibold">
                {editing === 'new' ? '新建账号' : `编辑「${editingProfile?.name ?? '账号'}」`}
              </h4>
              <p className="text-[13px] text-muted">
                {editing === 'new' ? '三步完成，模型自动获取' : '修改后会立即保存到 Host'}
              </p>
            </div>
            <IconButton onClick={reset} label="关闭">
              <X size={15} />
            </IconButton>
          </div>

          <Steps step={step} />

          <div key={step} className="anim-wizard-forward">
          {step === 1 && (
            <div>
              <p className="mb-2.5 text-[13px] text-muted">选择服务商，预设会自动填好接口地址和推荐模型。</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PROVIDER_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => choosePreset(p)}
                    className="group flex items-center gap-2.5 rounded-xl border border-border bg-bg/40 p-2.5 text-left transition-colors duration-[120ms] hover:border-border-strong hover:bg-[var(--t-bg-hover)]"
                  >
                    <ProviderLogo preset={p} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{p.name}</span>
                      <span className="block truncate text-[13px] text-muted">
                        {PROVIDER_KIND_LABELS[p.kind] ?? p.kind}
                      </span>
                    </span>
                  </button>
                ))}
                <button
                  onClick={() => choosePreset(null)}
                  className="flex items-center gap-2.5 rounded-xl border border-dashed border-border bg-transparent p-2.5 text-left transition-colors duration-[120ms] hover:border-border-strong hover:bg-[var(--t-bg-hover)]"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted">
                    <Plus size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">自定义</span>
                    <span className="block truncate text-[13px] text-muted">OpenAI 兼容接口</span>
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
                  <span className="block truncate text-[13px] font-medium">
                    {preset?.name ?? '自定义接口'}
                  </span>
                  <span className="block truncate text-[13px] text-muted">
                    {PROVIDER_KIND_LABELS[form.kind] ?? form.kind}
                  </span>
                </span>
                <button
                  onClick={() => setStep(1)}
                  className="text-[13px] text-muted underline-offset-2 hover:text-text hover:underline"
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
                  <label className={labelCls}>Base URL</label>
                  <input
                    value={form.baseUrl}
                    onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                    placeholder={groupBaseUrlPlaceholder(form.kind)}
                    spellCheck={false}
                    className={cn(inputCls, 'font-mono text-[13px]')}
                  />
                  <p className="mt-1 text-[13px] leading-4 text-muted">
                    一个账号对应一个 URL。Key、协议和模型都在下面的分组里配置，同一 URL 下可混合不同协议。
                  </p>
                </div>

                <div className="mt-3 rounded-xl border border-border bg-bg/30 p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Layers size={13} className="text-text-soft" />
                    <span className="text-[13px] font-medium">账号分组</span>
                    <span className="text-[13px] text-muted">每组可独立协议与 Key</span>
                    <span className="flex-1" />
                    <Button
                      size="sm"
                      onClick={() => setGroupEditor({ index: 'new' })}
                      disabled={!!groupEditor}
                      className="px-2 text-[13px]"
                    >
                      <Plus size={11} /> 添加分组
                    </Button>
                  </div>
                  <p className="mt-1 text-[13px] leading-4 text-muted">
                    同一账号 URL 下可有多组 Key（如官方渠道 / 低价渠道），每组可单独选择协议与模型；会话按所选分组的协议运行。
                  </p>

                  {groupEditor ? (
                    <div className="mt-2">
                      <GroupEditor
                        host={host}
                        kind={form.kind}
                        profileId={editing !== 'new' ? (editing ?? undefined) : undefined}
                        profileBaseUrl={form.baseUrl.trim() || preset?.baseUrl || undefined}
                        existing={
                          groupEditor.index === 'new' ? undefined : groups[groupEditor.index]
                        }
                        onCancel={() => setGroupEditor(null)}
                        onSave={(draft) => {
                          setGroups((prev) =>
                            groupEditor.index === 'new'
                              ? [...prev, draft]
                              : prev.map((g, i) => (i === groupEditor.index ? draft : g)),
                          )
                          setGroupEditor(null)
                        }}
                      />
                    </div>
                  ) : groups.length > 0 ? (
                    <div className="mt-2 space-y-1">
                      {groups.map((g, i) => (
                        <div
                          key={g.id ?? `new-${i}`}
                          className="flex items-center gap-2 rounded-lg bg-surface/70 px-2 py-1.5"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-[13px] text-text">{g.name}</span>
                              <span className="shrink-0 rounded border border-border px-1 text-[11px] text-muted">
                                {GROUP_KIND_LABELS[g.kind]}
                              </span>
                            </span>
                            <span className="block truncate font-mono text-[13px] text-muted">
                              {g.apiKeyMasked || (g.apiKey ? '新 Key（待保存）' : g.inheritedKey ? '沿用账号 Key' : '无 Key')} ·{' '}
                              {g.models.length} 个模型
                            </span>
                          </span>
                          <IconButton
                            size="sm"
                            onClick={() => setGroupEditor({ index: i })}
                            label={`编辑分组 ${g.name}`}
                            className="size-7 [&_svg]:size-[11px]"
                          >
                            <Pencil size={11} />
                          </IconButton>
                          <IconButton
                            size="sm"
                            variant="danger-ghost"
                            onClick={() =>
                              setGroups((prev) => prev.filter((_, index) => index !== i))
                            }
                            label={`删除分组 ${g.name}`}
                            className="size-7 [&_svg]:size-[11px]"
                          >
                            <Trash2 size={11} />
                          </IconButton>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              {error && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft/50 px-3 py-2 text-[13px] text-danger">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                  {error}
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="flex-1" />
                <Button variant="primary" onClick={() => setStep(3)}>
                  下一步 <ArrowRight size={13} />
                </Button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <div className="mb-3 flex items-center gap-2">
                <ProviderLogo preset={preset ?? undefined} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{form.name || preset?.name || '确认分组'}</div>
                  <div className="text-[13px] text-muted">
                    {groups.length} 个分组 · 会话使用所选分组自己的协议与 Key
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                {groups.map((g, i) => (
                  <div
                    key={g.id ?? `confirm-${i}`}
                    className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 px-2.5 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[13px] text-text">{g.name}</span>
                        <span className="shrink-0 rounded border border-border px-1 text-[11px] text-muted">
                          {GROUP_KIND_LABELS[g.kind]}
                        </span>
                      </span>
                      <span className="block truncate font-mono text-[13px] text-muted">
                        {g.apiKeyMasked || (g.apiKey ? '新 Key' : g.inheritedKey ? '沿用账号 Key' : '无 Key')} · 默认{' '}
                        {g.defaultModel || g.models[0] || '未设置'} · {g.models.length} 个模型
                      </span>
                    </span>
                    <button
                      onClick={() => {
                        setStep(2)
                        setGroupEditor({ index: i })
                      }}
                      className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[13px] text-text-soft transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
                    >
                      编辑
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-3 rounded-lg border border-border bg-bg/40 px-2.5 py-2 text-[13px] leading-4 text-muted">
                账号 URL 共用；每个分组按自己的协议拼接请求路径（Anthropic：…/v1/messages，OpenAI：…/chat/completions）。
              </div>

              <PriceOverrides
                models={[...new Set(groups.flatMap((g) => g.models))]}
                price={price}
                onChange={setPrice}
              />

              {error && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft/50 px-3 py-2 text-[13px] text-danger">
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                  {error}
                </div>
              )}

              <div className="mt-4 flex items-center gap-2">
                <Button variant="ghost" onClick={() => setStep(2)}>
                  <ArrowLeft size={12} /> 上一步
                </Button>
                <span className="flex-1" />
                {editingProfile && (
                  <Button
                    variant="danger-ghost"
                    onClick={() => setDeleteTarget(editingProfile)}
                  >
                    <Trash2 size={12} /> 删除
                  </Button>
                )}
                <Button variant="primary" onClick={() => void save()} disabled={saving}>
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  保存账号
                </Button>
              </div>
            </div>
          )}
          </div>
        </div>
      ) : (
        <div>
          {loading && profiles.length === 0 && (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="settings-item flex items-center gap-3 p-3">
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
            <div className="settings-empty">
              <span className="settings-empty-icon"><KeyRound size={17} /></span>
              <p className="settings-empty-title">还没有配置账号</p>
              <p className="settings-empty-hint">
                选择服务商、粘贴 Key，模型列表会自动获取。支持 Anthropic、OpenAI、DeepSeek、Ollama 等。
              </p>
              <Button variant="secondary" onClick={startNew} className="mt-3">
                <Plus size={13} /> 新建账号
              </Button>
            </div>
          )}

          <div className="space-y-2">
            {profiles.map((p) => {
              const result = testResults[p.id]
              const brand = presetForProfile(p)
              return (
                <div
                  key={p.id}
                  className="settings-item p-3"
                >
                  <div className="flex items-start gap-2.5">
                    {brand ? (
                      <ProviderLogo preset={brand} size={32} />
                    ) : (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--t-bg-active)] text-[13px] font-semibold text-text-soft">
                        {initialOf(p.name)}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[13px] font-semibold">{p.name}</span>
                        <span className="rounded border border-border px-1 text-[11px] text-muted">
                          {PROVIDER_KIND_LABELS[p.kind] ?? p.kind}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted">
                        {p.groups?.length ? (
                          <>
                            <span>{p.groups.length} 个分组</span>
                            <span>·</span>
                            <span className="max-w-[200px] truncate">
                              {p.groups
                                .map((g) => GROUP_KIND_LABELS[g.kind ?? p.kind])
                                .join(' / ')}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="font-mono">{p.apiKeyMasked || '无 Key'}</span>
                            <span>·</span>
                            <span className="max-w-[180px] truncate font-mono">{p.defaultModel}</span>
                            <span>·</span>
                            <span>{p.models.length} 个模型</span>
                          </>
                        )}
                        {p.baseUrl && (
                          <>
                            <span className="hidden sm:inline">·</span>
                            <span className="hidden max-w-[180px] truncate font-mono sm:inline">
                              {p.baseUrl}
                            </span>
                          </>
                        )}
                      </div>
                      {p.groups?.length ? (
                        <div className="mt-1 flex min-w-0 items-center gap-1 text-[13px] text-muted">
                          <span className="shrink-0 rounded bg-[var(--t-bg-active)] px-1 text-[13px] leading-4">
                            {p.groups.length} 个分组
                          </span>
                          <span className="min-w-0 truncate">
                            {p.groups
                              .map((g) => `${g.name}（${GROUP_KIND_LABELS[g.kind ?? p.kind]}）`)
                              .join(' / ')}
                          </span>
                        </div>
                      ) : null}
                      {result && (
                        <div
                          className={cn(
                            'mt-1 flex items-center gap-1 text-[13px]',
                            result.ok ? 'text-success' : 'text-danger',
                          )}
                        >
                          {result.ok ? <Check size={11} /> : <TriangleAlert size={11} />}
                          {result.ok ? '测试通过' : result.error || '测试失败'}
                        </div>
                      )}
                    </div>
                    <div className="settings-actions hidden sm:flex" data-desktop-only="">
                      <IconButton
                        size="sm"
                        onClick={() => void test(p)}
                        disabled={testingId === p.id}
                        label={`测试 ${p.name}`}
                        tooltip="测试连接"
                        className="size-7 [&_svg]:size-3"
                      >
                        {testingId === p.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Wifi size={12} />
                        )}
                      </IconButton>
                      <IconButton
                        size="sm"
                        onClick={() => startEdit(p)}
                        label={`编辑 ${p.name}`}
                        tooltip="编辑"
                        className="size-7 [&_svg]:size-3"
                      >
                        <Pencil size={12} />
                      </IconButton>
                      <IconButton
                        size="sm"
                        variant="danger-ghost"
                        onClick={() => setDeleteTarget(p)}
                        label={`删除 ${p.name}`}
                        tooltip="删除"
                        className="size-7 [&_svg]:size-3"
                      >
                        <Trash2 size={12} />
                      </IconButton>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5 border-t border-border pt-2 sm:hidden">
                    <Button
                      size="md"
                      onClick={() => void test(p)}
                      disabled={testingId === p.id}
                      className="mr-auto min-h-11 text-[13px]"
                    >
                      {testingId === p.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Wifi size={12} />
                      )}
                      测试连接
                    </Button>
                    <Button
                      size="md"
                      onClick={() => startEdit(p)}
                      className="min-h-11 text-[13px]"
                    >
                      <Pencil size={12} /> 编辑
                    </Button>
                    <IconButton
                      variant="danger-ghost"
                      onClick={() => setDeleteTarget(p)}
                      label={`删除 ${p.name}`}
                      className="size-11"
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  </div>
                </div>
              )
            })}
          </div>

          {profiles.length > 0 && (
            <p className="settings-note">
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
            <Button onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="danger-ghost"
              onClick={() => deleteTarget && void remove(deleteTarget)}
            >
              删除
            </Button>
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
