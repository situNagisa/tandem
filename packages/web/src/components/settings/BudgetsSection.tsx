import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, RefreshCw, Trash2, TriangleAlert, Wallet } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { SettingRow } from '../ui/SettingRow'
import type {
  BudgetAction,
  BudgetPeriod,
  BudgetRule,
  BudgetScope,
  BudgetStatus,
  Profile,
} from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { formatCost } from '../../lib/format'
import { Button, IconButton } from '../ui/Button'
import { Combobox } from '../ui/Combobox'
import { Input, SegmentedControl, Select, Switch } from '../ui/Controls'
import { MenuSelect } from '../ui/Menu'
import { Modal } from '../ui/Modal'
import { EmptyState } from '../ui/EmptyState'

const SCOPE_LABEL: Record<BudgetScope, string> = {
  global: '全局',
  account: '账号',
  group: '分组',
  model: '模型',
}

const PERIOD_LABEL: Record<BudgetPeriod, string> = {
  day: '每日',
  week: '每周',
  month: '每月',
}

const ACTION_LABEL: Record<BudgetAction, string> = {
  warn: '仅提醒',
  block: '阻止请求',
}

const PERIOD_OPTIONS: Array<{ value: BudgetPeriod; label: string }> = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
]

interface Draft {
  id?: string
  scope: BudgetScope
  profileId: string
  groupId: string
  model: string
  period: BudgetPeriod
  limit: string
  action: BudgetAction
  label: string
  enabled: boolean
}

function newRuleId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

function emptyDraft(): Draft {
  return {
    scope: 'global',
    profileId: '',
    groupId: '',
    model: '',
    period: 'month',
    limit: '20',
    action: 'warn',
    label: '',
    enabled: true,
  }
}

function draftOf(rule: BudgetRule): Draft {
  return {
    id: rule.id,
    scope: rule.scope,
    profileId: rule.profileId ?? '',
    groupId: rule.groupId ?? '',
    model: rule.model ?? '',
    period: rule.period,
    limit: String(rule.limitUsd),
    action: rule.action,
    label: rule.label ?? '',
    enabled: rule.enabled !== false,
  }
}

function ruleName(rule: BudgetRule, profiles: Profile[]): string {
  if (rule.label?.trim()) return rule.label.trim()
  const profile = profiles.find((p) => p.id === rule.profileId)
  switch (rule.scope) {
    case 'global':
      return '全局预算'
    case 'account':
      return profile?.name ?? rule.profileId ?? '账号预算'
    case 'group': {
      const group = profile?.groups?.find((g) => g.id === rule.groupId)
      return group ? `${profile?.name ?? ''} / ${group.name}` : (rule.groupId ?? '分组预算')
    }
    case 'model':
      return rule.model ?? '模型预算'
  }
}

function resetText(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 重置`
}

function BudgetCard({
  rule,
  status,
  profiles,
  disabled,
  confirming,
  onEdit,
  onDelete,
  onToggle,
}: {
  rule: BudgetRule
  status?: BudgetStatus
  profiles: Profile[]
  disabled: boolean
  confirming: boolean
  onEdit: () => void
  onDelete: () => void
  onToggle: (enabled: boolean) => void
}) {
  const percent = status?.percent ?? 0
  const width = Math.min(100, Math.max(0, percent))
  const level = percent >= 100 ? 'danger' : percent > 80 ? 'warn' : 'normal'
  return (
    <div data-setting-id="budgets.enabled" className={cn('settings-item px-3 py-2.5', disabled && 'opacity-55')}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Wallet size={13} className="shrink-0 text-text-tertiary" />
        <span className="min-w-0 truncate text-[13px] font-medium text-text">
          {ruleName(rule, profiles)}
        </span>
        <span className="shrink-0 rounded border border-border px-1 text-[12px] text-muted">
          {PERIOD_LABEL[rule.period]}
        </span>
        <span className="shrink-0 rounded border border-border px-1 text-[12px] text-muted">
          {rule.action === 'block' ? '阻止' : '提醒'}
        </span>
        {disabled && <span className="shrink-0 text-[12px] text-muted">已停用</span>}
        <span className="flex-1" />
        <div className="flex items-center gap-1">
          <Switch
            checked={rule.enabled !== false}
            onChange={onToggle}
            label="启用预算规则"
            className="mr-1"
          />
          <IconButton
            size="sm"
            onClick={onEdit}
            label="编辑预算规则"
            className="size-7 max-sm:size-11 [&_svg]:size-3"
          >
            <Pencil size={12} />
          </IconButton>
          <IconButton
            size="sm"
            variant="danger-ghost"
            onClick={onDelete}
            label={confirming ? '确认删除预算规则' : '删除预算规则'}
            tooltip={confirming ? '再次点击删除' : undefined}
            className={cn('size-7 max-sm:size-11 [&_svg]:size-3', confirming && 'text-danger')}
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
      </div>
      <div className="mt-1 text-[12px] text-muted">
        {SCOPE_LABEL[rule.scope]} · 上限 {formatCost(rule.limitUsd)}
        {status ? ` · 已用 ${formatCost(status.spentUsd)}（${Math.round(status.percent)}%）` : ''}
        {status ? ` · ${resetText(status.resetAt)}` : ''}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--t-bg-active)]">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-300',
              level === 'danger'
                ? 'bg-danger'
                : level === 'warn'
                  ? 'bg-accent'
                  : 'bg-[var(--t-text-tertiary)]',
            )}
            style={{ width: `${width}%` }}
          />
        </div>
        <span
          className={cn(
            'w-11 shrink-0 text-right font-mono text-[12px] tabular-nums',
            level === 'danger' ? 'text-danger' : level === 'warn' ? 'text-accent-text' : 'text-muted',
          )}
        >
          {status ? `${Math.round(percent)}%` : '—'}
        </span>
      </div>
      {status?.blocked && (
        <div className="mt-1.5 flex items-center gap-1 text-[12px] text-danger">
          <TriangleAlert size={11} className="shrink-0" /> 已达上限，新请求会被阻止
        </div>
      )}
    </div>
  )
}

export function BudgetsSection() {
  const hosts = useAppStore((s) => s.hosts)
  const activeHostId = useAppStore((s) => s.activeHostId)
  const runtimes = useAppStore((s) => s.runtimes)
  const toast = useUiStore((s) => s.toast)
  const [hostId, setHostId] = useState<string | null>(activeHostId ?? hosts[0]?.id ?? null)
  const [rules, setRules] = useState<BudgetRule[]>([])
  const [statuses, setStatuses] = useState<BudgetStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!confirmDelete) return
    const timer = window.setTimeout(() => setConfirmDelete(null), 5000)
    return () => window.clearTimeout(timer)
  }, [confirmDelete])

  const host = hosts.find((h) => h.id === hostId) ?? null
  const profiles = useMemo(
    () => (hostId ? runtimes[hostId]?.profiles ?? [] : []),
    [hostId, runtimes],
  )
  const statusByRule = useMemo(
    () => new Map(statuses.map((s) => [s.ruleId, s])),
    [statuses],
  )

  useEffect(() => {
    if (!hostId || !hosts.some((h) => h.id === hostId)) {
      const fallback = activeHostId ?? hosts[0]?.id ?? null
      if (fallback && fallback !== hostId) setHostId(fallback)
    }
  }, [hostId, activeHostId, hosts])

  useEffect(() => {
    if (!host) return
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([api.budgets(host), api.budgetStatus(host)])
      .then(([nextRules, nextStatus]) => {
        if (cancelled) return
        setRules(nextRules ?? [])
        setStatuses(nextStatus ?? [])
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取预算失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, nonce])

  const draftProfiles = useMemo(
    () => profiles.filter((p) => p.groups?.length || p.models.length),
    [profiles],
  )
  const draftProfile = draftProfiles.find((p) => p.id === draft?.profileId)
  const draftModels = useMemo(() => {
    if (!draftProfile) return []
    const group = draftProfile.groups?.find((g) => g.id === draft?.groupId)
    return [...new Set([...(group?.models ?? []), ...draftProfile.models])]
  }, [draftProfile, draft?.groupId])

  const patchDraft = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  const save = async () => {
    if (!host || !draft) return
    const limit = Number(draft.limit)
    if (!Number.isFinite(limit) || limit <= 0) {
      setError('预算上限必须大于 0')
      return
    }
    if ((draft.scope === 'account' || draft.scope === 'group') && !draft.profileId) {
      setError('请选择账号')
      return
    }
    if (draft.scope === 'group' && !draft.groupId) {
      setError('请选择分组')
      return
    }
    if (draft.scope === 'model' && !draft.model.trim()) {
      setError('请填写或选择模型')
      return
    }
    const next: BudgetRule = {
      id: draft.id ?? newRuleId(),
      scope: draft.scope,
      ...(draft.scope === 'account' || draft.scope === 'group'
        ? { profileId: draft.profileId }
        : {}),
      ...(draft.scope === 'group' ? { groupId: draft.groupId } : {}),
      ...(draft.scope === 'model' ? { model: draft.model.trim() } : {}),
      period: draft.period,
      limitUsd: limit,
      action: draft.action,
      ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
      ...(draft.enabled ? {} : { enabled: false }),
    }
    const list = draft.id ? rules.map((r) => (r.id === draft.id ? next : r)) : [...rules, next]
    setSaving(true)
    setError(null)
    try {
      const saved = await api.saveBudgets(host, list)
      setRules(saved)
      setDraft(null)
      setNonce((n) => n + 1)
      toast('预算规则已保存', 'success')
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const removeRule = async (rule: BudgetRule) => {
    if (!host) return
    if (confirmDelete !== rule.id) {
      setConfirmDelete(rule.id)
      toast(`再次点击删除「${ruleName(rule, profiles)}」`, 'info')
      return
    }
    setConfirmDelete(null)
    try {
      const saved = await api.saveBudgets(
        host,
        rules.filter((r) => r.id !== rule.id),
      )
      setRules(saved)
      setNonce((n) => n + 1)
      toast('预算规则已删除', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error')
    }
  }

  const toggleRule = async (rule: BudgetRule, enabled: boolean) => {
    if (!host) return
    try {
      const saved = await api.saveBudgets(
        host,
        rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)),
      )
      setRules(saved)
      setNonce((n) => n + 1)
    } catch (err) {
      toast(err instanceof Error ? err.message : '更新失败', 'error')
    }
  }

  if (!host) {
    return (
      <EmptyState
        icon={<Wallet size={17} />}
        title={<>还没有连接主机</>}
        hint={<>预算规则保存在主机端，先添加一台主机。</>}
      />
    )
  }

  return (
    <div>
      <div data-setting-id="budgets.rules" className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[15px] font-medium text-text">
            <Wallet size={15} className="text-muted" />
            预算
          </h2>
          <p className="mt-1 text-[12.5px] leading-5 text-muted">
            按日 / 周 / 月累计花费，超过 80% 提醒，达到上限可阻止请求
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hosts.length > 1 && (
            <MenuSelect
              value={hostId ?? ''}
              onChange={(id) => setHostId(id)}
              aria-label="选择主机"
              options={hosts.map((h) => ({ value: h.id, label: h.name }))}
              wrapperClassName="w-auto max-w-[180px]"
              className="text-[13px]"
            />
          )}
          <Button
            size="sm"
            onClick={() => setNonce((n) => n + 1)}
            disabled={loading}
            tooltip="刷新预算"
            className="max-sm:h-11"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
          </Button>
          <Button
            data-setting-id="budgets.edit"
            variant="primary"
            size="sm"
            className="max-sm:h-11"
            onClick={() => {
              setError(null)
              setDraft(emptyDraft())
            }}
          >
            <Plus size={12} /> 新建规则
          </Button>
        </div>
      </div>

      {error && !draft && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[13px] text-danger">
          <TriangleAlert size={12} /> {error}
        </div>
      )}

      {loading && rules.length === 0 ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="settings-item p-3">
              <div className="skeleton h-3 w-1/3" />
              <div className="skeleton mt-2 h-2 w-2/3" />
            </div>
          ))}
        </div>
      ) : rules.length === 0 ? (
        <EmptyState
          icon={<Wallet size={17} />}
          title={<>还没有预算规则</>}
          hint={<>给账号、分组或模型设置每月上限，花费接近上限时会收到提醒，也可以阻止新请求。</>}
        />
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <BudgetCard
              key={rule.id}
              rule={rule}
              status={statusByRule.get(rule.id)}
              profiles={profiles}
              disabled={rule.enabled === false}
              confirming={confirmDelete === rule.id}
              onEdit={() => {
                setError(null)
                setDraft(draftOf(rule))
              }}
              onDelete={() => void removeRule(rule)}
              onToggle={(enabled) => void toggleRule(rule, enabled)}
            />
          ))}
        </div>
      )}

      <p className="settings-note">
        花费按主机记录的用量参考价实时累计；周期按自然日 / 本周（周一起）/ 本月计算，达到 100% 时按动作提醒或阻止。
      </p>

      <Modal
        open={!!draft}
        onClose={() => !saving && setDraft(null)}
        title={draft?.id ? '编辑预算规则' : '新建预算规则'}
        className="max-w-lg"
        footer={
          <>
            <Button onClick={() => setDraft(null)} disabled={saving} className="max-sm:h-11">
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={saving}
              className="max-sm:h-11"
            >
              {saving && <Spinner size={12} />} 保存
            </Button>
          </>
        }
      >
        {draft && (
          <div className="space-y-3">
            <SettingRow label="范围" stacked wide>
<SegmentedControl
                aria-label="预算范围"
                value={draft.scope}
                onChange={(scope) => patchDraft({ scope, profileId: '', groupId: '', model: '' })}
                options={(Object.keys(SCOPE_LABEL) as BudgetScope[]).map((value) => ({
                  value,
                  label: SCOPE_LABEL[value],
                }))}
              />
              </SettingRow>

            {(draft.scope === 'account' || draft.scope === 'group') && (
              <SettingRow label="账号" stacked wide>
<Select
                  aria-label="账号"
                  value={draft.profileId}
                  onChange={(e) => patchDraft({ profileId: e.target.value, groupId: '' })}
                >
                  <option value="">选择账号</option>
                  {draftProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                </SettingRow>
            )}

            {draft.scope === 'group' && (
              <SettingRow label="分组" stacked wide>
<Select
                  aria-label="分组"
                  value={draft.groupId}
                  onChange={(e) => patchDraft({ groupId: e.target.value })}
                  disabled={!draftProfile?.groups?.length}
                >
                  <option value="">
                    {!draftProfile
                      ? '请先选择账号'
                      : draftProfile.groups?.length
                        ? '选择分组'
                        : '该账号没有分组'}
                  </option>
                  {draftProfile?.groups?.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
                </SettingRow>
            )}

            {draft.scope === 'model' && (
              <SettingRow label="模型" stacked wide>
<Combobox
                  aria-label="模型"
                  value={draft.model}
                  onChange={(model) => patchDraft({ model })}
                  options={[
                    ...new Set(
                      profiles.flatMap((p) => [
                        ...p.models,
                        ...(p.groups ?? []).flatMap((g) => g.models),
                      ]),
                    ),
                  ]}
                  placeholder="例如 claude-sonnet-4-5"
                  className="font-mono"
                />
                </SettingRow>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <SettingRow label="周期" stacked wide>
<SegmentedControl
                  aria-label="预算周期"
                  value={draft.period}
                  onChange={(period) => patchDraft({ period })}
                  options={PERIOD_OPTIONS}
                />
                </SettingRow>
              <SettingRow label="上限（USD）" stacked wide>
<Input
                  aria-label="上限（USD）"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={draft.limit}
                  onChange={(e) => patchDraft({ limit: e.target.value })}
                  className="font-mono"
                />
                </SettingRow>
            </div>

            <SettingRow label="达到上限时" stacked wide>
<SegmentedControl
                aria-label="预算动作"
                value={draft.action}
                onChange={(action) => patchDraft({ action })}
                options={[
                  { value: 'warn', label: '仅提醒' },
                  { value: 'block', label: '阻止新请求' },
                ]}
              />
              <p className="mt-1 text-[12px] leading-4 text-muted">
                无论哪种动作，达到 80% 都会提醒；「阻止」会在达到 100% 时拒绝新请求，可在会话里临时放行一次。
              </p>
              </SettingRow>

            <SettingRow label="备注名（可选）" stacked wide>
<Input
                aria-label="备注名（可选）"
                value={draft.label}
                onChange={(e) => patchDraft({ label: e.target.value })}
                placeholder="例如 本月 muze 预算"
              />
              </SettingRow>

            <div className="flex items-center justify-between rounded-lg bg-bg/40 px-2.5 py-2">
              <span className="text-[13px] text-text-soft">启用这条规则</span>
              <Switch
                checked={draft.enabled}
                onChange={(enabled) => patchDraft({ enabled })}
                label="启用预算规则"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft/50 px-3 py-2 text-[13px] text-danger">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {error}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
