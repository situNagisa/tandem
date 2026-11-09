import { MoreHorizontal } from 'lucide-react'
import { cn } from '../../lib/cn'
import { IconButton } from '../ui/Button'
import { Menu } from '../ui/Menu'
import { GROUPS, togglePanelGroup, usePanelGroups } from './shared'

/**
 * 会话信息面板的 ⋯ 菜单。反馈12#06 把它从面板顶栏移到窗口顶栏右侧，
 * 与「收起右栏」按钮相邻；面板本身不再有标题框。
 */
export function PanelGroupsMenu() {
  const { prefs, availability } = usePanelGroups()
  return (
    <Menu
      side="bottom"
      align="end"
      aria-label="显示分组"
      className="w-[200px]"
      trigger={({ open }) => (
        <IconButton
          label="自定义信息面板"
          tooltip={open ? '' : '自定义信息面板的分组'}
          aria-expanded={open}
          aria-haspopup="menu"
          data-tip={open ? undefined : '自定义信息面板的分组'}
          className={cn('max-sm:size-11', open && 'bg-[var(--t-bg-active)] text-text')}
        >
          <MoreHorizontal size={16} />
        </IconButton>
      )}
    >
      {GROUPS.map((group) => {
        const avail = !!availability[group.id]
        const shown = !prefs.hidden.includes(group.id) && (avail || prefs.shown.includes(group.id))
        return (
          <Menu.CheckItem
            key={group.id}
            icon={<group.Icon />}
            checked={shown}
            hint={avail ? undefined : '暂无数据；勾选后也会显示这个分组'}
            onCheckedChange={() => togglePanelGroup(group.id)}
          >
            {group.label}
          </Menu.CheckItem>
        )
      })}
    </Menu>
  )
}
