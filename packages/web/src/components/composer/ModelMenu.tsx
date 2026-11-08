import { useEffect, useMemo, useState } from 'react'
import type { ModelPriceInfo, Profile, ReasoningEffort } from '@tandem/protocol'
import { ChevronDown, Loader2, Sparkles } from 'lucide-react'
import { cn } from '../../lib/cn'
import { EFFORT_LABEL, effortSuffix, nearestEffort } from '../../lib/effort'
import { prettyModel, shortModelName } from '../../lib/modelName'
import { groupName, profileModelGroups } from '../../lib/profileModels'
import { Button } from '../ui/Button'
import { Menu } from '../ui/Menu'

/** 参考单价：每百万 token 美元；只保留必要的小数位。 */
function priceText(price: ModelPriceInfo): string {
  const fmt = (value: number) => String(Number(value.toFixed(4)))
  const cache =
    price.cacheRead !== undefined && price.cacheRead > 0
      ? ` · 缓存 $${fmt(price.cacheRead)}`
      : ''
  return `输入 $${fmt(price.input)} · 输出 $${fmt(price.output)} / 百万 tok${cache}`
}

function ModelPanel({
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
  loading,
  onSelect,
  onSelectAuto,
  onLoadPrices,
  onEffortChange,
  onManage,
  onSetupPrice,
}: {
  profiles: Profile[]
  profileId: string
  groupId?: string
  model: string
  autoRoute: boolean
  autoModel?: string
  prices?: Record<string, ModelPriceInfo>
  pricesLoading?: boolean
  effort: ReasoningEffort
  efforts: ReasoningEffort[]
  loading: boolean
  onSelect: (profileId: string, groupId: string | undefined, model: string) => void
  onSelectAuto: () => void
  onLoadPrices?: (profileId: string, groupId: string | undefined) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onManage: () => void
  /** 单价未设置：跳到该账号的单价覆盖设置。 */
  onSetupPrice: (model: string) => void
}) {
  const [accountId, setAccountId] = useState(profileId || profiles[0]?.id || '')
  const account = profiles.find((p) => p.id === accountId) ?? profiles[0] ?? null
  const groups = useMemo(() => (account ? profileModelGroups(account) : []), [account])
  const [groupKey, setGroupKey] = useState<string | undefined>(groupId ?? groups[0]?.groupId)
  const group = groups.find((g) => (g.groupId ?? undefined) === (groupKey ?? undefined)) ?? groups[0]
  const models = group?.models ?? []
  const selectedEffort = efforts.includes(effort) ? effort : nearestEffort(efforts, effort)
  const showAccounts = profiles.length > 1 || groups.length > 1

  useEffect(() => {
    if (profiles.length > 0 && (!accountId || !profiles.some((p) => p.id === accountId))) {
      setAccountId(profileId || profiles[0]?.id || '')
    }
  }, [profiles, accountId])

  useEffect(() => {
    if (account) onLoadPrices?.(account.id, group?.groupId)
    // 只在账号/分组变化时加载，避免 prices 回调引用变化导致重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id, group?.groupId])

  useEffect(() => {
    if (groups.some((g) => (g.groupId ?? undefined) === (groupKey ?? undefined))) return
    setGroupKey(groups[0]?.groupId)
  }, [groups, groupKey])

  const pickAccount = (next: Profile, nextGroup?: { groupId?: string }) => {
    setAccountId(next.id)
    const nextGroups = profileModelGroups(next)
    const keep =
      nextGroup ??
      nextGroups.find((g) => g.groupId === groupId) ??
      nextGroups[0]
    setGroupKey(keep?.groupId)
  }

  const choose = (nextModel: string) => {
    if (!account || !group) return
    if (
      account.id !== profileId ||
      (group.groupId ?? undefined) !== (groupId ?? undefined) ||
      nextModel !== model
    ) {
      onSelect(account.id, group.groupId, nextModel)
    }
  }

  const accountSelected = account?.id === profileId
  const groupSelected = accountSelected && (group?.groupId ?? undefined) === (groupId ?? undefined)

  return (
    <>
      {loading && profiles.length === 0 && (
        <div className="flex h-[32px] items-center gap-2 px-2 text-[12px] text-muted">
          <Loader2 size={13} className="animate-spin" /> 加载账号…
        </div>
      )}
      {!loading && profiles.length === 0 && (
        <div className="px-2 py-2 text-[12px] leading-5 text-muted">
          这台主机还没有配置账号。
        </div>
      )}
      {profiles.length > 0 && models.length === 0 && (
        <div className="px-2 py-2 text-[12px] leading-5 text-muted">没有可用模型。</div>
      )}
      {models.length > 0 && (
        <>
          <Menu.Item
            selected={autoRoute}
            textValue="自动"
            onSelect={onSelectAuto}
            className="h-auto min-h-[40px] py-1"
            hint="按本轮难度在「设置 → 自动路由」候选池中选择，失败自动升级、简单任务回落"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-1 truncate text-[13px] leading-4">
                <Sparkles size={12} className="shrink-0 text-text-tertiary" />
                自动
              </span>
              <span className="truncate text-[12px] leading-4 text-muted">
                {autoModel
                  ? `当前 ${prettyModel(autoModel)} · 每轮按难度选择`
                  : '每轮按难度在候选池中选择'}
              </span>
            </span>
          </Menu.Item>
          <Menu.Separator />
        </>
      )}
      {models.map((m) => {
        const selected = !autoRoute && groupSelected && m === model
        const friendly = prettyModel(m)
        return (
          <Menu.Item
            key={m}
            selected={selected}
            textValue={friendly}
            onSelect={() => choose(m)}
            className="h-auto min-h-[40px] py-1"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[13px] leading-4">{friendly}</span>
              <span className="truncate font-mono text-[12px] leading-4 text-muted">{m}</span>
              {prices?.[m] ? (
                <span className="truncate font-mono text-[12px] leading-4 text-muted/80">
                  {priceText(prices[m])}
                </span>
              ) : pricesLoading ? (
                <span className="flex items-center gap-1 text-[12px] leading-4 text-muted/80">
                  <Loader2 size={10} className="animate-spin" /> 单价读取中…
                </span>
              ) : (
                <button
                  type="button"
                  title={`为该账号的 ${m} 设置单价`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onSetupPrice(m)
                  }}
                  className="w-fit truncate text-left text-[12px] leading-4 text-muted/80 underline decoration-dotted underline-offset-2 hover:text-text"
                >
                  单价未设置 · 去设置
                </button>
              )}
            </span>
          </Menu.Item>
        )
      })}

      {!autoRoute && efforts.length > 0 && (
        <>
          <Menu.Separator />
          <Menu.Sub>
            <Menu.SubTrigger trailing={EFFORT_LABEL[selectedEffort]}>思考强度</Menu.SubTrigger>
            <Menu.SubContent className="w-[268px]" aria-label="思考强度">
              <p className="px-2 pb-1.5 pt-1 text-[12px] leading-4 text-muted">
                投入程度越高，回复越详尽，但耗时越长、用量越多。
              </p>
              <Menu.RadioGroup
                value={selectedEffort}
                onValueChange={(next) => onEffortChange(next as ReasoningEffort)}
              >
                {efforts.map((value) => (
                  <Menu.RadioItem
                    key={value}
                    value={value}
                    trailing={value === 'high' ? '推荐' : undefined}
                  >
                    {EFFORT_LABEL[value]}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.SubContent>
          </Menu.Sub>
        </>
      )}

      {showAccounts && (
        <>
          <Menu.Separator />
          <Menu.Sub>
            <Menu.SubTrigger
              trailing={[account?.name, group?.groupId ? group.name : null]
                .filter(Boolean)
                .join(' › ')}
            >
              {profiles.length > 1 ? '切换账号' : '切换分组'}
            </Menu.SubTrigger>
            <Menu.SubContent className="w-[232px]" aria-label="切换账号">
              {profiles.map((p) => {
                const pGroups = profileModelGroups(p)
                const currentAccount = p.id === account?.id
                if (pGroups.length > 1) {
                  // 分组直接平铺在同一层：Radix 的三级子菜单在 React 19 下不渲染
                  // （SubTrigger 已 open 但 SubContent 不挂载），这里用「账号标题 + 分组行」保持二级级联。
                  return (
                    <div key={p.id}>
                      <Menu.Label>{p.name}</Menu.Label>
                      {pGroups.map((g) => (
                        <Menu.Item
                          key={g.groupId ?? 'default'}
                          selected={currentAccount && g.groupId === group?.groupId}
                          keepOpen
                          onSelect={() => pickAccount(p, g)}
                          className="pl-4"
                        >
                          {g.name}
                        </Menu.Item>
                      ))}
                    </div>
                  )
                }
                return (
                  <Menu.Item
                    key={p.id}
                    selected={currentAccount}
                    keepOpen
                    onSelect={() => pickAccount(p, pGroups[0])}
                  >
                    {p.name}
                  </Menu.Item>
                )
              })}
            </Menu.SubContent>
          </Menu.Sub>
        </>
      )}

      <Menu.Separator />
      <Menu.Item onSelect={onManage}>管理账号…</Menu.Item>
    </>
  )
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
}: {
  profiles: Profile[]
  profileId: string
  groupId?: string
  model: string
  /** 自动路由开启时，模型按钮显示「自动 · 当前模型名」。 */
  autoRoute?: boolean
  autoModel?: string
  prices?: Record<string, ModelPriceInfo>
  pricesLoading?: boolean
  effort: ReasoningEffort
  efforts: ReasoningEffort[]
  loading: boolean
  disabled?: boolean
  onSelect: (profileId: string, groupId: string | undefined, model: string) => void
  onSelectAuto: () => void
  onLoadPrices?: (profileId: string, groupId: string | undefined) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onManage: () => void
  onSetupPrice: (model: string) => void
  onOpen?: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
  compact?: boolean
}) {
  const currentProfile = profiles.find((p) => p.id === profileId) ?? null
  const currentGroup = groupName(currentProfile ?? undefined, groupId)
  const showEffort = !autoRoute && efforts.length > 0 && efforts.includes(effort)
  const label = autoRoute
    ? `自动${autoModel ? ` · ${shortModelName(autoModel)}` : ''}`
    : model
      ? `${shortModelName(model)}${showEffort ? effortSuffix(effort) : ''}`
      : '选择模型'
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
      <ModelPanel
        profiles={profiles}
        profileId={profileId}
        groupId={groupId}
        model={model}
        autoRoute={autoRoute}
        autoModel={autoModel}
        prices={prices}
        pricesLoading={pricesLoading}
        effort={effort}
        efforts={efforts}
        loading={loading}
        onSelect={onSelect}
        onSelectAuto={onSelectAuto}
        onLoadPrices={onLoadPrices}
        onEffortChange={onEffortChange}
        onManage={onManage}
        onSetupPrice={onSetupPrice}
      />
    </Menu>
  )
}

