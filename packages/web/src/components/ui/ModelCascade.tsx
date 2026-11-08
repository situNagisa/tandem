import { useMemo, useState, type ReactNode } from 'react'
import type { Profile } from '@tandem/protocol'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { profileModelGroups, type ProfileModelGroup } from '../../lib/profileModels'
import { Menu, MenuItem, MenuList } from './Menu'

export interface ModelPick {
  profileId: string
  groupId?: string
  model: string
}

export function modelPickKey(pick: ModelPick): string {
  return `${pick.profileId}\u0000${pick.groupId ?? ''}\u0000${pick.model}`
}

interface ModelCascadeProps {
  profiles: Profile[]
  /** 在 Radix Menu 内用 menu；在 Popover / MenuList 内用 list。 */
  kind: 'menu' | 'list'
  mode: 'single' | 'check'
  /** check 模式下已选的键（modelPickKey）。 */
  selectedKeys?: ReadonlySet<string>
  onPick?: (pick: ModelPick) => void
  onToggle?: (pick: ModelPick, checked: boolean) => void
  /** 初始定位到某个账号/分组（模型菜单的切换账号子菜单）。 */
  initialAccountId?: string
  initialGroupId?: string
  /** 直接展示模型层（账号、分组已固定）。 */
  start?: 'account' | 'group' | 'model'
  emptyText?: string
  className?: string
}

type Stage = 'account' | 'group' | 'model'

function modelCount(group: ProfileModelGroup): number {
  return group.models.length
}

/**
 * 账号 › 分组 › 模型 逐级展开。模型菜单的「切换账号」与
 * 设置 → 自动路由的候选池共用同一份交互与行样式（R01/R15）。
 */
export function ModelCascade({
  profiles,
  kind,
  mode,
  selectedKeys,
  onPick,
  onToggle,
  initialAccountId,
  initialGroupId,
  start = 'account',
  emptyText = '没有可用模型。',
  className,
}: ModelCascadeProps) {
  const [accountId, setAccountId] = useState<string | undefined>(initialAccountId)
  const [groupId, setGroupId] = useState<string | undefined>(initialGroupId)
  const [stage, setStage] = useState<Stage>(
    start === 'model' && initialAccountId ? 'model' : start === 'group' && initialAccountId ? 'group' : 'account',
  )
  const account = profiles.find((p) => p.id === accountId) ?? null
  const groups = useMemo(() => (account ? profileModelGroups(account) : []), [account])
  const group = groups.find((g) => g.groupId === groupId) ?? (groups.length === 1 ? groups[0] : undefined)

  const enterAccount = (profile: Profile) => {
    const nextGroups = profileModelGroups(profile)
    setAccountId(profile.id)
    setGroupId(nextGroups.length === 1 ? nextGroups[0].groupId : undefined)
    if (nextGroups.length <= 1) setStage('model')
    else setStage('group')
  }
  const enterGroup = (next: ProfileModelGroup) => {
    setGroupId(next.groupId)
    setStage('model')
  }
  const back = () => {
    if (stage === 'model' && groups.length > 1) setStage('group')
    else setStage('account')
  }

  const row = (
    key: string,
    opts: {
      label: ReactNode
      trailing?: ReactNode
      icon?: ReactNode
      selected?: boolean
      checked?: boolean
      keepOpen?: boolean
      onSelect: () => void
    },
  ): ReactNode => {
    if (kind === 'menu') {
      if (mode === 'check') {
        return (
          <Menu.CheckItem
            key={key}
            checked={!!opts.checked}
            icon={opts.icon}
            trailing={opts.trailing}
            onCheckedChange={() => opts.onSelect()}
          >
            {opts.label}
          </Menu.CheckItem>
        )
      }
      return (
        <Menu.Item
          key={key}
          icon={opts.icon}
          trailing={opts.trailing}
          selected={opts.selected}
          keepOpen={opts.keepOpen}
          onSelect={opts.onSelect}
        >
          {opts.label}
        </Menu.Item>
      )
    }
    return (
      <MenuItem
        key={key}
        icon={opts.icon}
        trailing={opts.trailing}
        selected={opts.selected || opts.checked}
        role={mode === 'check' ? 'menuitemcheckbox' : 'menuitem'}
        ariaChecked={mode === 'check' ? !!opts.checked : undefined}
        onSelect={opts.onSelect}
      >
        {opts.label}
      </MenuItem>
    )
  }

  if (profiles.length === 0) {
    return <p className="px-2 py-2 text-[12px] leading-5 text-muted">{emptyText}</p>
  }

  const rows: ReactNode[] = []
  if (stage === 'account' || !account) {
    for (const profile of profiles) {
      const profileGroups = profileModelGroups(profile)
      const count = profileGroups.reduce((sum, item) => sum + modelCount(item), 0)
      rows.push(
        row(`a:${profile.id}`, {
          label: profile.name,
          trailing: (
            <>
              {count} 个模型
              <ChevronRight size={12} className="shrink-0 text-muted" />
            </>
          ),
          selected: profile.id === accountId && stage !== 'account',
          keepOpen: true,
          onSelect: () => enterAccount(profile),
        }),
      )
    }
  } else if (stage === 'group') {
    rows.push(
      row('back', {
        label: account.name,
        icon: <ChevronLeft size={12} />,
        keepOpen: true,
        onSelect: back,
      }),
    )
    for (const item of groups) {
      rows.push(
        row(`g:${item.groupId ?? ''}`, {
          label: item.name,
          trailing: (
            <>
              {item.models.length} 个模型
              <ChevronRight size={12} className="shrink-0 text-muted" />
            </>
          ),
          keepOpen: true,
          onSelect: () => enterGroup(item),
        }),
      )
    }
  } else if (!group) {
    rows.push(<p key="empty" className="px-2 py-2 text-[12px] text-muted">{emptyText}</p>)
  } else {
    if (start !== 'model') {
      rows.push(
        row('back', {
          label: groups.length > 1 ? group.name : account.name,
          icon: <ChevronLeft size={12} />,
          trailing: groups.length > 1 ? account.name : undefined,
          keepOpen: true,
          onSelect: back,
        }),
      )
    }
    for (const model of group.models) {
      const pick: ModelPick = {
        profileId: account.id,
        ...(group.groupId ? { groupId: group.groupId } : {}),
        model,
      }
      const key = modelPickKey(pick)
      const checked = !!selectedKeys?.has(key)
      rows.push(
        row(key, {
          label: model,
          checked: mode === 'check' ? checked : undefined,
          selected: mode === 'single' ? false : undefined,
          keepOpen: mode === 'check',
          onSelect: () => {
            if (mode === 'check') onToggle?.(pick, !checked)
            else onPick?.(pick)
          },
        }),
      )
    }
    if (group.models.length === 0) {
      rows.push(<p key="empty" className="px-2 py-2 text-[12px] text-muted">{emptyText}</p>)
    }
  }

  if (kind === 'list') {
    return (
      <MenuList className={className ? `p-0 ${className}` : 'p-0'} aria-label={mode === 'check' ? '选择候选模型' : '选择模型'}>
        {rows}
      </MenuList>
    )
  }
  return (
    <div className={className} data-model-cascade={stage}>
      {rows}
    </div>
  )
}
