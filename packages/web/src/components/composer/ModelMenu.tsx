import { useEffect, useMemo } from 'react'
import type { ModelPriceInfo, Profile, ReasoningEffort } from '@tandem/protocol'
import { ChevronDown, Loader2, Sparkles } from 'lucide-react'
import { cn } from '../../lib/cn'
import { EFFORT_LABEL, effortSuffix, nearestEffort } from '../../lib/effort'
import { prettyModel, shortModelName } from '../../lib/modelName'
import { groupName, profileModelGroups } from '../../lib/profileModels'
import { rankRecentModels } from '../../lib/recentModels'
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
  if (price.officialInput !== undefined && (account !== 1 || group !== 1)) {
    const factors = [`官方 $${fmt(price.officialInput)}/M`]
    if (account !== 1) factors.push(`账号 ${fmt(account)}`)
    if (group !== 1) factors.push(`分组 ${fmt(group)}`)
    return `${factors.join(' × ')} = $${fmt(price.input)}/M · 输出 $${fmt(price.officialOutput ?? 0)}/M → $${fmt(price.output)}/M${cache}`
  }
  const prefix = price.source === 'builtin' ? '参考价 · ' : ''
  return `${prefix}输入 $${fmt(price.input)} · 输出 $${fmt(price.output)} / 百万 tok${cache}`
}

interface ModelPanelProps {
  profiles: Profile[]
  profileId: string
  groupId?: string
  model: string
  autoRoute: boolean
  routeMode?: 'auto' | 'division'
  autoModel?: string
  prices?: Record<string, ModelPriceInfo>
  pricesLoading?: boolean
  effort: ReasoningEffort
  efforts: ReasoningEffort[]
  /** 各档位在该模型厂商的原始叫法（来自服务端能力表）。 */
  effortLabels?: Partial<Record<ReasoningEffort, string>>
  loading: boolean
  onSelect: (profileId: string, groupId: string | undefined, model: string) => void
  onSelectAuto: (mode: 'auto' | 'division') => void
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
  routeMode,
  autoModel,
  prices,
  pricesLoading,
  effort,
  efforts,
  effortLabels,
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
  const selectedEffort = efforts.length
    ? efforts.includes(effort)
      ? effort
      : nearestEffort(efforts, effort)
    : 'off'

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
          <Loader2 size={13} className="animate-spin" /> 加载账号…
        </div>
      )}
      {!loading && profiles.length === 0 && (
        <div className="px-2 py-2 text-[12px] leading-5 text-muted">这台主机还没有配置账号。</div>
      )}
      {profiles.length > 0 && (
        <>
          <Menu.Item
            selected={autoRoute && routeMode !== 'division'}
            textValue="自动"
            icon={<Sparkles size={12} />}
            onSelect={() => onSelectAuto('auto')}
            hint={
              autoModel && routeMode !== 'division'
                ? `当前 ${prettyModel(autoModel)} · 按本轮难度在「设置 → 自动路由」候选池中选择，失败自动升级`
                : '每轮按难度在「设置 → 自动路由」候选池中选择，失败自动升级、简单任务回落'
            }
          >
            自动
          </Menu.Item>
          <Menu.Item
            selected={autoRoute && routeMode === 'division'}
            textValue="分工"
            icon={<Sparkles size={12} />}
            onSelect={() => onSelectAuto('division')}
            hint="主会话模型保持规划者；机械子任务用 Task 派给便宜/专长执行者"
          >
            分工
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
                <button
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
      {!autoRoute && efforts.length > 0 && (
        <Menu.Sub>
          <Menu.SubTrigger trailing={effortLabels?.[selectedEffort] ?? EFFORT_LABEL[selectedEffort]}>
            思考强度
          </Menu.SubTrigger>
          <Menu.SubContent className="w-[210px]" aria-label="思考强度">
            <Menu.RadioGroup
              value={selectedEffort}
              onValueChange={(next) => onEffortChange(next as ReasoningEffort)}
            >
              {efforts.map((value) => (
                <Menu.RadioItem key={value} value={value} hint="投入越高，回复越详尽，耗时与用量越多">
                  {effortLabels?.[value] ?? EFFORT_LABEL[value]}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
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
  routeMode,
  autoModel,
  prices,
  pricesLoading,
  effort,
  efforts,
  effortLabels,
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
  const showEffort = !autoRoute && efforts.length > 0 && efforts.includes(effort)
  const label = autoRoute
    ? routeMode === 'division'
      ? `分工${model ? ` · ${shortModelName(model)}` : ''}`
      : `自动${autoModel ? ` · ${shortModelName(autoModel)}` : ''}`
    : model
      ? `${shortModelName(model)}${showEffort ? effortSuffix(effort) : ''}`
      : '选择模型'
  const panel = useModelPanel({
    profiles,
    profileId,
    groupId,
    model,
    autoRoute,
    routeMode,
    autoModel,
    prices,
    pricesLoading,
    effort,
    efforts,
    effortLabels,
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
                  ? `${currentProfile.name}${currentGroup ? ` › ${currentGroup}` : ''} · ${model}`
                  : '选择账号与模型'
          }
          tooltipSide="top"
          aria-label={`选择模型：${label}`}
          className={cn(
            'min-w-0 max-w-[220px] justify-start gap-1 px-2 font-normal max-sm:min-h-11 max-sm:max-w-[36vw]',
            compact && 'max-w-[128px] px-1.5',
            isOpen && 'bg-[var(--t-bg-hover)] text-text-soft',
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          {!compact && <ChevronDown size={12} className="shrink-0 opacity-60" />}
        </Button>
      )}
    >
      {panel.body}
    </Menu>
  )
}
