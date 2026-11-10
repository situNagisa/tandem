import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  HostSettings,
  ModelRoutingSettings,
  ModelTier,
  ModelPriceInfo,
  Profile,
  RouteCandidate,
  RoutePreference,
} from '@tandem/protocol'
import { Check, GitFork, Sparkles, TriangleAlert, X } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { SettingRow } from '../ui/SettingRow'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { cn } from '../../lib/cn'
import { profileModelGroups } from '../../lib/profileModels'
import { rememberRouteBias } from '../../lib/routeBias'
import { Button } from '../ui/Button'
import { SegmentedControl, Select, Switch } from '../ui/Controls'
import { Menu } from '../ui/Menu'
import { ModelCascade, modelPickKey } from '../ui/ModelCascade'
import { DivisionRoutingSection } from './DivisionRoutingSection'

const TIER_LABEL: Record<ModelTier, string> = {
  fast: '快速（省钱）',
  balanced: '均衡',
  power: '强力（质量）',
}

const PREFERENCE_OPTIONS: Array<{ value: RoutePreference; label: string; title: string }> = [
  { value: 'cost', label: '省钱', title: '更多任务走快速档，只在明显困难时升级' },
  { value: 'balanced', label: '均衡', title: '默认档位，简单任务省钱，复杂任务自动升级' },
  { value: 'quality', label: '质量优先', title: '更多任务走强档，只在很简单的任务上省钱' },
]

interface CandidateRow {
  key: string
  profileId: string
  groupId?: string
  model: string
  account: string
  group: string
  defaultModel: boolean
}

function rowsOf(profiles: Profile[]): CandidateRow[] {
  const rows: CandidateRow[] = []
  for (const profile of profiles) {
    const groups = profileModelGroups(profile)
    for (const group of groups) {
      for (const model of group.models) {
        rows.push({
          key: `${profile.id}\u0000${group.groupId ?? ''}\u0000${model}`,
          profileId: profile.id,
          ...(group.groupId ? { groupId: group.groupId } : {}),
          model,
          account: profile.name,
          group: group.name,
          defaultModel:
            model === (group.groupId
              ? profile.groups?.find((item) => item.id === group.groupId)?.defaultModel
              : profile.defaultModel),
        })
      }
    }
  }
  return rows
}

function normalize(settings: HostSettings | null): ModelRoutingSettings {
  return (
    settings?.modelRouting ?? {
      candidates: [],
      preference: 'balanced',
    }
  )
}

export function ModelRoutingSection() {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const runtime = useAppStore((s) => (host ? s.runtimes[host.id] : undefined))
  const profiles = runtime?.profiles ?? []
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const [settings, setSettings] = useState<HostSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prices, setPrices] = useState<Record<string, ModelPriceInfo>>({})
  const saveSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setSettings(null)
    if (!host) {
      setLoading(false)
      return
    }
    api
      .settings(host)
      .then((next) => {
        if (!cancelled) setSettings(next)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host?.id])

  useEffect(() => {
    if (!host) return
    if (!runtime?.profilesLoaded && !runtime?.profilesLoading) {
      void refreshProfiles(host.id)
    }
  }, [host?.id, runtime?.profilesLoaded, runtime?.profilesLoading, refreshProfiles])

  useEffect(() => {
    if (!host || profiles.length === 0) return
    let cancelled = false
    const groups: Array<{ profileId: string; groupId?: string }> = []
    for (const profile of profiles) {
      for (const group of profileModelGroups(profile)) {
        groups.push({ profileId: profile.id, ...(group.groupId ? { groupId: group.groupId } : {}) })
      }
    }
    Promise.allSettled(
      groups.map((group) =>
        api.modelPrices(host, group.profileId, group.groupId).then((res) => ({
          group,
          prices: res.prices,
        })),
      ),
    ).then((results) => {
      if (cancelled) return
      const next: Record<string, ModelPriceInfo> = {}
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        for (const [model, price] of Object.entries(result.value.prices)) {
          next[`${result.value.group.profileId}:${result.value.group.groupId ?? ''}:${model}`] = price
        }
      }
      setPrices(next)
    })
    return () => {
      cancelled = true
    }
  }, [host?.id, profiles])

  const routing = normalize(settings)
  const rows = useMemo(() => rowsOf(profiles), [profiles])
  const tierByKey = useMemo(() => {
    const map = new Map<string, ModelTier>()
    for (const item of routing.candidates) {
      map.set(`${item.profileId}\u0000${item.groupId ?? ''}\u0000${item.model}`, item.tier)
    }
    return map
  }, [routing.candidates])
  const selectedKeys = useMemo(
    () =>
      new Set(
        routing.candidates.map((item) =>
          modelPickKey({
            profileId: item.profileId,
            ...(item.groupId ? { groupId: item.groupId } : {}),
            model: item.model,
          }),
        ),
      ),
    [routing.candidates],
  )

  const persist = (next: ModelRoutingSettings) => {
    if (!host || !settings) return
    const previous = settings
    const seq = ++saveSeq.current
    const payload: HostSettings = {
      ...settings,
      modelRouting: next,
    }
    setSettings(payload)
    setSaving(true)
    setError(null)
    api
      .updateSettings(host, payload)
      .then((saved) => {
        // 连续点击时只认最后一次保存的响应，避免旧响应把新选择覆盖回去。
        if (seq === saveSeq.current) {
          setSettings(saved)
          if (saved.modelRouting) rememberRouteBias(host.id, saved.modelRouting.preference)
        }
      })
      .catch((err: Error) => {
        if (seq === saveSeq.current) {
          setSettings(previous)
          setError(err.message || '保存失败')
        }
      })
      .finally(() => {
        if (seq === saveSeq.current) setSaving(false)
      })
  }

  const toggle = (row: CandidateRow, checked: boolean) => {
    const candidates: RouteCandidate[] = checked
      ? [
          ...routing.candidates,
          {
            profileId: row.profileId,
            ...(row.groupId ? { groupId: row.groupId } : {}),
            model: row.model,
            tier: 'balanced',
          },
        ]
      : routing.candidates.filter(
          (item) =>
            !(
              item.profileId === row.profileId &&
              (item.groupId ?? '') === (row.groupId ?? '') &&
              item.model === row.model
            ),
        )
    persist({ ...routing, candidates })
  }

  const setTier = (row: CandidateRow, tier: ModelTier) => {
    const candidates = routing.candidates.map((item) =>
      item.profileId === row.profileId &&
      (item.groupId ?? '') === (row.groupId ?? '') &&
      item.model === row.model
        ? { ...item, tier }
        : item,
    )
    persist({ ...routing, candidates })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-[12px] leading-5 text-muted">
        <GitFork size={14} className="mt-0.5 shrink-0" />
        <p>
          开启「自动」或「分工」后，每轮按消息难度、上下文、失败情况与预算选择模型；分工模式主会话不换模型，机械子任务交给执行者。
          简单任务走快速档，连续失败自动升级，连续 3 轮简单成功回落。路由完全在本机完成。
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft/40 px-3 py-2 text-[12px] text-danger">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <section data-setting-id="routing.preference" className="settings-item space-y-1 px-3 py-1">
        <SettingRow
          label="取向默认"
          hint="影响档位阈值；预算将尽时会进一步向快速档倾斜。"
        >
          <SegmentedControl
            value={routing.preference}
            options={PREFERENCE_OPTIONS.map(({ value, label }) => ({ value, label }))}
            onChange={(value) => persist({ ...routing, preference: value })}
            aria-label="取向默认"
          />
        </SettingRow>
        <SettingRow
          label="用小模型判断难度"
          hint="每轮额外发一次很小的请求（默认关闭）；失败或超时按规则打分。"
        >
          <Switch
            checked={routing.judge === true}
            onChange={(on) => persist({ ...routing, judge: on })}
            label="用小模型判断难度"
            disabled={saving}
          />
        </SettingRow>
      </section>

      <DivisionRoutingSection
        routing={routing}
        profiles={profiles}
        prices={prices}
        loading={loading}
        saving={saving}
        onChange={persist}
      />

      <section data-setting-id="routing.candidates" className="settings-item space-y-2 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Sparkles size={14} className="shrink-0 text-text-tertiary" />
          <span className="text-[13px] font-medium text-text">候选池</span>
          <span className="text-[12px] text-muted">
            已选 {routing.candidates.length} 个
          </span>
          <span className="flex-1" />
          {saving && (
            <span className="flex items-center gap-1 text-[12px] text-muted">
              <Spinner size={12} /> 保存中…
            </span>
          )}
        </div>
        <p className="text-[12px] leading-4 text-muted">
          从已有账号 › 分组 › 模型中勾选，并标注档位。未配置候选池时，「自动」会回退到会话当前模型。
        </p>
        {loading && (
          <div className="flex items-center gap-2 py-3 text-[12px] text-muted">
            <Spinner size={13} /> 加载设置…
          </div>
        )}
        {!loading && profiles.length === 0 && (
          <p className="py-2 text-[12px] text-muted">还没有配置账号，先到「账号与模型」添加。</p>
        )}
        {!loading && profiles.length > 0 && rows.length === 0 && (
          <p className="py-2 text-[12px] text-muted">账号里还没有模型。</p>
        )}
        {!loading && rows.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Menu
                side="bottom"
                align="start"
                aria-label="添加候选模型"
                className="w-[min(420px,calc(100vw-1rem))]"
                trigger={({ open }) => (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-expanded={open}
                    aria-haspopup="menu"
                  >
                    添加候选模型…
                  </Button>
                )}
              >
                <ModelCascade
                  mode="check"
                  profiles={profiles}
                  selectedKeys={selectedKeys}
                  emptyText="账号里还没有模型。"
                  onToggle={(pick, checked) => {
                    const row = rows.find((item) => item.key === modelPickKey(pick))
                    if (row) toggle(row, checked)
                  }}
                />
              </Menu>
              <span className="text-[12px] text-muted">按账号 › 分组 › 模型逐级选择；勾选后可调整档位。</span>
            </div>
            {routing.candidates.length === 0 ? (
              <p className="py-1 text-[12px] text-muted">
                还没有候选模型；不配置时「自动」回退到会话当前模型。
              </p>
            ) : (
              <div className="space-y-1">
                {routing.candidates.map((candidate) => {
                  const row = rows.find(
                    (item) =>
                      item.key ===
                      modelPickKey({
                        profileId: candidate.profileId,
                        ...(candidate.groupId ? { groupId: candidate.groupId } : {}),
                        model: candidate.model,
                      }),
                  )
                  if (!row) return null
                  const tier = tierByKey.get(row.key) ?? candidate.tier
                  return (
                    <div
                      key={row.key}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border/70 px-2 py-1.5"
                    >
                      <Check size={12} className="shrink-0 text-text-secondary" />
                      <span
                        className="min-w-0 flex-1 truncate text-[13px] text-text-soft"
                        data-tip={`${row.account} › ${row.group} › ${row.model}`}
                      >
                        <span className="text-text">{row.account}</span>
                        <span className="text-muted"> › {row.group} › </span>
                        <span className="font-mono text-[12px]">{row.model}</span>
                      </span>
                      {row.defaultModel && (
                        <span className="shrink-0 rounded bg-[var(--t-bg-active)] px-1 text-[11px] text-text-secondary">
                          默认
                        </span>
                      )}
                      <div className="w-[132px] shrink-0">
                        <Select
                          size="sm"
                          value={tier}
                          disabled={saving}
                          onChange={(e) => setTier(row, e.target.value as ModelTier)}
                          aria-label={`${row.model} 档位`}
                        >
                          {(Object.keys(TIER_LABEL) as ModelTier[]).map((value) => (
                            <option key={value} value={value}>
                              {TIER_LABEL[value]}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`移除 ${row.model}`}
                        onClick={() => toggle(row, false)}
                      >
                        <X size={12} />
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </section>

      <section data-setting-id="routing.judge" className="px-3 text-[12px] leading-5 text-muted">
        每次切换模型会在会话里插入一行低调提示，hover 可看打分明细；右栏用量卡统计自动路由节省。
      </section>
    </div>
  )
}
