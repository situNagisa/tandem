import { useMemo, useState } from 'react'
import type {
  DivisionConfirm,
  DivisionRoutingSettings,
  ModelPriceInfo,
  ModelRoutingSettings,
  ModelTier,
  Profile,
  RouteAssignment,
  RouteDomain,
  RouteRole,
} from '@tandem/protocol'
import { ChevronDown, GitFork, Loader2, Wand2 } from 'lucide-react'
import { profileModelGroups } from '../../lib/profileModels'
import { ROUTE_MODE_META } from '../../lib/routeLabels'
import { formatCost } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Button } from '../ui/Button'
import { Input, Select } from '../ui/Controls'

const DOMAINS: Array<{ value: RouteDomain; label: string; placeholder: string }> = [
  { value: 'ui', label: '前端 UI', placeholder: '前端 UI 强项' },
  { value: 'backend', label: '后端', placeholder: '后端/接口强项' },
  { value: 'test', label: '测试', placeholder: '测试/lint 强项' },
  { value: 'docs', label: '文档', placeholder: '文档写作强项' },
  { value: 'data', label: '数据', placeholder: '数据/SQL 强项' },
  { value: 'ops', label: '运维脚本', placeholder: '脚本/构建强项' },
  { value: 'general', label: '通用', placeholder: '通用执行' },
]

const ROLE_ROWS: Array<{ role: RouteRole; label: string; hint: string }> = [
  { role: 'planner', label: '规划者', hint: '主会话模型，不切换；理解意图、拆解与收尾' },
  { role: 'executor', label: '执行者', hint: 'Task 子代理：跑命令、装依赖、机械修改' },
  { role: 'reviewer', label: '审查者', hint: '预留：执行结果复核（v1 主要为用量统计）' },
]

interface Row {
  key: string
  profileId: string
  groupId?: string
  model: string
  account: string
  group: string
  tier: ModelTier
  price?: ModelPriceInfo
}

function tierOf(price: ModelPriceInfo | undefined): ModelTier {
  if (!price) return 'balanced'
  const score = price.input + price.output
  if (score <= 2) return 'fast'
  if (score >= 10) return 'power'
  return 'balanced'
}

function assignmentKey(value: RouteAssignment | undefined): string {
  return value ? `${value.profileId}\u0000${value.groupId ?? ''}\u0000${value.model}` : ''
}

function parseAssignment(rows: Row[], key: string): RouteAssignment | undefined {
  const row = rows.find((item) => item.key === key)
  if (!row) return undefined
  return {
    profileId: row.profileId,
    ...(row.groupId ? { groupId: row.groupId } : {}),
    model: row.model,
    tier: row.tier,
  }
}

function priceText(price: ModelPriceInfo | undefined): string {
  if (!price) return '—'
  return `$${Number(price.input.toFixed(4))} / $${Number(price.output.toFixed(4))}`
}

export function DivisionRoutingSection({
  routing,
  profiles,
  prices,
  loading,
  saving,
  onChange,
}: {
  routing: ModelRoutingSettings
  profiles: Profile[]
  prices: Record<string, ModelPriceInfo>
  loading: boolean
  saving: boolean
  onChange: (next: ModelRoutingSettings) => void
}) {
  const [preview, setPreview] = useState<string | null>(null)
  const division = routing.division ?? {}
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const tierByKey = new Map<string, ModelTier>()
    for (const candidate of routing.candidates) {
      tierByKey.set(`${candidate.profileId}\u0000${candidate.groupId ?? ''}\u0000${candidate.model}`, candidate.tier)
    }
    for (const profile of profiles) {
      for (const group of profileModelGroups(profile)) {
        for (const model of group.models) {
          const key = `${profile.id}\u0000${group.groupId ?? ''}\u0000${model}`
          const price = prices[`${profile.id}:${group.groupId ?? ''}:${model}`]
          out.push({
            key,
            profileId: profile.id,
            ...(group.groupId ? { groupId: group.groupId } : {}),
            model,
            account: profile.name,
            group: group.name,
            tier: tierByKey.get(key) ?? tierOf(price),
            ...(price ? { price } : {}),
          })
        }
      }
    }
    return out
  }, [profiles, routing.candidates, prices])

  const update = (patch: Partial<DivisionRoutingSettings>) => {
    const next: DivisionRoutingSettings = { ...division, ...patch }
    const hasAny =
      next.planner ||
      next.executor ||
      next.reviewer ||
      (next.domains && next.domains.length > 0) ||
      next.learned?.length
    onChange({
      ...routing,
      ...(hasAny || Object.keys(next).length > 1 ? { division: next } : { division: undefined }),
    })
  }

  const setRole = (role: RouteRole, key: string) => {
    const assignment = parseAssignment(rows, key)
    update({
      ...(role === 'planner' ? { planner: assignment } : {}),
      ...(role === 'executor' ? { executor: assignment } : {}),
      ...(role === 'reviewer' ? { reviewer: assignment } : {}),
    })
  }

  const setDomain = (domain: RouteDomain, key: string) => {
    const current = division.domains ?? []
    if (!key) {
      update({ domains: current.filter((item) => item.domain !== domain) })
      return
    }
    const assignment = parseAssignment(rows, key)
    if (!assignment) return
    const existing = current.find((item) => item.domain === domain)
    const next = current.filter((item) => item.domain !== domain)
    next.push({
      ...assignment,
      domain,
      minComplexity: existing?.minComplexity ?? 55,
      ...(existing?.note ? { note: existing.note } : {}),
    })
    update({ domains: next })
  }

  const patchDomain = (domain: RouteDomain, patch: { minComplexity?: number; note?: string }) => {
    const next = (division.domains ?? []).map((item) =>
      item.domain === domain ? { ...item, ...patch } : item,
    )
    update({ domains: next })
  }

  const preset = (kind: 'cost' | 'quality' | 'frontend') => {
    if (rows.length === 0) {
      setPreview('还没有可用模型，先在账号与模型里添加。')
      return
    }
    const score = (row: Row) => (row.price ? row.price.input + row.price.output : row.tier === 'power' ? 20 : row.tier === 'fast' ? 1 : 5)
    const sorted = [...rows].sort((a, b) => score(a) - score(b))
    const cheapest = sorted[0]
    const strongest = sorted[sorted.length - 1]
    const balanced = sorted[Math.floor(sorted.length / 2)]
    const frontend = rows.find((row) => /kimi|moonshot/i.test(row.model))
    const planner = strongest
    const executor = kind === 'quality' ? balanced : cheapest
    const domains = [...(division.domains ?? [])]
    const setDomainRow = (row: Row | undefined, minComplexity: number) => {
      if (!row) return
      const next = domains.filter((item) => item.domain !== 'ui')
      next.push({ ...row, domain: 'ui', minComplexity, note: /kimi|moonshot/i.test(row.model) ? '前端 UI 强项' : '前端' })
      return next
    }
    const uiRow = kind === 'frontend' ? frontend ?? strongest : frontend
    const nextDomains = setDomainRow(uiRow, kind === 'quality' ? 45 : kind === 'frontend' ? 55 : 70) ?? domains
    update({
      planner: {
        profileId: planner.profileId,
        ...(planner.groupId ? { groupId: planner.groupId } : {}),
        model: planner.model,
        tier: planner.tier,
      },
      executor: {
        profileId: executor.profileId,
        ...(executor.groupId ? { groupId: executor.groupId } : {}),
        model: executor.model,
        tier: executor.tier,
      },
      reviewer: {
        profileId: planner.profileId,
        ...(planner.groupId ? { groupId: planner.groupId } : {}),
        model: planner.model,
        tier: planner.tier,
      },
      domains: nextDomains,
      planThreshold: kind === 'quality' ? 40 : 55,
    })
    setPreview(
      `已填充：规划 ${planner.model} · 执行 ${executor.model}` +
        (kind === 'frontend' && !frontend ? '（没有找到 kimi/moonshot，前端映射用最强模型）' : ''),
    )
  }

  const confirm = (division.confirm ?? 'expensive') as DivisionConfirm
  return (
    <section data-setting-id="routing.division" className="settings-item space-y-3 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <GitFork size={14} className="shrink-0 text-text-tertiary" />
        <span className="text-[13px] font-medium text-text">多代理协作</span>
        <span className="text-[12px] text-muted">主会话模型不变，Task 子代理执行</span>
        <span className="flex-1" />
        {saving && (
          <span className="flex items-center gap-1 text-[12px] text-muted">
            <Loader2 size={12} className="animate-spin" /> 保存中…
          </span>
        )}
      </div>
      <p className="text-[12px] leading-4 text-muted">
        默认单代理；只有多步机械子任务或命中领域专长时才多代理协作。低成本的机械任务整单交给执行者，主会话只看摘要。
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Wand2 size={13} className="text-text-tertiary" />
        <Button size="sm" variant="secondary" disabled={saving || loading} onClick={() => preset('cost')}>
          省钱优先
        </Button>
        <Button size="sm" variant="secondary" disabled={saving || loading} onClick={() => preset('quality')}>
          质量优先
        </Button>
        <Button size="sm" variant="secondary" disabled={saving || loading} onClick={() => preset('frontend')}>
          前端专项
        </Button>
        {preview && <span className="text-[12px] text-muted">{preview}</span>}
      </div>

      <div className="grid gap-1.5">
        {ROLE_ROWS.map((item) => (
          <div key={item.role} className="flex flex-wrap items-center gap-2 rounded-md border border-border/70 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-text">{item.label}</div>
              <div className="text-[12px] text-muted">{item.hint}</div>
            </div>
            <div className="w-[220px] max-w-full shrink-0">
              <Select
                size="sm"
                value={assignmentKey(item.role === 'planner' ? division.planner : item.role === 'executor' ? division.executor : division.reviewer)}
                disabled={saving || loading}
                onChange={(event) => setRole(item.role, event.target.value)}
                aria-label={`${item.label}模型`}
              >
                <option value="">自动（最便宜/最强）</option>
                {rows.map((row) => (
                  <option key={row.key} value={row.key}>
                    {row.account} › {row.group} › {row.model} · {priceText(row.price)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[13px] font-medium text-text">领域专长</span>
          <span className="text-[12px] text-muted">仅当领域匹配且复杂度达到门槛时使用</span>
        </div>
        <div className="overflow-hidden rounded-md border border-border/70">
          <div className="grid grid-cols-[80px_minmax(0,1fr)_70px_120px_90px] gap-2 border-b border-border/70 bg-[var(--t-bg-hover)] px-2 py-1 text-[12px] text-muted max-sm:grid-cols-[72px_minmax(0,1fr)_64px]">
            <span>领域</span>
            <span>模型</span>
            <span className="max-sm:hidden">门槛</span>
            <span className="max-sm:hidden">专长说明</span>
            <span className="max-sm:hidden">单价</span>
          </div>
          {DOMAINS.map((domain) => {
            const route = division.domains?.find((item) => item.domain === domain.value)
            const row = route ? rows.find((item) => assignmentKey(route) === item.key) : undefined
            return (
              <div
                key={domain.value}
                className="grid grid-cols-[80px_minmax(0,1fr)_70px_120px_90px] items-center gap-2 border-b border-border/50 px-2 py-1 last:border-b-0 max-sm:grid-cols-[72px_minmax(0,1fr)_64px]"
              >
                <span className="text-[13px] text-text-soft">{domain.label}</span>
                <Select
                  size="sm"
                  value={assignmentKey(route)}
                  disabled={saving || loading}
                  onChange={(event) => setDomain(domain.value, event.target.value)}
                  aria-label={`${domain.label}专长模型`}
                >
                  <option value="">不启用</option>
                  {rows.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.model} · {priceText(item.price)}
                    </option>
                  ))}
                </Select>
                <Input
                  size="sm"
                  type="number"
                  min={0}
                  max={100}
                  value={route?.minComplexity ?? 55}
                  disabled={!route || saving}
                  onChange={(event) => patchDomain(domain.value, { minComplexity: Number(event.target.value) })}
                  aria-label={`${domain.label}最低复杂度`}
                  className="max-sm:hidden"
                />
                <Input
                  size="sm"
                  value={route?.note ?? ''}
                  disabled={!route || saving}
                  placeholder={domain.placeholder}
                  onChange={(event) => patchDomain(domain.value, { note: event.target.value })}
                  aria-label={`${domain.label}专长说明`}
                  className="max-sm:col-span-2"
                />
                <span className="truncate font-mono text-[12px] text-muted max-sm:hidden">
                  {priceText(row?.price)}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2 text-[13px] text-text">
          进入多代理协作的最低复杂度
          <Input
            size="sm"
            type="number"
            min={0}
            max={100}
            value={division.planThreshold ?? 55}
            disabled={saving}
            onChange={(event) => update({ planThreshold: Number(event.target.value) })}
            className="w-20"
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-[13px] text-text">
          每轮成本上限（$，0=关）
          <Input
            size="sm"
            type="number"
            min={0}
            step="0.01"
            value={division.costCapUsdPerTurn ?? 0}
            disabled={saving}
            onChange={(event) =>
              update({ costCapUsdPerTurn: Number(event.target.value) > 0 ? Number(event.target.value) : undefined })
            }
            className="w-24"
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-[13px] text-text">
          多代理协作前确认
          <Select
            size="sm"
            value={confirm}
            disabled={saving}
            onChange={(event) => update({ confirm: event.target.value as DivisionConfirm })}
            className="w-[130px]"
          >
            <option value="never">从不</option>
            <option value="expensive">仅贵时</option>
            <option value="always">总是</option>
          </Select>
        </label>
        <label className="flex items-center justify-between gap-2 text-[13px] text-text">
          贵时阈值（$）
          <Input
            size="sm"
            type="number"
            min={0}
            step="0.01"
            value={division.confirmOverUsd ?? 0.05}
            disabled={saving || confirm !== 'expensive'}
            onChange={(event) => update({ confirmOverUsd: Number(event.target.value) })}
            className="w-24"
          />
        </label>
      </div>

      {(division.learned?.length ?? 0) > 0 && (
        <div className="rounded-md border border-border/70 px-2 py-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-text">学到的偏好</span>
            <span className="text-[12px] text-muted">同类任务被手动改过的次数</span>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => update({ learned: [] })}>
              清空
            </Button>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {division.learned!.map((item) => (
              <span
                key={`${item.key}:${item.mode}`}
                className={cn(
                  'rounded bg-[var(--t-bg-hover)] px-1.5 py-0.5 text-[12px] text-text-soft',
                  item.mode === 'direct' && 'text-text',
                )}
              >
                {item.domain} · {ROUTE_MODE_META[item.mode].label} × {item.count}
              </span>
            ))}
          </div>
        </div>
      )}
      <p className="text-[12px] leading-4 text-muted">
        提示：主会话模型始终不变，缓存保持热；子代理只收到自包含任务与必要文件。预计花费按执行模型单价粗估。
      </p>
    </section>
  )
}
