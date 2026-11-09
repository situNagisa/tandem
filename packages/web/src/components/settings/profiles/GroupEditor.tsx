import { useMemo, useState } from 'react'
import type { ModelInfo, ProviderKind } from '@tandem/protocol'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  Layers,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react'
import { Spinner } from '../../ui/Spinner'
import { SettingRow } from '../../ui/SettingRow'
import { api } from '../../../lib/api'
import { cn } from '../../../lib/cn'
import { mergeFetchedSelection } from '../../../lib/modelSelection'
import type { HostConfig } from '../../../lib/types'
import { Button, IconButton } from '../../ui/Button'
import { MenuSelect } from '../../ui/Menu'
import {
  GROUP_KIND_LABELS,
  type GroupDraft,
  groupBaseUrlPlaceholder,
  inferGroupBaseUrl,
  inputCls,
  labelCls,
} from './shared'

export function GroupEditor({
  host,
  kind: profileKind,
  profileId,
  profileBaseUrl,
  existing,
  siblingGroups = [],
  onSave,
  onCancel,
}: {
  host: HostConfig
  /** 账号协议，分组未选协议时继承 */
  kind: ProviderKind
  profileId?: string
  profileBaseUrl?: string
  existing?: GroupDraft
  /** 同一账号下已保存的其他分组，可加入备用链。 */
  siblingGroups?: Array<{ id: string; name: string }>
  onSave: (draft: GroupDraft) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [kind, setKind] = useState<ProviderKind>(existing?.kind ?? profileKind)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '')
  const [showKey, setShowKey] = useState(false)
  // 已有 Key 时不渲染明文输入框，只显示掩码；点「更换 Key」才进入输入状态。
  // 未修改 Key 时保存不会回传 apiKey，服务端保留原值（反馈10#05 / R39）。
  const [editingKey, setEditingKey] = useState(!existing)
  const maskedKey = existing?.apiKeyMasked?.trim()
  const keyLast4 = maskedKey?.match(/([^*\s]{4})$/)?.[1]
  const [available, setAvailable] = useState<ModelInfo[]>(
    () => (existing?.models ?? []).map((id) => ({ id })),
  )
  const [selected, setSelected] = useState<string[]>(existing?.models ?? [])
  /** 用户手动改过勾选：再次拉取时保留这些选择，只对新增模型应用「最新一代」规则。 */
  const [selectionTouched, setSelectionTouched] = useState(false)
  const [defaultModel, setDefaultModel] = useState(
    existing?.defaultModel ?? existing?.models[0] ?? '',
  )
  const [query, setQuery] = useState('')
  const [manualInput, setManualInput] = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fallbackIds, setFallbackIds] = useState<string[]>(existing?.fallbackGroupIds ?? [])
  const [multiplier, setMultiplier] = useState(String(existing?.multiplier ?? 1))

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return available
    return available.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.displayName ?? '').toLowerCase().includes(q),
    )
  }, [available, query])

  const toggleModel = (id: string) => {
    setSelectionTouched(true)
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
      const initial = mergeFetchedSelection({
        selected,
        previousAvailable: available.map((m) => m.id),
        fetched: sorted.map((m) => m.id),
        touched: selectionTouched,
      }).filter((id) => ids.has(id))
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
    setSelectionTouched(true)
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
      ...(Number.isFinite(Number(multiplier)) ? { multiplier: Number(multiplier) } : {}),
      ...(fallbackIds.length
        ? { fallbackGroupIds: fallbackIds.filter((id) => id !== existing?.id) }
        : {}),
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
        <SettingRow label="分组名称" stacked wide>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：官方渠道 / 低价渠道"
            className={inputCls}
          />
        </SettingRow>
        <SettingRow label="协议类型" stacked wide>
          <MenuSelect
            value={kind}
            onChange={(next) => setKind(next as ProviderKind)}
            aria-label="分组协议类型"
            options={Object.entries(GROUP_KIND_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </SettingRow>
        <SettingRow label="分组 Key" stacked wide>
          {existing && !editingKey ? (
            <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-soft">
                {existing.inheritedKey && !maskedKey
                  ? '沿用账号 Key'
                  : `已保存 · ••••${keyLast4 ?? '••••'}`}
              </span>
              <button data-raw-button
                type="button"
                onClick={() => {
                  setEditingKey(true)
                  setApiKey('')
                }}
                className="shrink-0 rounded px-1 text-[12px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
              >
                更换 Key
              </button>
            </div>
          ) : (
            <div className="relative">
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                type={showKey ? 'text' : 'password'}
                placeholder={existing ? '粘贴新的 Key' : 'sk-…'}
                spellCheck={false}
                autoComplete="off"
                className={cn(inputCls, 'pr-9 font-mono text-[13px]')}
              />
              <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                {existing && (
                  <button data-raw-button
                    type="button"
                    onClick={() => {
                      setEditingKey(false)
                      setApiKey('')
                      setShowKey(false)
                    }}
                    className="rounded px-1 text-[12px] text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
                  >
                    取消
                  </button>
                )}
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
          )}
        </SettingRow>
      </div>
      <div className="mt-2">
        <SettingRow
          label="Base URL（可选，缺省沿用账号）"
          stacked
          wide
          hint={kind === 'anthropic'
            ? 'Anthropic 协议会自动拼接 /v1/messages；填完整端点也可以。'
            : 'OpenAI 系协议会自动拼接 /chat/completions。'}
        >
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={profileBaseUrl || groupBaseUrlPlaceholder(kind)}
          spellCheck={false}
          className={cn(inputCls, 'font-mono text-[13px]')}
        />
        </SettingRow>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <SettingRow
          label="价格倍率"
          stacked
          wide
          hint="默认 1.0；实际价 = 官方价 × 账号倍率 × 分组倍率，这里在账号倍率之上再叠加，如 0.8。"
        >
          <input
            id={`group-multiplier-${existing?.id ?? 'new'}`}
            type="number"
            min={0}
            step={0.1}
            value={multiplier}
            onChange={(e) => setMultiplier(e.target.value)}
            className={cn(inputCls, 'w-28 font-mono')}
          />
        </SettingRow>
      </div>

      <div className="mt-2">
        <SettingRow label="备用分组（额度将尽时按顺序交接）" stacked wide>
        {fallbackIds.length > 0 ? (
          <div className="space-y-1">
            {fallbackIds.map((id, index) => {
              const name = siblingGroups.find((item) => item.id === id)?.name ?? id
              return (
                <div
                  key={id}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-bg/40 px-2 py-1"
                >
                  <span className="w-4 shrink-0 text-center font-mono text-[12px] text-muted">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text-soft">{name}</span>
                  <IconButton
                    size="sm"
                    label={`上移备用分组 ${name}`}
                    className="size-6 [&_svg]:size-[11px]"
                    disabled={index === 0}
                    onClick={() =>
                      setFallbackIds((prev) => {
                        const next = [...prev]
                        ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
                        return next
                      })
                    }
                  >
                    <ArrowUp size={11} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    label={`下移备用分组 ${name}`}
                    className="size-6 [&_svg]:size-[11px]"
                    disabled={index === fallbackIds.length - 1}
                    onClick={() =>
                      setFallbackIds((prev) => {
                        const next = [...prev]
                        ;[next[index], next[index + 1]] = [next[index + 1]!, next[index]!]
                        return next
                      })
                    }
                  >
                    <ArrowDown size={11} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    variant="danger-ghost"
                    label={`移除备用分组 ${name}`}
                    className="size-6 [&_svg]:size-[11px]"
                    onClick={() => setFallbackIds((prev) => prev.filter((item) => item !== id))}
                  >
                    <X size={11} />
                  </IconButton>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-[12px] leading-4 text-muted">未配置；额度将尽时按设置里的默认策略处理。</p>
        )}
        {siblingGroups.filter((item) => item.id !== existing?.id && !fallbackIds.includes(item.id)).length > 0 && (
          <div className="mt-1.5">
            <MenuSelect
              value=""
              onChange={(id) => {
                if (id) setFallbackIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
              }}
              aria-label="添加备用分组"
              size="sm"
              options={[
                { value: '', label: '添加备用分组…' },
                ...siblingGroups
                  .filter((item) => item.id !== existing?.id && !fallbackIds.includes(item.id))
                  .map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
          </div>
        )}
        </SettingRow>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button onClick={() => void fetchModels()} disabled={fetching}>
          {fetching ? <Spinner size={12} /> : <RefreshCw size={12} />}
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
                    <span className="shrink-0 rounded bg-[var(--t-bg-active)] px-1 text-[12px] text-text-secondary">默认</span>
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
        <button data-raw-button
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
