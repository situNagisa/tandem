import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  GripVertical,
  KeyRound,
  Layers,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wifi,
  X,
} from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { SettingRow } from '../ui/SettingRow'
import type {
  KeyStrategy,
  ModelInfo,
  Profile,
  ProfileGroup,
  ProfileGroupInput,
  ProfileInput,
  ProfileKey,
  ProfileKeyInput,
  ProviderKind,
} from '@tandem/protocol'
import { api, workstationApi } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { PROVIDER_PRESETS, presetForProfile, type ProviderPreset } from '../../lib/presets'
import { PROVIDER_KIND_LABELS, type HostConfig } from '../../lib/types'
import { formatCost, formatElapsed } from '../../lib/format'
import { mergeFetchedSelection } from '../../lib/modelSelection'
import { useNow } from '../../lib/hooks'
import { cn } from '../../lib/cn'
import { ConfirmAction } from '../ui/ConfirmAction'
import { Modal } from '../ui/Modal'
import { Button, IconButton } from '../ui/Button'
import { SegmentedControl } from '../ui/Controls'
import { MenuSelect } from '../ui/Menu'
import { Tip, Tooltip } from '../ui/Tooltip'
import { ProviderIcon } from '../ProviderIcon'
import { PriceOverrides } from './profiles/PriceOverrides'
import { GroupEditor } from './profiles/GroupEditor'
import { KeysPanel } from './profiles/KeysPanel'
import { Card } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import {
  GROUP_KIND_LABELS,
  type FormState,
  type GroupDraft,
  type PriceMap,
  type Step,
  defaultGroupDraft,
  emptyForm,
  groupBaseUrlPlaceholder,
  groupInputOf,
  inputCls,
  keyInputOf,
  labelCls,
  profileInputOf,
} from './profiles/shared'

function Steps({ step }: { step: Step }) {
  return (
    <div
      className="flex items-center gap-1"
      role="img"
      aria-label={`第 ${step} 步，共 3 步`}
    >
      {([1, 2, 3] as Step[]).map((n) => (
        <span
          key={n}
          className={cn(
            'flex size-[18px] items-center justify-center rounded-full text-[10px] tabular-nums',
            n === step
              ? 'bg-[var(--t-text)] font-medium text-[var(--t-bg)]'
              : n < step
                ? 'bg-[var(--t-bg-active)] text-text-soft'
                : 'border border-border text-muted',
          )}
        >
          {n}
        </span>
      ))}
    </div>
  )
}

export function ProfilesSection() {
  const hosts = useAppStore((s) => s.hosts)
  const account = useAppStore((s) => s.account)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const toast = useUiStore((s) => s.toast)
  const settingsFocus = useUiStore((s) => s.settingsFocus)

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
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null)
  const [groups, setGroups] = useState<GroupDraft[]>([])
  const [groupEditor, setGroupEditor] = useState<{ index: number | 'new' } | null>(null)
  const [price, setPrice] = useState<PriceMap>({})
  const [multiplier, setMultiplier] = useState('1')
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
    setMultiplier('1')
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
      balancePlatform: p.balanceQuery?.platform ?? 'auto',
      balanceUrl: p.balanceQuery?.url ?? '',
      balancePath: p.balanceQuery?.path ?? '',
      balanceCurrency: p.balanceQuery?.currency ?? '',
      balanceThreshold:
        p.balanceQuery?.threshold !== undefined ? String(p.balanceQuery.threshold) : '',
    })
    setAvailable(p.models.map((id) => ({ id })))
    setSelected(p.models)
    setDefaultModel(p.defaultModel || p.models[0] || '')
    setShowAdvanced(!!p.baseUrl && p.baseUrl !== brand?.baseUrl)
    setPrice(p.price ? { ...p.price } : {})
    setMultiplier(String(p.multiplier ?? 1))
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
            ...(g.multiplier !== undefined ? { multiplier: g.multiplier } : {}),
            ...(g.fallbackGroupIds?.length ? { fallbackGroupIds: [...g.fallbackGroupIds] } : {}),
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

  // 模型菜单的「单价未设置 · 去设置」：直接打开该账号并定位到单价区。
  const priceFocus = useRef(0)
  const priceFocusTimer = useRef(0)
  useEffect(() => {
    const id = settingsFocus?.id
    if (!id?.startsWith('profiles.prices:')) return
    if (priceFocus.current === settingsFocus!.nonce) return
    const profile = profiles.find((p) => p.id === id.slice('profiles.prices:'.length))
    if (!profile) return
    priceFocus.current = settingsFocus!.nonce
    startEdit(profile)
    setStep(3)
    window.clearTimeout(priceFocusTimer.current)
    priceFocusTimer.current = window.setTimeout(() => {
      const node = document.querySelector<HTMLElement>('[data-setting-id="profiles.prices"]')
      if (!node) return
      node.scrollIntoView({ block: 'center', behavior: 'auto' })
      node.classList.remove('setting-highlight')
      void node.getBoundingClientRect()
      node.classList.add('setting-highlight')
      window.setTimeout(() => node.classList.remove('setting-highlight'), 1800)
    }, 150)
    // startEdit 是稳定逻辑，只随 profile 列表变化重试；nonce 保证同一次定位只执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsFocus, profiles])
  useEffect(() => () => window.clearTimeout(priceFocusTimer.current), [])

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
      balancePlatform: 'auto',
      balanceUrl: '',
      balancePath: '',
      balanceCurrency: '',
      balanceThreshold: '',
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
    // 默认只勾选每个系列的最新一代；编辑已有账号时保留原有选择，只对新增模型应用规则。
    const initial = mergeFetchedSelection({
      selected: keepProfileModels ? selected : [],
      previousAvailable: keepProfileModels ? available.map((m) => m.id) : [],
      fetched: sorted.map((m) => m.id),
      touched: keepProfileModels,
    })
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
      setFetchError('填写 API Key 后获取模型列表。')
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
      ...(g.multiplier !== undefined ? { multiplier: g.multiplier } : {}),
      ...(g.fallbackGroupIds?.length
        ? { fallbackGroupIds: g.fallbackGroupIds.filter((id) => id !== g.id) }
        : {}),
    }))
    const input: ProfileInput = {
      name,
      // 账号协议取首个分组，实际会话运行按各组 kind 覆盖
      kind: primary.kind,
      baseUrl: form.baseUrl.trim() || undefined,
      apiKey: form.apiKey.trim() || undefined,
      models,
      defaultModel: def,
      ...(Number.isFinite(Number(multiplier)) && Number(multiplier) >= 0
        ? { multiplier: Number(multiplier) }
        : {}),
      ...(Object.keys(price).length ? { price } : {}),
      ...(form.balancePlatform !== 'auto' ||
      form.balanceUrl.trim() ||
      form.balancePath.trim() ||
      form.balanceCurrency.trim() ||
      form.balanceThreshold.trim()
        ? {
            balanceQuery: {
              platform: form.balancePlatform,
              ...(form.balanceUrl.trim() ? { url: form.balanceUrl.trim() } : {}),
              ...(form.balancePath.trim() ? { path: form.balancePath.trim() } : {}),
              ...(form.balanceCurrency.trim() ? { currency: form.balanceCurrency.trim() } : {}),
              ...(Number.isFinite(Number(form.balanceThreshold)) && form.balanceThreshold.trim()
                ? { threshold: Number(form.balanceThreshold) }
                : {}),
            },
          }
        : {}),
      groups: groupInputs,
    }
    setSaving(true)
    setError(null)
    try {
      if (editing === 'new') {
        if (account) await workstationApi.createProfile(account.centerUrl, account.accessToken, input)
        else await api.createProfile(host, input)
        toast('账号已创建', 'success')
      } else if (editing) {
        if (account) await workstationApi.updateProfile(account.centerUrl, account.accessToken, editing, input)
        else await api.updateProfile(host, editing, input)
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
      if (account) await workstationApi.deleteProfile(account.centerUrl, account.accessToken, p.id)
      else await api.deleteProfile(host, p.id)
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
      const res = account
        ? await workstationApi.testProfile(account.centerUrl, account.accessToken, p.id, p.groups?.[0]?.id)
        : await api.testProfile(host, p.id, p.groups?.[0]?.id)
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
      <EmptyState
        icon={<KeyRound size={17} />}
        title={<>还没有连接主机</>}
        hint={<>先添加一台主机，再配置账号与模型。</>}
      />
    )
  }

  const selectedModels = available.filter((m) => selected.includes(m.id))

  return (
    <div>
      <div data-setting-id="profiles.accounts" className="mb-4 flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">账号与模型</h3>
        <span className="hidden text-[13px] text-muted sm:inline">
          {account
            ? '账号级设置：所有主机共用，Key 加密保存在工作站'
            : 'Key 保存在主机端，不会下发明文'}
        </span>
        <span className="flex-1" />
        {!account && hosts.length > 1 && (
          <MenuSelect
            value={hostId ?? ''}
            onChange={(id) => {
              setHostId(id)
              reset()
            }}
            aria-label="选择主机"
            options={hosts.map((h) => ({ value: h.id, label: h.name }))}
            wrapperClassName="w-auto max-w-[180px]"
            className="text-[13px]"
          />
        )}
        <IconButton
          onClick={() => {
            if (!host) return
            // 账号级：手动刷新时顺带强制查一次余额（平时 5 分钟缓存）。
            if (account) {
              void workstationApi
                .profiles(account.centerUrl, account.accessToken, true)
                .then(() => refreshProfiles(host.id))
                .catch(() => refreshProfiles(host.id))
            } else {
              void refreshProfiles(host.id)
            }
          }}
          disabled={loading}
          label="刷新账号"
          tooltip="刷新"
          className="max-sm:size-11"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </IconButton>
        {!editing && (
          <Button
            variant="primary"
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
        <Card>
          <div className="mb-3 flex items-center gap-2">
            {step > 1 && (
              <IconButton
                onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
                label="返回"
              >
                <ArrowLeft size={15} />
              </IconButton>
            )}
            <Steps step={step} />
            <span className="flex-1" />
            <IconButton onClick={reset} label="关闭">
              <X size={15} />
            </IconButton>
          </div>

          <div key={step} className="anim-wizard-forward">
          {step === 1 && (
            <div>
              <p className="mb-2.5 text-[13px] text-muted">选择服务商，预设会自动填好接口地址和推荐模型。</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {PROVIDER_PRESETS.map((p) => (
                  <button data-raw-button
                    key={p.id}
                    onClick={() => choosePreset(p)}
                    className="group flex items-center gap-2.5 rounded-xl border border-border bg-bg/40 p-2.5 text-left transition-colors duration-[120ms] hover:border-border-strong hover:bg-[var(--t-bg-hover)]"
                  >
                    <ProviderIcon preset={p} size={20} className="text-text-soft" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{p.name}</span>
                      <span className="block truncate text-[13px] text-muted">
                        {PROVIDER_KIND_LABELS[p.kind] ?? p.kind}
                      </span>
                    </span>
                  </button>
                ))}
                <button data-raw-button
                  onClick={() => choosePreset(null)}
                  className="flex items-center gap-2.5 rounded-xl border border-dashed border-border bg-transparent p-2.5 text-left transition-colors duration-[120ms] hover:border-border-strong hover:bg-[var(--t-bg-hover)]"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center text-muted">
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
            <div className="grid gap-4 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
              <aside className="space-y-2.5">
                <div className="flex items-center gap-2.5 rounded-xl bg-[var(--t-bg)] px-3 py-2">
                  <ProviderIcon
                    preset={preset ?? undefined}
                    name={form.name}
                    size={22}
                    className="text-text-soft"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">
                      {preset?.name ?? '自定义接口'}
                    </span>
                    <span className="block truncate text-[13px] text-muted">
                      {PROVIDER_KIND_LABELS[form.kind] ?? form.kind}
                    </span>
                  </span>
                  <button data-raw-button
                    onClick={() => setStep(1)}
                    className="text-[13px] text-muted underline-offset-2 hover:text-text hover:underline"
                  >
                    更换
                  </button>
                </div>
                <p className="text-[13px] leading-5 text-muted">
                  {account
                    ? 'Key 加密保存在工作站，主机与浏览器都看不到明文。每个分组可单独设置协议与模型，会话按所选分组运行。'
                    : 'Key 保存在主机端，不会下发到浏览器。每个分组可单独设置协议与模型，会话按所选分组运行。'}
                </p>
              </aside>

              <div className="min-w-0">
                <div className="space-y-3">
                <SettingRow label="账号名称" stacked wide>
                  <input
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="例如：公司 Anthropic"
                    className={inputCls}
                  />
                </SettingRow>
                <SettingRow
                  label="Base URL"
                  stacked
                  wide
                  hint="一个账号对应一个 URL。Key、协议和模型都在下面的分组里配置，同一 URL 下可混合不同协议。"
                >
                  <input
                    value={form.baseUrl}
                    onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                    placeholder={groupBaseUrlPlaceholder(form.kind)}
                    spellCheck={false}
                    className={cn(inputCls, 'font-mono text-[13px]')}
                  />
                </SettingRow>

                <div data-setting-id="profiles.balance" className="mt-3 rounded-xl border border-border bg-bg/30 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">余额查询</span>
                    <span className="text-[13px] text-muted">工作站用 Key 查询，5 分钟缓存</span>
                    <span className="flex-1" />
                    <MenuSelect
                      value={form.balancePlatform}
                      onChange={(value) =>
                        setForm((f) => ({ ...f, balancePlatform: value as FormState['balancePlatform'] }))
                      }
                      aria-label="余额查询平台"
                      options={[
                        { value: 'auto', label: '自动识别' },
                        { value: 'none', label: '关闭' },
                        { value: 'openrouter', label: 'OpenRouter' },
                        { value: 'deepseek', label: 'DeepSeek' },
                        { value: 'moonshot', label: 'Moonshot / Kimi' },
                        { value: 'new-api', label: 'New API / One API' },
                        { value: 'openai-billing', label: 'OpenAI Billing' },
                        { value: 'openai-credit-grants', label: 'OpenAI Credit Grants' },
                        { value: 'custom', label: '自定义' },
                      ]}
                      wrapperClassName="w-auto max-w-[200px]"
                      className="text-[13px]"
                    />
                  </div>
                  {form.balancePlatform === 'custom' && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <input
                        value={form.balanceUrl}
                        onChange={(e) => setForm((f) => ({ ...f, balanceUrl: e.target.value }))}
                        placeholder="查询 URL（GET）"
                        spellCheck={false}
                        className={cn(inputCls, 'font-mono text-[13px] sm:col-span-2')}
                      />
                      <input
                        value={form.balancePath}
                        onChange={(e) => setForm((f) => ({ ...f, balancePath: e.target.value }))}
                        placeholder="金额 JSON 路径，如 data.balance"
                        spellCheck={false}
                        className={cn(inputCls, 'font-mono text-[13px]')}
                      />
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      value={form.balanceCurrency}
                      onChange={(e) => setForm((f) => ({ ...f, balanceCurrency: e.target.value }))}
                      placeholder="币种（缺省 USD）"
                      spellCheck={false}
                      className={cn(inputCls, 'max-w-[140px]')}
                    />
                    <input
                      value={form.balanceThreshold}
                      onChange={(e) => setForm((f) => ({ ...f, balanceThreshold: e.target.value }))}
                      placeholder="低余额提醒阈值"
                      inputMode="decimal"
                      className={cn(inputCls, 'max-w-[160px]')}
                    />
                  </div>
                  <p className="mt-1 text-[13px] leading-4 text-muted">
                    自动识别只认已知平台；其他中转可选择平台或自定义查询。查询失败显示「—」。
                  </p>
                </div>

                <div data-setting-id="profiles.groups" className="mt-3 rounded-xl border border-border bg-bg/30 p-3">
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
                        siblingGroups={groups
                          .filter((item, index) => !!item.id && index !== groupEditor.index)
                          .map((item) => ({ id: item.id!, name: item.name }))}
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
                              <span className="shrink-0 rounded border border-border px-1 text-[12px] text-muted">
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
            </div>
          )}

          {step === 3 && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
              <aside className="space-y-2.5">
                <div className="flex items-center gap-2.5">
                  <ProviderIcon
                    preset={preset ?? undefined}
                    name={form.name}
                    size={22}
                    className="text-text-soft"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{form.name || preset?.name || '确认分组'}</div>
                    <div className="text-[13px] text-muted">
                      {groups.length} 个分组 · 会话使用所选分组自己的协议与 Key
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-bg/40 px-2.5 py-2 text-[13px] leading-4 text-muted">
                  账号 URL 共用；每个分组按自己的协议拼接请求路径（Anthropic：…/v1/messages，OpenAI：…/chat/completions）。
                </div>
              </aside>

              <div className="min-w-0">
                <div className="space-y-1.5">
                {groups.map((g, i) => (
                  <div
                    key={g.id ?? `confirm-${i}`}
                    className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 px-2.5 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[13px] text-text">{g.name}</span>
                        <span className="shrink-0 rounded border border-border px-1 text-[12px] text-muted">
                          {GROUP_KIND_LABELS[g.kind]}
                        </span>
                      </span>
                      <span className="block truncate font-mono text-[13px] text-muted">
                        {g.apiKeyMasked || (g.apiKey ? '新 Key' : g.inheritedKey ? '沿用账号 Key' : '无 Key')} · 默认{' '}
                        {g.defaultModel || g.models[0] || '未设置'} · {g.models.length} 个模型
                        {g.multiplier !== undefined && g.multiplier !== 1 ? ` · 倍率 ${g.multiplier}×` : ''}
                      </span>
                    </span>
                    <button data-raw-button
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

              <div className="mb-3 rounded-lg border border-border bg-bg/40 p-3" data-setting-id="profiles.multiplier">
                <SettingRow label="价格倍率" htmlFor="profile-multiplier">
                  <input
                    id="profile-multiplier"
                    type="number"
                    min={0}
                    step={0.1}
                    value={multiplier}
                    onChange={(e) => setMultiplier(e.target.value)}
                    className={cn(inputCls, 'w-28 font-mono')}
                  />
                  <span className="text-[13px] text-muted">× 官方参考价</span>
                </SettingRow>
                <p className="mt-1.5 text-[12px] leading-4 text-muted">
                  中转常见如 0.3×、1.5×。实际价格 = 官方参考价 × 账号倍率 × 分组倍率；按模型覆盖单价时不乘倍率。
                </p>
              </div>

              <div data-setting-id="profiles.prices">
              <PriceOverrides
                models={[...new Set(groups.flatMap((g) => g.models))]}
                price={price}
                onChange={setPrice}
              />
              </div>

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
                  {saving && <Spinner size={14} />}
                  保存账号
                </Button>
              </div>
              </div>
            </div>
          )}
          </div>
        </Card>
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
            <EmptyState
              icon={<KeyRound size={17} />}
              title={<>还没有配置账号</>}
              hint={<>选择服务商、粘贴 Key，模型列表会自动获取。支持 Anthropic、OpenAI、DeepSeek、Ollama 等。</>}
              action={<><Button variant="primary" onClick={startNew}>
                <Plus size={13} /> 新建账号
              </Button></>}
            />
          )}

          <div className="space-y-2">
            {profiles.map((p) => {
              const result = testResults[p.id]
              const brand = presetForProfile(p)
              const groupCount = p.groups?.length ?? 0
              const isOpen = expandedProfile === p.id
              return (
                <div key={p.id} data-setting-id="profiles.models" className="settings-item" data-open={isOpen || undefined}>
                  <div className="flex items-center">
                    <button data-raw-button
                      type="button"
                      onClick={() => setExpandedProfile(isOpen ? null : p.id)}
                      aria-expanded={isOpen}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left"
                    >
                      <ProviderIcon
                        preset={brand}
                        name={p.name}
                        size={18}
                        className="text-text-soft"
                      />
                      <span className="truncate text-[13px] font-medium">{p.name}</span>
                      <span className="shrink-0 text-[13px] text-muted">
                        {groupCount ? `${groupCount} 个分组` : `${p.models.length} 个模型`}
                      </span>
                      {p.balance && (
                        <span
                          className={cn(
                            'shrink-0 text-[12px] tabular-nums',
                            p.balance.error ||
                              (p.balanceQuery?.threshold !== undefined &&
                                p.balance.amount !== undefined &&
                                p.balance.amount < p.balanceQuery.threshold)
                              ? 'text-warning'
                              : 'text-muted',
                          )}
                        >
                          余额{' '}
                          {p.balance.amount !== undefined
                            ? `${p.balance.currency === 'USD' ? '$' : ''}${formatCost(p.balance.amount)}`
                            : '—'}
                        </span>
                      )}
                      {p.balance?.error && <Tip label={p.balance.error} />}
                      {p.multiplier !== undefined && p.multiplier !== 1 && (
                        <span className="shrink-0 rounded border border-border px-1 text-[12px] text-muted">
                          × {p.multiplier}
                        </span>
                      )}
                      <span className="flex-1" />
                      <ChevronDown
                        size={12}
                        className={cn(
                          'shrink-0 text-muted transition-transform duration-150',
                          isOpen && 'rotate-180',
                        )}
                      />
                      {p.baseUrl && <Tip label={p.baseUrl} />}
                    </button>
                    <div className="settings-actions pr-2" data-open={isOpen || undefined}>
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

                  {isOpen && (
                    <div className="border-t border-border px-3 pb-3 pt-2">
                      {groupCount ? (
                        <div className="space-y-1">
                          {p.groups?.map((g) => (
                            <div key={g.id} data-setting-id="profiles.key-strategy" className="rounded-lg bg-bg/40 px-2 py-1.5">
                              <div className="flex items-center gap-2">
                                <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                                  {g.name}
                                </span>
                                <span className="shrink-0 rounded border border-border px-1 text-[12px] text-muted">
                                  {GROUP_KIND_LABELS[g.kind ?? p.kind]}
                                </span>
                                <span className="shrink-0 text-[12px] text-muted">
                                  {g.keys.length} Key · {g.models.length} 模型
                                </span>
                              </div>
                              <KeysPanel
                                profile={p}
                                group={g}
                                saveProfile={async (input) => {
                                  if (account) {
                                    await workstationApi.updateProfile(account.centerUrl, account.accessToken, p.id, input)
                                  } else {
                                    await api.updateProfile(host, p.id, input)
                                  }
                                  await refreshProfiles(host.id)
                                }}
                                testProfile={(groupId, keyId) =>
                                  account
                                    ? workstationApi.testProfile(account.centerUrl, account.accessToken, p.id, groupId, keyId)
                                    : api.testProfile(host, p.id, groupId, keyId)
                                }
                              />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 rounded-lg bg-bg/40 px-2 py-1.5">
                          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text">
                            {p.defaultModel || p.models[0] || '未设置模型'}
                          </span>
                          <span className="shrink-0 text-[12px] text-muted">
                            {p.models.length} 个模型
                          </span>
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => void test(p)}
                          disabled={testingId === p.id}
                        >
                          {testingId === p.id ? (
                            <Spinner size={12} />
                          ) : (
                            <Wifi size={12} />
                          )}
                          测试连接
                        </Button>
                        {result && (
                          <span
                            className={cn(
                              'flex min-w-0 items-center gap-1 text-[13px]',
                              result.ok ? 'text-success' : 'text-danger',
                            )}
                          >
                            {result.ok ? <Check size={11} /> : <TriangleAlert size={11} />}
                            <span className="truncate">
                              {result.ok ? '测试通过' : result.error || '测试失败'}
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                  )}
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

      <ConfirmAction
        open={!!deleteTarget}
        title="删除账号"
        description={`删除账号「${deleteTarget?.name ?? ''}」？使用它的会话需要重新选择账号。`}
        confirmLabel="删除"
        danger
        onConfirm={() => {
          if (deleteTarget) void remove(deleteTarget)
        }}
        onClose={() => setDeleteTarget(null)}
        testId="profile-delete-confirm"
      />
    </div>
  )
}

