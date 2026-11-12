import { useEffect, useMemo, useRef } from 'react'
import type {
  DelegationStrategy,
  ModelPriceInfo,
  Profile,
  ReasoningEffort,
  RoutePreference,
} from '@tandem/protocol'
import { ChevronDown, Sparkles } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { cn } from '../../lib/cn'
import { EFFORT_LABEL } from '../../lib/effort'
import { prettyModel, shortModelName } from '../../lib/modelName'
import { groupName, profileModelGroups } from '../../lib/profileModels'
import { rankRecentModels } from '../../lib/recentModels'
import {
  DELEGATION_META,
  DELEGATION_ORDER,
  ROUTE_BIAS_META,
  ROUTE_BIAS_ORDER,
  delegationLabel,
  routeBiasLabel,
} from '../../lib/routeLabels'
import { Button } from '../ui/Button'
import { Menu } from '../ui/Menu'
import { ModelCascade } from '../ui/ModelCascade'

/** 参考单价：每百万 token 美元；只保留必要的小数位。 */
function priceText(price: ModelPriceInfo): string {
  const fmt = (value: number) => String(Number(value.toFixed(4)))
  const cache =
    price.cacheRead !== undefined && price.cacheRead > 0
      ? ` · 缓存 $${fmt(price.cacheRead)}`
      : ''
  const account = price.accountMultiplier ?? 1
  const group = price.groupMultiplier ?? 1
  const estimate = price.estimatedFrom ? `按 ${price.estimatedFrom} 估算 · ` : ''
  if (price.officialInput !== undefined && (account !== 1 || group !== 1)) {
    const factors = [`官方 $${fmt(price.officialInput)}/M`]
    if (account !== 1) factors.push(`账号 ${fmt(account)}`)
    if (group !== 1) factors.push(`分组 ${fmt(group)}`)
    return `${estimate}${factors.join(' × ')} = $${fmt(price.input)}/M · 输出 $${fmt(price.officialOutput ?? 0)}/M → $${fmt(price.output)}/M${cache}`
  }
  const prefix = price.source === 'builtin' ? '参考价 · ' : ''
  return `${prefix}${estimate}输入 $${fmt(price.input)} · 输出 $${fmt(price.output)} / 百万 tok${cache}`
}

interface ModelPanelProps {
  profiles: Profile[]
  profileId: string
  groupId?: string
  model: string
  autoRoute: boolean
  autoModel?: string
  prices?: Record<string, ModelPriceInfo>
  pricesLoading?: boolean
  effort?: ReasoningEffort
  efforts: ReasoningEffort[]
  /** 各档位在该模型厂商的原始叫法（来自服务端能力表）。 */
  effortLabels?: Partial<Record<ReasoningEffort, string>>
  /** 未显式选择时模型的官方默认档位。 */
  defaultEffort?: ReasoningEffort
  /** 该协议下思考强度是否真的生效的说明（如 OpenAI 兼容中转）。 */
  effortNote?: string
  /** 分工与取向：与模型设置放在同一个菜单里，选择即写入当前会话。 */
  delegation: DelegationStrategy
  routeBias: RoutePreference | undefined
  routeNative: boolean
  onDelegationChange: (strategy: DelegationStrategy) => void
  onRouteBiasChange: (bias: RoutePreference) => void
  onRouteNativeChange: (native: boolean) => void
  loading: boolean
  onSelect: (profileId: string, groupId: string | undefined, model: string) => void
  onSelectAuto: () => void
  onLoadPrices?: (profileId: string, groupId: string | undefined) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onManage: () => void
  /** 单价未设置：跳到该账号的单价覆盖设置。 */
  onSetupPrice: (model: string) => void
}

/**
 * 模型菜单的内容：主体（自动/分工 + 模型列表）与底部固定操作区分开渲染。
 * 行只有单行标题；模型 id、单价与说明都走 tooltip（用户第 5 轮反馈 #15/#17）。
 */
function useModelPanel({
  profiles,
  profileId,
  groupId,
  model,
  autoRoute,
  autoModel,
  prices,
  pricesLoading,
  effort,
  efforts,
  effortLabels,
  defaultEffort,
  effortNote,
  delegation,
  routeBias,
  routeNative,
  onDelegationChange,
  onRouteBiasChange,
  onRouteNativeChange,
  loading,
  onSelect,
  onSelectAuto,
  onLoadPrices,
  onEffortChange,
  onManage,
  onSetupPrice,
}: ModelPanelProps) {
  const currentProfile = profiles.find((p) => p.id === profileId) ?? profiles[0] ?? null
  const currentGroups = useMemo(
    () => (currentProfile ? profileModelGroups(currentProfile) : []),
    [currentProfile],
  )
  const currentGroup =
    currentGroups.find((group) => (group.groupId ?? undefined) === (groupId ?? undefined)) ??
    currentGroups[0]
  // 未选过或该型号不支持所存档位时，不假装选中某一档：显示模型官方默认。
  const selectedEffort = effort && efforts.includes(effort) ? effort : undefined
  const defaultEffortLabel = defaultEffort ? EFFORT_LABEL[defaultEffort] : undefined

  useEffect(() => {
    if (currentProfile) onLoadPrices?.(currentProfile.id, currentGroup?.groupId)
    // 只在账号/分组变化时加载，避免 prices 回调引用变化导致重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProfile?.id, currentGroup?.groupId])

  // 顶部只放最近使用 / 常用的模型（最多 6 个，可跨账号分组）；第一次使用时回退到当前分组。
  // 每次渲染重新读取 localStorage：记录发生在发送消息时，菜单再次打开要立刻反映。
  const recent = (() => {
    const ranked = rankRecentModels(profiles, 6)
    if (ranked.length > 0) return ranked
    if (!currentProfile || !currentGroup) return []
    return currentGroup.models.map((item) => ({
      profileId: currentProfile.id,
      ...(currentGroup.groupId ? { groupId: currentGroup.groupId } : {}),
      model: item,
      count: 1,
      lastUsedAt: 0,
    }))
  })()

  const currentPick = currentProfile
    ? {
        profileId: currentProfile.id,
        ...(currentGroup?.groupId ? { groupId: currentGroup.groupId } : {}),
        model,
      }
    : undefined

  const isCurrent = (pick: { profileId: string; groupId?: string; model: string }) =>
    !!currentPick &&
    pick.profileId === currentPick.profileId &&
    (pick.groupId ?? '') === (currentPick.groupId ?? '') &&
    pick.model === currentPick.model

  const body = (
    <>
      {loading && profiles.length === 0 && (
        <div className="flex h-[32px] items-center gap-2 px-2 text-[12px] text-muted">
          <Spinner size={13} /> 加载账号…
        </div>
      )}
      {!loading && profiles.length === 0 && (
        <div className="px-2 py-2 text-[12px] leading-5 text-muted">这台主机还没有配置账号。</div>
      )}
      {profiles.length > 0 && (
        <>
          <Menu.Item
            selected={autoRoute}
            textValue="自动"
            icon={<Sparkles size={12} />}
            onSelect={() => onSelectAuto()}
            hint={
              autoModel
                ? `当前 ${prettyModel(autoModel)} · 按本轮难度在「设置 → 自动路由」候选池中选择，失败自动升级`
                : '每轮按难度在「设置 → 自动路由」候选池中选择，失败自动升级、简单任务回落'
            }
          >
            自动
          </Menu.Item>
          <Menu.Separator />
        </>
      )}
      {profiles.length > 0 && recent.length === 0 && (
        <div className="px-2 py-2 text-[12px] leading-5 text-muted">没有可用模型。</div>
      )}
      {recent.map((pick) => {
        const profile = profiles.find((p) => p.id === pick.profileId)
        const groups = profile ? profileModelGroups(profile) : []
        const group = groups.find((item) => (item.groupId ?? '') === (pick.groupId ?? ''))
        const groupLabel = group?.name ?? profile?.name ?? ''
        const friendly = prettyModel(pick.model)
        const current = !autoRoute && isCurrent(pick)
        const price = isCurrent(pick) ? prices?.[pick.model] : undefined
        const hint = price
          ? `${pick.model} · ${priceText(price)}`
          : isCurrent(pick) && pricesLoading
            ? `${pick.model} · 单价读取中…`
            : `${pick.model} · ${profile?.name ?? ''}${groupLabel ? ` › ${groupLabel}` : ''}`
        return (
          <Menu.Item
            key={`${pick.profileId}:${pick.groupId ?? ''}:${pick.model}`}
            selected={current}
            textValue={`${friendly} ${groupLabel}`}
            hint={hint}
            onSelect={() => onSelect(pick.profileId, pick.groupId, pick.model)}
            trailing={
              isCurrent(pick) && !price && !pricesLoading ? (
                <button data-raw-button
                  type="button"
                  tabIndex={-1}
                  aria-label={`为 ${pick.model} 设置单价`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onSetupPrice(pick.model)
                  }}
                  className="pointer-events-none rounded px-0.5 text-[12px] text-muted opacity-0 outline-none transition-opacity duration-[120ms] hover:text-text group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                >
                  去设置
                </button>
              ) : undefined
            }
          >
            {friendly}
            {groupLabel ? <span className="ml-1 text-muted">· {groupLabel}</span> : null}
          </Menu.Item>
        )
      })}
    </>
  )

  const footer = (
    <>
      <Menu.CheckItem
        checked={routeNative}
        onCheckedChange={(checked) => onRouteNativeChange(checked)}
        hint="不注入分工与取向说明，模型照常拥有全部工具（含 Task），自己决定是否派子代理"
      >
        原生
      </Menu.CheckItem>
      <Menu.Sub>
        <Menu.SubTrigger
          trailing={delegationLabel(delegation)}
          hint={routeNative ? '原生模式下不生效' : '是否派子代理'}
        >
          分工
        </Menu.SubTrigger>
        <Menu.SubContent className="w-[220px]" aria-label="分工">
          {routeNative && <Menu.Label>原生模式下不生效</Menu.Label>}
          <Menu.RadioGroup
            value={delegation}
            onValueChange={(value) => onDelegationChange(value as DelegationStrategy)}
          >
            {DELEGATION_ORDER.map((value) => (
              <Menu.RadioItem
                key={value}
                value={value}
                hint={DELEGATION_META[value].hint}
                disabled={routeNative}
                disabledReason="原生模式下不生效"
              >
                {DELEGATION_META[value].label}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.SubContent>
      </Menu.Sub>
      <Menu.Sub>
        <Menu.SubTrigger
          trailing={routeBiasLabel(routeBias)}
          hint={routeNative ? '原生模式下不生效' : '执行者与子代理用什么模型'}
        >
          取向
        </Menu.SubTrigger>
        <Menu.SubContent className="w-[220px]" aria-label="取向">
          {routeNative && <Menu.Label>原生模式下不生效</Menu.Label>}
          <Menu.RadioGroup
            value={routeBias}
            onValueChange={(value) => onRouteBiasChange(value as RoutePreference)}
          >
            {ROUTE_BIAS_ORDER.map((value) => (
              <Menu.RadioItem
                key={value}
                value={value}
                hint={ROUTE_BIAS_META[value].hint}
                disabled={routeNative}
                disabledReason="原生模式下不生效"
              >
                {ROUTE_BIAS_META[value].label}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.SubContent>
      </Menu.Sub>
      {!autoRoute && efforts.length > 0 && (
        <Menu.Sub>
          <Menu.SubTrigger
            trailing={
              selectedEffort
                ? (effortLabels?.[selectedEffort] ?? EFFORT_LABEL[selectedEffort])
                : defaultEffortLabel
                  ? `默认（${defaultEffortLabel}）`
                  : '未指定'
            }
          >
            思考强度
          </Menu.SubTrigger>
          <Menu.SubContent className="w-[230px]" aria-label="思考强度">
            {!selectedEffort && defaultEffortLabel && (
              <Menu.Label>默认（{defaultEffortLabel}）· 未选时按模型官方默认</Menu.Label>
            )}
            <Menu.RadioGroup
              value={selectedEffort ?? ''}
              onValueChange={(next) => onEffortChange(next as ReasoningEffort)}
            >
              {efforts.map((value) => (
                <Menu.RadioItem key={value} value={value} hint="投入越高，回复越详尽，耗时与用量越多">
                  {effortLabels?.[value] ?? EFFORT_LABEL[value]}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            {effortNote && <Menu.Label>{effortNote}</Menu.Label>}
          </Menu.SubContent>
        </Menu.Sub>
      )}
      {profiles.length > 0 && (
        <Menu.Sub>
          <Menu.SubTrigger
            trailing={[currentProfile?.name, currentGroup?.groupId ? currentGroup.name : null]
              .filter(Boolean)
              .join(' › ')}
          >
            {profiles.length > 1
              ? '切换账号'
              : currentGroups.length > 1
                ? '切换分组'
                : '全部模型'}
          </Menu.SubTrigger>
          <Menu.SubContent className="min-w-[220px]" aria-label="切换账号">
            <ModelCascade
              mode="single"
              profiles={profiles}
              current={currentPick}
              onPick={(pick) => onSelect(pick.profileId, pick.groupId, pick.model)}
            />
          </Menu.SubContent>
        </Menu.Sub>
      )}
      <Menu.Item onSelect={onManage}>管理账号…</Menu.Item>
    </>
  )

  return { body, footer }
}

export function ModelMenu({
  profiles,
  profileId,
  groupId,
  model,
  autoRoute = false,
  autoModel,
  prices,
  pricesLoading,
  effort,
  efforts,
  effortLabels,
  defaultEffort,
  effortNote,
  delegation,
  routeBias,
  routeNative,
  onDelegationChange,
  onRouteBiasChange,
  onRouteNativeChange,
  loading,
  disabled,
  onSelect,
  onSelectAuto,
  onLoadPrices,
  onEffortChange,
  onManage,
  onSetupPrice,
  onOpen,
  open,
  onOpenChange,
  compact = false,
}: ModelPanelProps & {
  disabled?: boolean
  autoRoute?: boolean
  onSelectAuto: () => void
  onOpen?: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
  compact?: boolean
}) {
  const currentProfile = profiles.find((p) => p.id === profileId) ?? null
  const currentGroup = groupName(currentProfile ?? undefined, groupId)
  // 反馈14#02（R52 复发）：账号数据还没到就打开菜单，内容随后从占位变成列表，
  // 面板高度跳变、Radix 重新定位（向上生长）看起来就是抖一下；数据就绪后再打开。
  const pendingOpen = useRef(false)
  useEffect(() => {
    if (!loading && pendingOpen.current) {
      pendingOpen.current = false
      onOpenChange(true)
    }
  }, [loading, onOpenChange])
  const requestOpen = (next: boolean) => {
    if (next && loading && profiles.length === 0) {
      pendingOpen.current = true
      onOpen?.()
      return
    }
    onOpenChange(next)
  }
  const showEffort = !autoRoute && !!effort && efforts.length > 0 && efforts.includes(effort)
  const effortName = showEffort ? (effortLabels?.[effort] ?? EFFORT_LABEL[effort]) : undefined
  // 模型芯片只显示模型名；思考强度用一个小点表示，具体档位在 tooltip 里（反馈8#11）。
  const label = autoRoute
    ? `自动${autoModel ? ` · ${shortModelName(autoModel)}` : ''}`
    : model
      ? shortModelName(model)
      : '选择模型'
  const panel = useModelPanel({
    profiles,
    profileId,
    groupId,
    model,
    autoRoute,
    autoModel,
    prices,
    pricesLoading,
    effort,
    efforts,
    effortLabels,
    defaultEffort,
    effortNote,
    delegation,
    routeBias,
    routeNative,
    onDelegationChange,
    onRouteBiasChange,
    onRouteNativeChange,
    loading,
    onSelect,
    onSelectAuto,
    onLoadPrices,
    onEffortChange,
    onManage,
    onSetupPrice,
  })
  return (
    <Menu
      side="top"
      align="end"
      open={open}
      onOpenChange={(next) => {
        if (next) onOpen?.()
        onOpenChange(next)
      }}
      aria-label="选择模型"
      className="w-[320px]"
      footer={panel.footer}
      trigger={({ open: isOpen }) => (
        <Button
          variant="ghost"
          disabled={disabled}
          aria-expanded={isOpen}
          aria-haspopup="menu"
          tooltip={
            isOpen
              ? undefined
              : autoRoute
                ? `自动路由 · 当前 ${autoModel ?? model}（候选池在设置 → 自动路由）`
                : currentProfile
                  ? `${currentProfile.name}${currentGroup ? ` › ${currentGroup}` : ''} · ${model}${showEffort ? ` · 思考强度 ${effortName}` : ''}`
                  : '选择账号与模型'
          }
          tooltipSide="top"
          data-effort={effort}
          aria-label={`选择模型：${label}${showEffort ? `（思考强度：${effortName}）` : ''}`}
          className={cn(
            'min-w-0 max-w-[220px] justify-start gap-1 px-2 font-normal max-sm:min-h-11 max-sm:max-w-[36vw]',
            compact && 'max-w-[128px] px-1.5',
            isOpen && 'bg-[var(--t-bg-hover)] text-text-soft',
          )}
        >
          {/* 反馈14#03：芯片只显示模型名，思考强度只在菜单与 tooltip/aria-label 里体现。 */}
          <span className="min-w-0 truncate">{label}</span>
          {!compact && <ChevronDown size={12} className="shrink-0 opacity-60" />}
        </Button>
      )}
    >
      {panel.body}
    </Menu>
  )
}
