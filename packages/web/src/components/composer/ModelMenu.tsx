import { useEffect, useMemo, useState } from 'react'
import type { Profile, ReasoningEffort } from '@tandem/protocol'
import { ChevronDown, Loader2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { EFFORT_LABEL, effortSuffix, nearestEffort } from '../../lib/effort'
import { prettyModel, shortModelName } from '../../lib/modelName'
import { groupName, profileModelGroups } from '../../lib/profileModels'
import { Button } from '../ui/Button'
import { Menu } from '../ui/Menu'

function ModelPanel({
  profiles,
  profileId,
  groupId,
  model,
  effort,
  efforts,
  loading,
  onSelect,
  onEffortChange,
  onManage,
}: {
  profiles: Profile[]
  profileId: string
  groupId?: string
  model: string
  effort: ReasoningEffort
  efforts: ReasoningEffort[]
  loading: boolean
  onSelect: (profileId: string, groupId: string | undefined, model: string) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onManage: () => void
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
    if (profiles.length === 0) return
    if (profiles.some((p) => p.id === accountId)) return
    setAccountId(profileId || profiles[0].id)
  }, [profiles, accountId, profileId])

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
          这台 Host 还没有配置账号。
        </div>
      )}
      {profiles.length > 0 && models.length === 0 && (
        <div className="px-2 py-2 text-[12px] leading-5 text-muted">没有可用模型。</div>
      )}
      {models.map((m) => {
        const selected = groupSelected && m === model
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
            </span>
          </Menu.Item>
        )
      })}

      {efforts.length > 0 && (
        <>
          <Menu.Separator />
          <Menu.Sub>
            <Menu.SubTrigger trailing={EFFORT_LABEL[selectedEffort]}>思考强度</Menu.SubTrigger>
            <Menu.SubContent className="w-[268px]" aria-label="思考强度">
              <p className="px-2 pb-1.5 pt-1 text-[11.5px] leading-4 text-muted">
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
  effort,
  efforts,
  loading,
  disabled,
  onSelect,
  onEffortChange,
  onManage,
  onOpen,
  open,
  onOpenChange,
}: {
  profiles: Profile[]
  profileId: string
  groupId?: string
  model: string
  effort: ReasoningEffort
  efforts: ReasoningEffort[]
  loading: boolean
  disabled?: boolean
  onSelect: (profileId: string, groupId: string | undefined, model: string) => void
  onEffortChange: (effort: ReasoningEffort) => void
  onManage: () => void
  onOpen?: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const currentProfile = profiles.find((p) => p.id === profileId) ?? null
  const currentGroup = groupName(currentProfile ?? undefined, groupId)
  const showEffort = efforts.length > 0 && efforts.includes(effort)
  const label = model
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
      className="w-[300px]"
      trigger={({ open: isOpen }) => (
        <Button
          variant="ghost"
          disabled={disabled}
          aria-expanded={isOpen}
          aria-haspopup="menu"
          tooltip={
            isOpen
              ? undefined
              : currentProfile
                ? `${currentProfile.name}${currentGroup ? ` › ${currentGroup}` : ''} · ${model}`
                : '选择账号与模型'
          }
          tooltipSide="top"
          aria-label="选择模型"
          className={cn(
            'min-w-0 max-w-[220px] justify-start gap-1 px-2 font-normal max-sm:min-h-11 max-sm:max-w-[40vw]',
            isOpen && 'bg-[var(--t-bg-hover)] text-text-soft',
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </Button>
      )}
    >
      <ModelPanel
        profiles={profiles}
        profileId={profileId}
        groupId={groupId}
        model={model}
        effort={effort}
        efforts={efforts}
        loading={loading}
        onSelect={onSelect}
        onEffortChange={onEffortChange}
        onManage={onManage}
      />
    </Menu>
  )
}

