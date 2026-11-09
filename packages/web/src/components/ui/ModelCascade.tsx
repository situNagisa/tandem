import type { ReactNode } from 'react'
import type { Profile } from '@tandem/protocol'
import { profileModelGroups, type ProfileModelGroup } from '../../lib/profileModels'
import { formatCost } from '../../lib/format'
import { Menu } from './Menu'

export interface ModelPick {
  profileId: string
  groupId?: string
  model: string
}

export function modelPickKey(pick: ModelPick): string {
  return `${pick.profileId}\u0000${pick.groupId ?? ''}\u0000${pick.model}`
}

export function samePick(a: ModelPick | undefined, b: ModelPick | undefined): boolean {
  return !!a && !!b && modelPickKey(a) === modelPickKey(b)
}

interface ModelCascadeProps {
  profiles: Profile[]
  mode: 'single' | 'check'
  /** check 模式下已选的键（modelPickKey）。 */
  selectedKeys?: ReadonlySet<string>
  /** single 模式下当前模型（显示勾选）。 */
  current?: ModelPick
  onPick?: (pick: ModelPick) => void
  onToggle?: (pick: ModelPick, checked: boolean) => void
  emptyText?: string
  className?: string
}

function groupLabel(group: ProfileModelGroup): string {
  return group.name
}

/**
 * 账号 › 分组 › 模型 逐级飞出（用户 #7-04：真正的级联子菜单，不在同一面板里替换内容）。
 * 只有一个账号或一个分组时跳过该级；键盘 ← / → 由 Radix 子菜单处理。
 * 模型菜单的「切换账号」与设置 → 自动路由的候选池共用这一份实现（R01/R15）。
 */
export function ModelCascade({
  profiles,
  mode,
  selectedKeys,
  current,
  onPick,
  onToggle,
  emptyText = '没有可用模型。',
  className,
}: ModelCascadeProps) {
  const empty = (key: string) => (
    <p key={key} className="px-2 py-2 text-[12px] leading-5 text-muted">
      {emptyText}
    </p>
  )

  const modelRows = (profile: Profile, group: ProfileModelGroup): ReactNode[] => {
    if (group.models.length === 0) return [empty(`${profile.id}:${group.groupId ?? ''}:empty`)]
    return group.models.map((model) => {
      const pick: ModelPick = {
        profileId: profile.id,
        ...(group.groupId ? { groupId: group.groupId } : {}),
        model,
      }
      const key = modelPickKey(pick)
      const checked = !!selectedKeys?.has(key)
      const selected = samePick(current, pick)
      if (mode === 'check') {
        return (
          <Menu.CheckItem
            key={key}
            checked={checked}
            onCheckedChange={() => onToggle?.(pick, !checked)}
          >
            {model}
          </Menu.CheckItem>
        )
      }
      return (
        <Menu.Item key={key} selected={selected} onSelect={() => onPick?.(pick)}>
          {model}
        </Menu.Item>
      )
    })
  }

  const groupSub = (profile: Profile, group: ProfileModelGroup): ReactNode => {
    const pick: ModelPick | undefined = current?.profileId === profile.id && (current.groupId ?? '') === (group.groupId ?? '')
      ? current
      : undefined
    return (
      <Menu.Sub key={`g:${profile.id}:${group.groupId ?? ''}`}>
        <Menu.SubTrigger
          trailing={`${group.models.length} 个模型`}
          className={pick ? 'text-text' : undefined}
        >
          {groupLabel(group)}
        </Menu.SubTrigger>
        <Menu.SubContent className="min-w-[200px]" aria-label={`${profile.name} · ${groupLabel(group)}`}>
          {modelRows(profile, group)}
        </Menu.SubContent>
      </Menu.Sub>
    )
  }

  /** 账号层：单分组时跳过分组，直接飞出模型列表。 */
  const accountSub = (profile: Profile): ReactNode => {
    const groups = profileModelGroups(profile)
    const count = groups.reduce((sum, group) => sum + group.models.length, 0)
    return (
      <Menu.Sub key={`a:${profile.id}`}>
        <Menu.SubTrigger
          trailing={
            profile.balance?.amount !== undefined
              ? `${count} 个模型 · 余额 ${profile.balance.currency === 'USD' ? '$' : ''}${formatCost(profile.balance.amount)}`
              : profile.balance?.error
                ? `${count} 个模型 · 余额 —`
                : `${count} 个模型`
          }
          hint={profile.balance?.error ? `余额查询失败：${profile.balance.error}` : undefined}
        >
          {profile.name}
        </Menu.SubTrigger>
        <Menu.SubContent className="min-w-[220px]" aria-label={profile.name}>
          {groups.length === 0
            ? empty(`a:${profile.id}:empty`)
            : groups.length === 1
              ? modelRows(profile, groups[0]!)
              : groups.map((group) => groupSub(profile, group))}
        </Menu.SubContent>
      </Menu.Sub>
    )
  }

  if (profiles.length === 0) {
    return <div className={className}>{empty('profiles-empty')}</div>
  }

  const only = profiles.length === 1 ? profiles[0]! : null
  const onlyGroups = only ? profileModelGroups(only) : []
  let rows: ReactNode[]
  if (only) {
    // 只有一个账号：跳过账号层。
    rows =
      onlyGroups.length === 0
        ? [empty('groups-empty')]
        : onlyGroups.length === 1
          ? modelRows(only, onlyGroups[0]!)
          : onlyGroups.map((group) => groupSub(only, group))
  } else {
    rows = profiles.map((profile) => accountSub(profile))
  }

  return (
    <div className={className} data-model-cascade="">
      {rows}
    </div>
  )
}
