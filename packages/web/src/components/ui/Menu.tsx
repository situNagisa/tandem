import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import * as RDropdown from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { ControlSize } from './Button'
import { Tip } from './Tooltip'

/* 菜单的尺寸、颜色、间距只在这里定义一次。26px 单行、13px 字，全应用一致。 */
const ROW_BASE =
  'group/row flex h-[26px] w-full min-w-0 shrink-0 select-none items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] leading-none text-text-soft outline-none transition-colors duration-[120ms]'

const ROW_STATE =
  'hover:bg-[var(--t-bg-hover)] hover:text-text focus:bg-[var(--t-bg-hover)] focus:text-text focus-visible:outline-none data-[highlighted]:bg-[var(--t-bg-hover)] data-[highlighted]:text-text data-[state=open]:bg-[var(--t-bg-hover)] data-[state=open]:text-text data-[selected=true]:bg-[color-mix(in_srgb,var(--t-bg-active)_55%,transparent)] data-[selected=true]:text-text data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[disabled]:hover:bg-transparent'

const PANEL_BASE =
  'popover-panel z-[90] min-w-[180px] max-w-[min(360px,calc(100vw-1rem))] overflow-y-auto p-1 outline-none'

const SUB_PANEL_BASE =
  'popover-panel z-[95] min-w-[160px] max-w-[min(340px,calc(100vw-1rem))] overflow-y-auto p-1 outline-none'

function RowContent({
  icon,
  children,
  trailing,
  selected,
  checked,
}: {
  icon?: ReactNode
  children: ReactNode
  trailing?: ReactNode
  selected?: boolean
  checked?: boolean
}) {
  return (
    <>
      {icon && (
        <span className="flex size-4 shrink-0 items-center justify-center text-muted [&_svg]:size-3.5">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && <span className="shrink-0 text-[11.5px] text-muted">{trailing}</span>}
      {(selected || checked) && (
        <Check size={13} className="shrink-0 text-text-secondary" strokeWidth={2.2} />
      )}
    </>
  )
}

export interface MenuProps {
  trigger: ReactElement | ((state: { open: boolean }) => ReactElement)
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end' | 'left' | 'right'
  sideOffset?: number
  alignOffset?: number
  className?: string
  /** 内容区最大高度，默认跟随可用空间。 */
  maxHeight?: number
  modal?: boolean
  'aria-label'?: string
}

function MenuRoot({
  trigger,
  children,
  open: openProp,
  onOpenChange,
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  alignOffset,
  className,
  maxHeight,
  modal = true,
  'aria-label': ariaLabel,
}: MenuProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = openProp ?? internalOpen
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next)
      onOpenChange?.(next)
    },
    [openProp, onOpenChange],
  )
  const node = typeof trigger === 'function' ? trigger({ open }) : trigger
  const radixAlign = align === 'left' ? 'start' : align === 'right' ? 'end' : align
  return (
    <RDropdown.Root open={open} onOpenChange={setOpen} modal={modal}>
      <RDropdown.Trigger asChild>{node}</RDropdown.Trigger>
      <RDropdown.Portal>
        <RDropdown.Content
          aria-label={ariaLabel}
          side={side}
          align={radixAlign}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          collisionPadding={8}
          avoidCollisions
          sticky="always"
          hideWhenDetached
          style={{
            maxHeight: maxHeight
              ? undefined
              : 'min(420px, var(--radix-dropdown-menu-content-available-height))',
          }}
          className={cn(PANEL_BASE, className)}
        >
          {children}
        </RDropdown.Content>
      </RDropdown.Portal>
    </RDropdown.Root>
  )
}

export interface MenuItemProps {
  children: ReactNode
  icon?: ReactNode
  /** 悬停/键盘聚焦时以标准 tooltip 展示的说明。 */
  hint?: string
  /** 禁用原因：选项不可选时悬停显示，替代 hint。 */
  disabledReason?: string
  selected?: boolean
  trailing?: ReactNode
  danger?: boolean
  disabled?: boolean
  textValue?: string
  onSelect?: () => void
  /** 选择后保持菜单打开（用于切换主列表内容）。 */
  keepOpen?: boolean
  className?: string
  title?: string
}

const RadixMenuItem = forwardRef<HTMLDivElement, MenuItemProps>(function RadixMenuItem(
  {
    children,
    icon,
    hint,
    disabledReason,
    selected = false,
    trailing,
    danger = false,
    disabled = false,
    textValue,
    onSelect,
    keepOpen = false,
    className,
    title,
  },
  ref,
) {
  const tip = disabled ? (disabledReason ?? hint) : hint
  return (
    <RDropdown.Item
      ref={ref}
      disabled={disabled}
      textValue={textValue}
      title={title}
      data-selected={selected || undefined}
      onSelect={(event) => {
        if (keepOpen) event.preventDefault()
        onSelect?.()
      }}
      className={cn(
        ROW_BASE,
        ROW_STATE,
        selected && 'text-text',
        danger && 'text-danger hover:text-danger data-[highlighted]:text-danger focus:text-danger',
        className,
      )}
    >
      <RowContent icon={icon} trailing={trailing} selected={selected}>
        {children}
      </RowContent>
      {tip ? <Tip label={tip} /> : null}
    </RDropdown.Item>
  )
})

export interface MenuCheckItemProps {
  children: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  icon?: ReactNode
  hint?: string
  disabledReason?: string
  trailing?: ReactNode
  danger?: boolean
  disabled?: boolean
  className?: string
}

/** 多选菜单项；视觉与应用内其他列表行完全一致。 */
const MenuCheckItem = forwardRef<HTMLDivElement, MenuCheckItemProps>(function MenuCheckItem(
  {
    children,
    checked,
    onCheckedChange,
    icon,
    hint,
    disabledReason,
    trailing,
    danger,
    disabled,
    className,
  },
  ref,
) {
  const tip = disabled ? (disabledReason ?? hint) : hint
  return (
    <RDropdown.CheckboxItem
      ref={ref}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      onSelect={(e) => e.preventDefault()}
      className={cn(
        ROW_BASE,
        ROW_STATE,
        danger && 'text-danger data-[highlighted]:text-danger',
        className,
      )}
    >
      <RowContent icon={icon} trailing={trailing} checked={checked}>
        {children}
      </RowContent>
      {tip ? <Tip label={tip} /> : null}
    </RDropdown.CheckboxItem>
  )
})

export interface MenuRadioGroupProps {
  value?: string
  onValueChange?: (value: string) => void
  children: ReactNode
}

function MenuRadioGroup({ value, onValueChange, children }: MenuRadioGroupProps) {
  return (
    <RDropdown.RadioGroup value={value} onValueChange={onValueChange}>
      {children}
    </RDropdown.RadioGroup>
  )
}

export interface MenuRadioItemProps extends Omit<MenuItemProps, 'selected' | 'onSelect'> {
  value: string
  onSelect?: () => void
}

const MenuRadioItem = forwardRef<HTMLDivElement, MenuRadioItemProps>(function MenuRadioItem(
  {
    children,
    icon,
    hint,
    disabledReason,
    trailing,
    danger,
    disabled,
    value,
    keepOpen,
    onSelect,
    className,
    title,
  },
  ref,
) {
  const tip = disabled ? (disabledReason ?? hint) : hint
  return (
    <RDropdown.RadioItem
      ref={ref}
      value={value}
      disabled={disabled}
      title={title}
      onSelect={(event) => {
        if (keepOpen) event.preventDefault()
        onSelect?.()
      }}
      className={cn(
        ROW_BASE,
        ROW_STATE,
        'data-[state=checked]:text-text',
        danger && 'text-danger data-[highlighted]:text-danger',
        className,
      )}
    >
      <RowContent icon={icon} trailing={trailing} checked={false}>
        {children}
      </RowContent>
      <RDropdown.ItemIndicator className="ml-auto flex shrink-0 items-center">
        <Check size={13} className="text-text-secondary" strokeWidth={2.2} />
      </RDropdown.ItemIndicator>
      {tip ? <Tip label={tip} /> : null}
    </RDropdown.RadioItem>
  )
})

function MenuSeparator({ className }: { className?: string }) {
  return <RDropdown.Separator className={cn('my-0.5 h-px shrink-0 bg-border', className)} />
}

function MenuLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <RDropdown.Label
      className={cn('px-1.5 pb-0.5 pt-1 text-[12px] leading-4 text-muted', className)}
    >
      {children}
    </RDropdown.Label>
  )
}

export interface MenuSubTriggerProps {
  children: ReactNode
  icon?: ReactNode
  hint?: string
  disabled?: boolean
  className?: string
  /** 右侧提示文字（如当前值）。 */
  trailing?: ReactNode
}

const MenuSubTrigger = forwardRef<HTMLDivElement, MenuSubTriggerProps>(function MenuSubTrigger(
  { children, icon, hint, disabled, className, trailing },
  ref,
) {
  return (
    <RDropdown.SubTrigger
      ref={ref}
      disabled={disabled}
      className={cn(ROW_BASE, ROW_STATE, 'data-[state=open]:bg-[var(--t-bg-hover)]', className)}
    >
      <RowContent icon={icon} trailing={trailing}>
        {children}
      </RowContent>
      <ChevronRight size={13} className="ml-1 shrink-0 text-muted" />
      {hint ? <Tip label={hint} /> : null}
    </RDropdown.SubTrigger>
  )
})

export interface MenuSubRootProps {
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

function MenuSubRoot({ children, open, onOpenChange }: MenuSubRootProps) {
  return (
    <RDropdown.Sub open={open} onOpenChange={onOpenChange}>
      {children}
    </RDropdown.Sub>
  )
}

export interface MenuSubContentProps {
  children: ReactNode
  className?: string
  'aria-label'?: string
}

function MenuSubContent({ children, className, 'aria-label': ariaLabel }: MenuSubContentProps) {
  return (
    <RDropdown.Portal>
      <RDropdown.SubContent
        aria-label={ariaLabel}
        sideOffset={4}
        alignOffset={-4}
        collisionPadding={8}
        avoidCollisions
        className={cn(SUB_PANEL_BASE, className)}
      >
        {children}
      </RDropdown.SubContent>
    </RDropdown.Portal>
  )
}

/** 统一弹出菜单。尺寸、颜色、键盘、碰撞避让、Portal 全部由这一处定义。 */
export const Menu = Object.assign(MenuRoot, {
  Item: RadixMenuItem,
  CheckItem: MenuCheckItem,
  RadioGroup: MenuRadioGroup,
  RadioItem: MenuRadioItem,
  Separator: MenuSeparator,
  Label: MenuLabel,
  Sub: MenuSubRoot,
  SubTrigger: MenuSubTrigger,
  SubContent: MenuSubContent,
})

/* ------------------------------------------------------------------ */
/* 非 Radix 场景（输入框内联筛选、补全列表）复用的同一套行样式。       */
/* ------------------------------------------------------------------ */

export interface MenuListProps {
  children: ReactNode
  className?: string
  'aria-label'?: string
  /** 受控高亮项（如补全列表由输入框维护索引）。 */
  activeIndex?: number
  onActiveIndexChange?: (index: number) => void
  /** 关闭内置的 ↑↓/Home/End 导航（外层自己处理键盘时）。 */
  keyboard?: boolean
}

function menuItemsOf(root: HTMLElement | null): HTMLElement[] {
  return Array.from(
    root?.querySelectorAll<HTMLElement>(
      '[data-menu-item]:not(:disabled):not([aria-disabled="true"])',
    ) ?? [],
  )
}

function itemFromEvent(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  const item = target.closest<HTMLElement>('[data-menu-item]')
  if (!item) return null
  return item
}

/**
 * 统一弹出列表：26px 单行紧凑选项，说明与禁用原因走标准 tooltip。
 * 带搜索框、由输入框维护高亮的自定义列表使用它；普通菜单直接用 <Menu>。
 */
export function MenuList({
  children,
  className,
  'aria-label': ariaLabel,
  activeIndex,
  onActiveIndexChange,
  keyboard = true,
}: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<HTMLElement | null>(null)

  const setActiveItem = useCallback((el: HTMLElement | null) => {
    for (const prev of ref.current?.querySelectorAll<HTMLElement>('[data-active]') ?? []) {
      prev.removeAttribute('data-active')
    }
    if (el && el.isConnected) {
      el.setAttribute('data-active', 'true')
      setActive(el)
    } else {
      setActive(null)
    }
  }, [])

  useEffect(() => {
    if (activeIndex === undefined) return
    const items = menuItemsOf(ref.current)
    setActiveItem(items[activeIndex] ?? null)
  }, [activeIndex, children, setActiveItem])

  useEffect(() => {
    if (!active || !active.isConnected) return
    active.scrollIntoView({ block: 'nearest' })
  }, [active])

  const indexOf = (el: HTMLElement | null) => {
    if (!el) return -1
    return menuItemsOf(ref.current).indexOf(el)
  }

  const activateAt = (index: number) => {
    const items = menuItemsOf(ref.current)
    if (!items.length) return
    const next = Math.max(0, Math.min(index, items.length - 1))
    const el = items[next]
    el.focus({ preventScroll: false })
    setActiveItem(el)
    onActiveIndexChange?.(next)
  }

  const move = (delta: 1 | -1 | 'first' | 'last') => {
    const items = menuItemsOf(ref.current)
    if (!items.length) return
    if (delta === 'first') return activateAt(0)
    if (delta === 'last') return activateAt(items.length - 1)
    const current = indexOf(active)
    activateAt(current < 0 ? (delta === 1 ? 0 : items.length - 1) : current + delta)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!keyboard) return
    const target = e.target as HTMLElement
    const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Home' && !inField) {
      e.preventDefault()
      move('first')
    } else if (e.key === 'End' && !inField) {
      e.preventDefault()
      move('last')
    } else if (e.key === 'Enter' && inField && !e.nativeEvent.isComposing) {
      const items = menuItemsOf(ref.current)
      const el = active && active.isConnected ? active : items[0]
      if (el) {
        e.preventDefault()
        el.click()
      }
    }
  }

  const onPointerOver = (e: ReactMouseEvent<HTMLDivElement>) => {
    const item = itemFromEvent(e.target)
    if (!item || item === active) return
    setActiveItem(item)
    onActiveIndexChange?.(indexOf(item))
  }

  const onPointerLeave = () => {
    if (ref.current?.contains(document.activeElement)) return
    setActiveItem(null)
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      className={cn('flex flex-col p-1', className)}
      onKeyDown={onKeyDown}
      onMouseOver={onPointerOver}
      onMouseLeave={onPointerLeave}
      onFocus={(e) => {
        const item = itemFromEvent(e.target)
        if (item) setActiveItem(item)
      }}
      onBlur={(e) => {
        if (ref.current?.contains(e.relatedTarget as Node | null)) return
        setActiveItem(null)
      }}
    >
      {children}
    </div>
  )
}

/** MenuList 内的行（也供补全等自有键盘逻辑复用），与 Radix 菜单共用同一套行样式。 */
export interface LegacyMenuItemProps {
  children: ReactNode
  icon?: ReactNode
  hint?: string
  disabledReason?: string
  selected?: boolean
  trailing?: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect?: () => void
  onMouseDown?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  onMouseEnter?: () => void
  role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox'
  ariaChecked?: boolean
  className?: string
  title?: string
}

export const MenuItem = forwardRef<HTMLButtonElement, LegacyMenuItemProps>(function MenuItem(
  {
    children,
    icon,
    hint,
    disabledReason,
    selected = false,
    trailing,
    danger = false,
    disabled = false,
    onSelect,
    onMouseDown,
    onMouseEnter,
    role = 'menuitem',
    ariaChecked,
    className,
    title,
  },
  ref,
) {
  const tip = disabled ? (disabledReason ?? hint) : hint
  return (
    <button
      ref={ref}
      type="button"
      role={role}
      aria-checked={ariaChecked}
      disabled={disabled && !disabledReason}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : undefined}
      title={title}
      data-menu-item=""
      data-selected={selected || undefined}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
      onMouseDown={(e) => {
        if (!disabled) onMouseDown?.(e)
      }}
      onMouseEnter={onMouseEnter}
      className={cn(
        ROW_BASE,
        ROW_STATE,
        'data-[active=true]:bg-[var(--t-bg-hover)] data-[active=true]:text-text',
        'aria-disabled:hover:bg-transparent aria-disabled:hover:text-text-soft',
        selected && 'text-text',
        danger && 'text-danger hover:text-danger focus:text-danger',
        className,
      )}
    >
      <RowContent icon={icon} trailing={trailing} selected={selected}>
        {children}
      </RowContent>
      {tip ? <Tip label={tip} /> : null}
    </button>
  )
})

/** 兼容旧调用；等价于 <MenuSeparator />。 */
export const MenuDivider = MenuSeparator

const FIELD_SIZE: Record<ControlSize, string> = {
  sm: 'h-[28px] rounded-md px-2 text-[13px]',
  md: 'h-[32px] rounded-lg px-2.5 text-[13px]',
  lg: 'h-[36px] rounded-[10px] px-3 text-[13px]',
}

export interface MenuSelectOption<T extends string> {
  value: T
  label: ReactNode
  hint?: string
  disabled?: boolean
  disabledReason?: string
}

export interface MenuSelectProps<T extends string> {
  value: T
  onChange: (value: T) => void
  options: ReadonlyArray<MenuSelectOption<T>>
  size?: ControlSize
  className?: string
  wrapperClassName?: string
  panelClassName?: string
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
}

/** 与 Input/Button 同尺寸的统一下拉选择；选项由同一个 Menu 原语渲染。 */
export function MenuSelect<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  wrapperClassName,
  panelClassName,
  disabled,
  placeholder,
  'aria-label': ariaLabel,
}: MenuSelectProps<T>) {
  const current = options.find((option) => option.value === value)
  return (
    <Menu
      aria-label={ariaLabel}
      align="start"
      className={cn('min-w-[200px]', panelClassName)}
      trigger={({ open }) => (
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-expanded={open}
          className={cn(
            'flex w-full min-w-0 items-center gap-1 border border-border bg-surface text-left text-text outline-none transition-[border-color,background-color] duration-[120ms] focus-visible:border-border-strong disabled:cursor-not-allowed disabled:opacity-40',
            FIELD_SIZE[size],
            open && 'border-border-strong',
            wrapperClassName,
            className,
          )}
        >
          <span className={cn('min-w-0 flex-1 truncate', !current && 'text-muted')}>
            {current?.label ?? placeholder ?? value}
          </span>
          <ChevronDown size={14} aria-hidden className="shrink-0 text-muted" />
        </button>
      )}
    >
      <Menu.RadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
        {options.map((option) => (
          <Menu.RadioItem
            key={option.value}
            value={option.value}
            hint={option.hint}
            disabled={option.disabled}
            disabledReason={option.disabledReason}
          >
            {option.label}
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </Menu>
  )
}

/** 新名字：选择器统一从 ui/Menu 导出为 Select。 */
export const Select = MenuSelect

