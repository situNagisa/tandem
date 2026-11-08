import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Check,
  Copy,
  Gauge,
  KeyRound,
  Loader2,
  Network,
  RefreshCw,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react'
import type {
  GatewayMemberUsage,
  GatewayModelRoute,
  GatewayOverview,
  GatewaySettings,
  GatewayToken,
} from '@tandem/protocol'
import { api } from '../../lib/api'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { copyText } from '../../lib/clipboard'
import { formatCost, formatTokens } from '../../lib/format'
import { Button, IconButton } from '../ui/Button'
import { Input, Switch } from '../ui/Controls'
import { MenuSelect } from '../ui/Menu'
import { Modal } from '../ui/Modal'

function formatTime(ts?: number): string {
  if (!ts) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(ts)
}

function formatLimit(value?: number): string {
  return value ? formatCost(value) : '不限'
}

interface TokenDraft {
  id?: string
  memberId: string
  memberName?: string
  daily: string
  monthly: string
  rpm: string
  models: string
}

const EMPTY_DRAFT: TokenDraft = { memberId: '', daily: '', monthly: '', rpm: '60', models: '' }

export function GatewaySection() {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === s.activeHostId) ?? null)
  const runtime = useAppStore((s) => (s.activeHostId ? s.runtimes[s.activeHostId] : undefined))
  const refreshProfiles = useAppStore((s) => s.refreshProfiles)
  const toast = useUiStore((s) => s.toast)

  const [overview, setOverview] = useState<GatewayOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tokenModal, setTokenModal] = useState<TokenDraft | null>(null)
  const [issuedToken, setIssuedToken] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<GatewayToken | null>(null)
  const [routeDraft, setRouteDraft] = useState({ profileId: '', groupId: '', model: '' })
  const [copied, setCopied] = useState(false)

  const profiles = runtime?.profiles ?? []
  const settings = overview?.settings ?? null
  const members = overview?.usage ?? []

  const load = async (spinner: boolean) => {
    if (!host) return
    if (spinner) setLoading(true)
    try {
      const next = await api.gateway(host)
      setOverview(next)
      setError(null)
    } catch (err) {
      if (spinner) setError(err instanceof Error ? err.message : '读取网关设置失败')
    } finally {
      if (spinner) setLoading(false)
    }
  }

  useEffect(() => {
    setOverview(null)
    setLoading(true)
    setError(null)
    setRouteDraft({ profileId: '', groupId: '', model: '' })
    if (!host) return
    void load(true)
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      void load(false)
    }, 5000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id])

  useEffect(() => {
    if (!host) return
    const rt = useAppStore.getState().runtimes[host.id]
    if (!rt?.profilesLoaded && !rt?.profilesLoading) void refreshProfiles(host.id)
  }, [host, refreshProfiles])

  const saveSettings = async (next: GatewaySettings) => {
    if (!host || !overview || saving) return
    const previous = overview
    setOverview({ ...overview, settings: next })
    setSaving(true)
    setError(null)
    try {
      const saved = await api.updateGatewaySettings(host, next)
      setOverview((current) => (current ? { ...current, settings: saved } : current))
    } catch (err) {
      setOverview(previous)
      setError(err instanceof Error ? err.message : '保存网关设置失败')
      toast(err instanceof Error ? err.message : '保存网关设置失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const draftProfile = profiles.find((p) => p.id === routeDraft.profileId)
  const draftGroup = draftProfile?.groups?.find((g) => g.id === routeDraft.groupId)
  const draftModels = draftGroup?.models?.length
    ? draftGroup.models
    : draftProfile?.models?.length
      ? draftProfile.models
      : draftProfile
        ? [draftProfile.defaultModel].filter(Boolean)
        : []

  const addRoute = () => {
    if (!overview || !draftProfile || !routeDraft.model) return
    const route: GatewayModelRoute = {
      id: crypto.randomUUID(),
      profileId: draftProfile.id,
      ...(draftGroup ? { groupId: draftGroup.id } : {}),
      models: [routeDraft.model],
    }
    // 同一账号/分组/模型的重复路由合并到一条
    const existing = overview.settings.routes.find(
      (item) =>
        item.profileId === route.profileId &&
        (item.groupId ?? '') === (route.groupId ?? '') &&
        item.models.includes(routeDraft.model!),
    )
    const routes = existing
      ? overview.settings.routes
      : [...overview.settings.routes, route]
    void saveSettings({ ...overview.settings, routes })
    setRouteDraft((current) => ({ ...current, model: '' }))
  }

  const removeRoute = (id: string) => {
    if (!overview) return
    void saveSettings({
      ...overview.settings,
      routes: overview.settings.routes.filter((route) => route.id !== id),
    })
  }

  const openIssue = () => {
    setIssuedToken(null)
    setCopied(false)
    setTokenModal({ ...EMPTY_DRAFT, memberId: members[0]?.memberId ?? '' })
  }

  const openEdit = (token: GatewayToken) => {
    setIssuedToken(null)
    setCopied(false)
    setTokenModal({
      id: token.id,
      memberId: token.memberId,
      memberName: token.memberName,
      daily: token.dailyLimitUsd ? String(token.dailyLimitUsd) : '',
      monthly: token.monthlyLimitUsd ? String(token.monthlyLimitUsd) : '',
      rpm: String(token.rpm),
      models: token.allowedModels.join(', '),
    })
  }

  const submitToken = async () => {
    if (!host || !tokenModal) return
    const models = tokenModal.models
      .split(/[,，\s]+/)
      .map((m) => m.trim())
      .filter(Boolean)
    const daily = tokenModal.daily.trim() ? Number(tokenModal.daily) : undefined
    const monthly = tokenModal.monthly.trim() ? Number(tokenModal.monthly) : undefined
    try {
      if (tokenModal.id) {
        await api.updateGatewayToken(host, tokenModal.id, {
          dailyLimitUsd: daily ?? null,
          monthlyLimitUsd: monthly ?? null,
          rpm: tokenModal.rpm.trim() ? Number(tokenModal.rpm) : 60,
          allowedModels: models,
        })
        toast('令牌限额已更新', 'success')
        setTokenModal(null)
      } else {
        if (!tokenModal.memberId) {
          toast('请选择成员', 'error')
          return
        }
        const result = await api.issueGatewayToken(host, {
          memberId: tokenModal.memberId,
          ...(daily !== undefined ? { dailyLimitUsd: daily } : {}),
          ...(monthly !== undefined ? { monthlyLimitUsd: monthly } : {}),
          rpm: tokenModal.rpm.trim() ? Number(tokenModal.rpm) : 60,
          allowedModels: models,
        })
        setIssuedToken(result.token)
        toast('网关令牌已签发', 'success')
      }
      await load(false)
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存令牌失败', 'error')
    }
  }

  const revoke = async () => {
    if (!host || !revokeTarget) return
    try {
      await api.revokeGatewayToken(host, revokeTarget.id)
      toast('令牌已吊销', 'success')
      setRevokeTarget(null)
      await load(false)
    } catch (err) {
      toast(err instanceof Error ? err.message : '吊销失败', 'error')
    }
  }

  const copyToken = async () => {
    if (!issuedToken) return
    await copyText(issuedToken)
    setCopied(true)
  }

  const routeName = (route: GatewayModelRoute) => {
    const profile = profiles.find((p) => p.id === route.profileId)
    const group = profile?.groups?.find((g) => g.id === route.groupId)
    return {
      account: profile?.name ?? route.profileId,
      group: group?.name ?? (route.groupId ? route.groupId : '账号自身'),
    }
  }

  const memberOptions = useMemo(
    () => members.map((member) => ({ value: member.memberId, label: member.memberName })),
    [members],
  )

  if (!host) {
    return (
      <div className="settings-empty">
        <span className="settings-empty-icon"><Network size={17} /></span>
        <p className="settings-empty-title">还没有连接主机</p>
        <p className="settings-empty-hint">先添加一台主机，再开启网关模式。</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold">网关</h3>
        <span className="text-[13px] text-muted">成员共用一个入口，Key 不离开这台主机</span>
        <span className="flex-1" />
        <IconButton
          onClick={() => void load(true)}
          disabled={loading}
          label="刷新网关状态"
          tooltip="刷新"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </IconButton>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-danger/25 bg-danger-soft/50 px-2.5 py-2 text-[13px] text-danger">
          <TriangleAlert size={12} /> {error}
        </div>
      )}

      <section data-setting-id="gateway.mode" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-muted"><Network size={16} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-[13px] font-medium">网关模式</h4>
              <Switch
                checked={!!settings?.enabled}
                onChange={(enabled) => settings && void saveSettings({ ...settings, enabled })}
                disabled={!settings || saving || loading}
                label="开启网关模式"
              />
              <span className="text-[12px] text-muted">{settings?.enabled ? '运行中' : '默认关闭'}</span>
            </div>
            <p className="mt-1 break-words text-[13px] leading-5 text-muted">
              开启后，内网成员可用网关令牌调用 <code className="break-all font-mono text-[12px]">/gateway/v1/chat/completions</code>、
              <code className="break-all font-mono text-[12px]">/gateway/v1/messages</code> 与 <code className="break-all font-mono text-[12px]">/gateway/v1/models</code>；
              网关按模型转发到本机账号分组，统一限流、记账，调用者拿不到真实 Key。
            </p>
            {settings?.enabled && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft/40 px-2.5 py-2 text-[13px] leading-5 text-text-soft">
                <ShieldAlert size={13} className="mt-0.5 shrink-0 text-warning" />
                <span>
                  仅在可信内网开启：接口是 HTTP 明文，令牌等同于调用权限。不要做端口映射或公网暴露；成员离职或设备丢失时立即吊销令牌。
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section data-setting-id="gateway.routing" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <Gauge size={15} className="text-muted" />
          <h4 className="text-[13px] font-medium">模型转发</h4>
          <span className="text-[12px] text-muted">请求里的 model → 本机账号 › 分组</span>
          <span className="flex-1" />
        </div>
        {settings?.routes.length ? (
          <div className="mt-2 space-y-1">
            {settings.routes.map((route) => {
              const names = routeName(route)
              return (
                <div key={route.id} className="flex items-center gap-2 rounded-lg bg-bg/40 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate font-mono text-[13px] text-text">{route.models.join('、')}</span>
                      <span className="shrink-0 rounded border border-border px-1 text-[12px] text-muted">
                        {names.account} / {names.group}
                      </span>
                    </span>
                  </span>
                  <IconButton
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => removeRoute(route.id)}
                    label={`删除模型转发 ${route.models.join('、')}`}
                    className="size-7 [&_svg]:size-[11px]"
                  >
                    <Trash2 size={11} />
                  </IconButton>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-muted">还没有路由。添加一条后成员才能通过网关调用模型。</p>
        )}

        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <MenuSelect
            value={routeDraft.profileId}
            onChange={(profileId) => setRouteDraft({ profileId, groupId: '', model: '' })}
            aria-label="路由账号"
            placeholder="选择账号"
            options={profiles
              .filter((p) => p.kind !== 'tandem-gateway')
              .map((p) => ({ value: p.id, label: p.name }))}
          />
          <MenuSelect
            value={routeDraft.groupId}
            onChange={(groupId) => setRouteDraft((current) => ({ ...current, groupId, model: '' }))}
            aria-label="路由分组"
            placeholder="账号自身"
            disabled={!draftProfile}
            options={[
              { value: '', label: '账号自身' },
              ...(draftProfile?.groups ?? []).map((g) => ({ value: g.id, label: g.name })),
            ]}
          />
          <MenuSelect
            value={routeDraft.model}
            onChange={(model) => setRouteDraft((current) => ({ ...current, model }))}
            aria-label="路由模型"
            placeholder="选择模型"
            disabled={!draftProfile || draftModels.length === 0}
            options={draftModels.map((model) => ({ value: model, label: model }))}
          />
          <Button
            onClick={addRoute}
            disabled={!draftProfile || !routeDraft.model || saving}
          >
            添加路由
          </Button>
        </div>
        {profiles.length === 0 && (
          <p className="mt-2 text-[12px] text-muted">先到「账号与模型」添加网关要使用的上游账号。</p>
        )}
      </section>

      <section data-setting-id="gateway.tokens" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <KeyRound size={15} className="text-muted" />
          <h4 className="text-[13px] font-medium">成员令牌</h4>
          <span className="text-[12px] text-muted">同一成员只保留一个有效令牌，重新签发会轮换</span>
          <span className="flex-1" />
          <Button size="sm" variant="primary" onClick={openIssue} disabled={members.length === 0}>
            签发令牌
          </Button>
        </div>
        {overview?.tokens.length ? (
          <div className="mt-2 space-y-1">
            {overview.tokens.map((token) => {
              const revoked = !!token.revokedAt
              return (
                <div key={token.id} className="rounded-lg bg-bg/40 px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">{token.memberName}</span>
                    <span
                      className={
                        revoked
                          ? 'rounded border border-border px-1 text-[12px] text-muted'
                          : 'rounded border border-success/30 bg-success-soft/40 px-1 text-[12px] text-success'
                      }
                    >
                      {revoked ? '已吊销' : '有效'}
                    </span>
                    <span className="text-[12px] text-muted">
                      {formatLimit(token.dailyLimitUsd)}/日 · {formatLimit(token.monthlyLimitUsd)}/月 · {token.rpm} RPM
                    </span>
                    <span className="flex-1" />
                    {!revoked && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(token)}>
                          限额
                        </Button>
                        <IconButton
                          size="sm"
                          variant="danger-ghost"
                          onClick={() => setRevokeTarget(token)}
                          label={`吊销 ${token.memberName} 的网关令牌`}
                          tooltip="吊销"
                          className="size-7 [&_svg]:size-[11px]"
                        >
                          <Trash2 size={11} />
                        </IconButton>
                      </>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-muted">
                    白名单：{token.allowedModels.length ? token.allowedModels.join('、') : '全部路由模型'} · 最近使用{' '}
                    {formatTime(token.lastUsedAt)} · 签发 {formatTime(token.createdAt)}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-muted">
            还没有令牌。先在「成员」页邀请同事，再回来签发。
          </p>
        )}
      </section>

      <section data-setting-id="gateway.stats" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Activity size={15} className="text-muted" />
          <h4 className="text-[13px] font-medium">今日统计</h4>
          <span className="text-[12px] text-muted">每 5 秒自动刷新 · 按成员</span>
          <span className="flex-1" />
          {loading && <Loader2 size={12} className="animate-spin text-muted" />}
        </div>
        {members.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted">还没有团队成员。</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <div className="min-w-[620px]">
              <div className="grid grid-cols-[minmax(0,1.2fr)_70px_90px_80px_80px_minmax(0,1.4fr)] gap-2 border-b border-border/70 pb-1 text-[12px] text-muted">
                <span>成员</span>
                <span className="text-right">请求</span>
                <span className="text-right">token</span>
                <span className="text-right">今日花费</span>
                <span className="text-right">本月</span>
                <span className="pl-2">限额 / 状态</span>
              </div>
              {members.map((member: GatewayMemberUsage) => {
                const overDaily = !!member.dailyLimitUsd && member.todayCostUsd >= member.dailyLimitUsd
                const overMonthly = !!member.monthlyLimitUsd && member.monthCostUsd >= member.monthlyLimitUsd
                return (
                  <div
                    key={member.memberId}
                    className="grid grid-cols-[minmax(0,1.2fr)_70px_90px_80px_80px_minmax(0,1.4fr)] items-center gap-2 border-b border-border/40 py-1.5 text-[13px] last:border-b-0"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Users size={12} className="shrink-0 text-muted" />
                      <span className="truncate">{member.memberName}</span>
                    </span>
                    <span className="text-right tabular-nums">{member.todayRequests}</span>
                    <span className="text-right tabular-nums">
                      {formatTokens(member.todayInputTokens + member.todayOutputTokens)}
                    </span>
                    <span className="text-right font-mono tabular-nums">{formatCost(member.todayCostUsd)}</span>
                    <span className="text-right font-mono tabular-nums">{formatCost(member.monthCostUsd)}</span>
                    <span className="flex min-w-0 items-center gap-1.5 pl-2 text-[12px]">
                      <span className="truncate text-muted">
                        {member.tokenCount ? `${formatLimit(member.dailyLimitUsd)}/日 · ${formatLimit(member.monthlyLimitUsd)}/月` : '未签发令牌'}
                      </span>
                      {overDaily || overMonthly ? (
                        <span className="shrink-0 rounded border border-danger/30 px-1 text-danger">超限</span>
                      ) : null}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>

      <section data-setting-id="gateway.logs" className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldAlert size={15} className="text-muted" />
          <h4 className="text-[13px] font-medium">日志与调试</h4>
          <span className="text-[12px] text-muted">日志只记时间、成员、模型、token、耗时、状态码</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-bg/40 px-2.5 py-2">
          <span className="min-w-0 flex-1 text-[13px]">
            调试正文
            <span className="ml-2 text-[12px] text-muted">
              临时记录请求/响应，自动脱敏，24 小时后删除；关闭时立即清空
            </span>
          </span>
          <span className="text-[12px] text-muted">{overview?.debugCount ?? 0} 条</span>
          <Switch
            checked={!!settings?.debugBodies}
            onChange={(debugBodies) => settings && void saveSettings({ ...settings, debugBodies })}
            disabled={!settings || saving}
            label="调试正文"
          />
        </div>
        {overview?.logs.length ? (
          <div className="mt-2 overflow-x-auto">
            <div className="min-w-[640px]">
              <div className="grid grid-cols-[78px_minmax(0,1fr)_minmax(0,1.2fr)_86px_76px_58px] gap-2 border-b border-border/70 pb-1 text-[12px] text-muted">
                <span>时间</span>
                <span>成员</span>
                <span>模型</span>
                <span className="text-right">token</span>
                <span className="text-right">耗时</span>
                <span className="text-right">状态</span>
              </div>
              {overview.logs.slice(0, 12).map((log, index) => (
                <div
                  key={`${log.at}-${index}`}
                  className="grid grid-cols-[78px_minmax(0,1fr)_minmax(0,1.2fr)_86px_76px_58px] gap-2 border-b border-border/40 py-1.5 text-[12px] last:border-b-0"
                >
                  <span className="font-mono text-muted">{new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                  <span className="truncate">{log.memberName ?? '—'}</span>
                  <span className="truncate font-mono" title={log.model}>{log.model}</span>
                  <span className="text-right tabular-nums">{formatTokens(log.inputTokens + log.outputTokens)}</span>
                  <span className="text-right tabular-nums">{Math.max(0, Math.round(log.durationMs))}ms</span>
                  <span
                    className={
                      log.status >= 200 && log.status < 300
                        ? 'text-right tabular-nums text-success'
                        : 'text-right tabular-nums text-danger'
                    }
                    title={log.error}
                  >
                    {log.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-muted">还没有网关请求。</p>
        )}
      </section>

      <p className="settings-note">
        网关仅转发到本机配置的模型账号；令牌与 Key 都不下发到成员设备。架构与威胁模型见 docs/features/gateway.md。
      </p>

      <Modal
        open={!!tokenModal}
        onClose={() => {
          setTokenModal(null)
          setIssuedToken(null)
        }}
        title={tokenModal?.id ? '编辑令牌限额' : '签发网关令牌'}
        className="max-w-lg"
        footer={
          issuedToken ? (
            <Button variant="primary" onClick={() => { setTokenModal(null); setIssuedToken(null) }}>
              完成
            </Button>
          ) : (
            <>
              <Button onClick={() => { setTokenModal(null); setIssuedToken(null) }}>取消</Button>
              <Button variant="primary" onClick={() => void submitToken()}>
                {tokenModal?.id ? '保存限额' : '签发'}
              </Button>
            </>
          )
        }
      >
        {issuedToken ? (
          <div className="space-y-3">
            <p className="text-[13px] leading-5 text-text-soft">
              令牌只显示这一次。复制后交给对应的成员，主机只保存哈希。
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg/50 px-2.5 py-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[12px]">{issuedToken}</code>
              <IconButton onClick={() => void copyToken()} label="复制网关令牌" tooltip="复制">
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </IconButton>
            </div>
            <p className="text-[12px] text-muted">
              成员的账号类型选「Tandem 网关」：地址填本机地址，Key 填这串令牌。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {tokenModal?.id ? (
              <div className="rounded-lg bg-bg/40 px-2.5 py-2 text-[13px]">
                成员：{tokenModal.memberName}
              </div>
            ) : (
              <div>
                <label className="settings-label">成员</label>
                <MenuSelect
                  value={tokenModal?.memberId ?? ''}
                  onChange={(memberId) => setTokenModal((current) => (current ? { ...current, memberId } : current))}
                  aria-label="选择成员"
                  placeholder="选择成员"
                  options={memberOptions}
                />
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <label className="settings-label">每日限额（美元）</label>
                <Input
                  value={tokenModal?.daily ?? ''}
                  onChange={(e) => setTokenModal((current) => (current ? { ...current, daily: e.target.value } : current))}
                  placeholder="不限"
                  inputMode="decimal"
                />
              </div>
              <div>
                <label className="settings-label">每月限额（美元）</label>
                <Input
                  value={tokenModal?.monthly ?? ''}
                  onChange={(e) => setTokenModal((current) => (current ? { ...current, monthly: e.target.value } : current))}
                  placeholder="不限"
                  inputMode="decimal"
                />
              </div>
              <div>
                <label className="settings-label">速率限制（RPM）</label>
                <Input
                  value={tokenModal?.rpm ?? '60'}
                  onChange={(e) => setTokenModal((current) => (current ? { ...current, rpm: e.target.value } : current))}
                  placeholder="60"
                  inputMode="numeric"
                />
              </div>
            </div>
            <div>
              <label className="settings-label">可用模型白名单</label>
              <Input
                value={tokenModal?.models ?? ''}
                onChange={(e) => setTokenModal((current) => (current ? { ...current, models: e.target.value } : current))}
                placeholder="留空表示路由里的全部模型；多个用逗号分隔"
              />
            </div>
            <p className="text-[12px] leading-5 text-muted">
              限额按网关记账的参考价累计（与「用量」页一致）。达到限额后请求返回 429 和可读提示；吊销令牌立即生效。
            </p>
          </div>
        )}
      </Modal>

      <Modal
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        title="吊销网关令牌"
        className="max-w-md"
        footer={
          <>
            <Button onClick={() => setRevokeTarget(null)}>取消</Button>
            <Button variant="danger-ghost" onClick={() => void revoke()}>
              吊销
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-6 text-text-soft">
          吊销「{revokeTarget?.memberName}」的网关令牌？之后用该令牌的请求会立即返回 401，需要重新签发才能继续使用。
        </p>
      </Modal>
    </div>
  )
}
