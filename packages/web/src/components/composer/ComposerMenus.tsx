import type { PermissionMode } from '@tandem/protocol'
import { Brain, ChevronDown, Ellipsis, Map, PencilLine, Shield, ShieldOff } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Button, IconButton } from '../ui/Button'
import { Menu } from '../ui/Menu'
import {
  setThinkingMode,
  THINKING_MODE_META,
  useThinkingMode,
  type ThinkingMode,
} from '../ThinkingBlock'

export const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

const MODE_META: Record<
  PermissionMode,
  {
    label: string
    hint: string
    icon: typeof Shield
  }
> = {
  default: { label: '询问', hint: '每次执行工具前询问', icon: Shield },
  acceptEdits: {
    label: '自动接受编辑',
    hint: '自动接受文件修改，其他仍询问',
    icon: PencilLine,
  },
  plan: { label: '计划模式', hint: '只做规划，不直接执行改动', icon: Map },
  bypassPermissions: {
    label: '全部允许',
    hint: '不再询问，请谨慎使用',
    icon: ShieldOff,
  },
}

function PermissionModeRows({
  mode,
  onChange,
}: {
  mode: PermissionMode
  onChange: (mode: PermissionMode) => void
}) {
  return (
    <>
      {MODES.map((m) => {
        const item = MODE_META[m]
        const ItemIcon = item.icon
        return (
          <Menu.Item
            key={m}
            icon={
              <ItemIcon
                className={m === 'bypassPermissions' ? 'text-danger' : 'text-text-secondary'}
              />
            }
            hint={item.hint}
            selected={m === mode}
            danger={m === 'bypassPermissions'}
            onSelect={() => {
              if (m !== mode) onChange(m)
            }}
          >
            {item.label}
          </Menu.Item>
        )
      })}
    </>
  )
}

export function PermissionModeMenu({
  mode,
  disabled,
  onChange,
}: {
  mode: PermissionMode
  disabled?: boolean
  onChange: (mode: PermissionMode) => void
}) {
  const meta = MODE_META[mode]
  const Icon = meta.icon
  return (
    <Menu
      side="top"
      align="start"
      aria-label="权限模式"
      className="w-[220px]"
      trigger={({ open }) => (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="menu"
          tooltip={open ? undefined : `权限模式：${meta.label}（Shift+Tab 切换）`}
          tooltipSide="top"
          aria-label={`权限模式：${meta.label}`}
          className={cn(
            'max-w-[170px] max-sm:min-h-11',
            open && 'bg-[var(--t-bg-hover)] text-text',
          )}
        >
          <Icon
            size={13}
            className={cn(
              'shrink-0',
              mode === 'bypassPermissions' ? 'text-danger' : 'text-text-secondary',
            )}
          />
          <span className={cn('truncate', mode === 'bypassPermissions' && 'text-danger')}>
            {meta.label}
          </span>
          <ChevronDown size={11} className="shrink-0 opacity-50" />
        </Button>
      )}
    >
      <PermissionModeRows mode={mode} onChange={onChange} />
    </Menu>
  )
}

const THINKING_MODES: ThinkingMode[] = ['show', 'collapse', 'hidden']

export function ThinkingModeMenu() {
  const mode = useThinkingMode()
  const meta = THINKING_MODE_META[mode]
  return (
    <Menu
      side="top"
      align="start"
      aria-label="思考过程"
      className="w-[188px]"
      trigger={({ open }) => (
        <IconButton
          aria-expanded={open}
          aria-haspopup="menu"
          label={`思考过程：${meta.label}`}
          tooltip={open ? '' : undefined}
          tooltipSide="top"
          className={cn('max-sm:size-11', open && 'bg-[var(--t-bg-hover)] text-text-soft')}
        >
          <Brain size={16} />
        </IconButton>
      )}
    >
      {THINKING_MODES.map((item) => (
        <Menu.Item
          key={item}
          hint={THINKING_MODE_META[item].hint}
          selected={item === mode}
          onSelect={() => setThinkingMode(item)}
        >
          {THINKING_MODE_META[item].label}
        </Menu.Item>
      ))}
    </Menu>
  )
}

/** 手机底栏空间有限：思考过程与权限模式收进「更多」菜单。 */
export function MobileMoreMenu({
  mode,
  disabled,
  onChange,
}: {
  mode: PermissionMode
  disabled?: boolean
  onChange: (mode: PermissionMode) => void
}) {
  const meta = MODE_META[mode]
  const thinking = useThinkingMode()
  return (
    <Menu
      side="top"
      align="start"
      aria-label="更多设置"
      className="w-[232px]"
      trigger={({ open }) => (
        <IconButton
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="menu"
          label={`更多设置 · 权限模式：${meta.label}`}
          tooltip={open ? '' : undefined}
          tooltipSide="top"
          className={cn('max-sm:size-11', open && 'bg-[var(--t-bg-hover)] text-text-soft')}
        >
          <span className="relative flex items-center justify-center">
            <Ellipsis size={17} />
            {mode !== 'default' && (
              <span
                className={cn(
                  'absolute -right-1 -top-0.5 size-1.5 rounded-full',
                  mode === 'bypassPermissions' ? 'bg-danger' : 'bg-accent',
                )}
              />
            )}
          </span>
        </IconButton>
      )}
    >
      {THINKING_MODES.map((item) => (
        <Menu.Item
          key={item}
          hint={THINKING_MODE_META[item].hint}
          selected={item === thinking}
          onSelect={() => setThinkingMode(item)}
        >
          {THINKING_MODE_META[item].label}
        </Menu.Item>
      ))}
      <Menu.Separator />
      <PermissionModeRows mode={mode} onChange={onChange} />
    </Menu>
  )
}

