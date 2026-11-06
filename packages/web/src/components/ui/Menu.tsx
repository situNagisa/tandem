import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { ControlSize } from './Button'
import { Popover } from './Popover'

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
  // 禁用的选项也允许悬停：用 tooltip 说明不可选的原因。
  if (item.getAttribute('aria-disabled') === 'true' && !item.dataset.tip) return null
  return item
}

/**
 * 统一弹出列表：30px 单行选项，说明通过右侧浮层 tooltip 展示。
 * 不使用组标题；需要分组时用 MenuDivider 细分隔线。
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
  const [tipText, setTipText] = useState('')
  const [tipPos, setTipPos] = useState<{ left: number; top: number; width: number } | null>(null)

  const setActiveItem = useCallback((el: HTMLElement | null) => {
    for (const prev of ref.current?.querySelectorAll<HTMLElement>('[data-active]') ?? []) {
      prev.removeAttribute('data-active')
    }
    if (el && el.isConnected) {
      el.setAttribute('data-active', 'true')
      setActive(el)
      setTipText(el.dataset.tip ?? '')
    } else {
      setActive(null)
      setTipText('')
    }
  }, [])

  const placeTip = useCallback(() => {
    if (!active || !active.isConnected || !tipText) {
      setTipPos(null)
      return
    }
    const rect = active.getBoundingClientRect()
    const width = Math.min(240, Math.max(160, window.innerWidth - 16))
    let left = rect.right + 10
    if (left + width > window.innerWidth - 8) left = rect.left - width - 10
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    const top = Math.max(76, Math.min(rect.top + rect.height / 2, window.innerHeight - 76))
    setTipPos({ left, top, width })
  }, [active, tipText])

  useLayoutEffect(() => {
    placeTip()
  }, [placeTip])

  useEffect(() => {
    if (!active) return
    const update = () => placeTip()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [active, placeTip])

  useEffect(() => {
    if (activeIndex === undefined) return
    const items = menuItemsOf(ref.current)
    setActiveItem(items[activeIndex] ?? null)
    // 列表过滤后重新对齐受控索引
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
    <>
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
      {tipPos &&
        tipText &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[95] rounded-md border border-border bg-surface px-2 py-1 text-[11.5px] leading-[1.45] text-text-soft shadow-[var(--t-shadow-sm)]"
            style={{
              left: tipPos.left,
              top: tipPos.top,
              width: tipPos.width,
              transform: 'translateY(-50%)',
            }}
          >
            {tipText}
          </div>,
          document.body,
        )}
    </>
  )
}

export interface MenuItemProps {
  children: ReactNode
  icon?: ReactNode
  /** 悬停/键盘高亮时显示在列表旁的说明。 */
  hint?: string
  /** 禁用原因：选项不可选时悬停显示，替代 hint。 */
  disabledReason?: string
  selected?: boolean
  trailing?: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect?: () => void
  onMouseDown?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox'
  ariaChecked?: boolean
  className?: string
  title?: string
}

export function MenuItem({
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
  role = 'menuitem',
  ariaChecked,
  className,
  title,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={ariaChecked}
      disabled={disabled && !disabledReason}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : undefined}
      title={title}
      data-menu-item=""
      data-tip={disabled ? (disabledReason ?? hint) : hint}
      data-selected={selected || undefined}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
      onMouseDown={(e) => {
        if (!disabled) onMouseDown?.(e)
      }}
      className={cn(
        'flex h-[30px] w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[13px] leading-none text-text-soft transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text data-[active=true]:bg-[var(--t-bg-hover)] data-[active=true]:text-text focus-visible:bg-[var(--t-bg-hover)] focus-visible:text-text focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-soft aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:text-text-soft',
        selected && 'text-text',
        danger && 'text-danger hover:text-danger focus-visible:text-danger',
        className,
      )}
    >
      {icon && (
        <span className="flex size-4 shrink-0 items-center justify-center text-muted [&_svg]:size-3.5">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && <span className="shrink-0 text-[10.5px] text-muted">{trailing}</span>}
      {selected && <Check size={13} className="shrink-0 text-text-secondary" />}
    </button>
  )
}

export function MenuDivider({ className }: { className?: string }) {
  return <div role="separator" className={cn('my-1 h-px shrink-0 bg-border', className)} />
}

const FIELD_SIZE: Record<ControlSize, string> = {
  sm: 'h-[28px] rounded-md px-2 text-[12.5px]',
  md: 'h-[32px] rounded-lg px-2.5 text-[13px]',
  lg: 'h-[36px] rounded-[10px] px-3 text-[13px]',
}

export interface MenuSelectOption<T extends string> {
  value: T
  label: ReactNode
  hint?: string
  disabled?: boolean
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
  'aria-label'?: string
}

/** 与 Input/Select 同尺寸的弹出下拉，选项用统一紧凑列表。 */
export function MenuSelect<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  wrapperClassName,
  panelClassName,
  disabled,
  'aria-label': ariaLabel,
}: MenuSelectProps<T>) {
  const current = options.find((option) => option.value === value)
  return (
    <Popover
      side="bottom"
      align="left"
      padded={false}
      className={cn('relative inline-flex min-w-0', wrapperClassName ?? 'w-full')}
      panelClassName={cn('w-[240px] max-w-[calc(100vw-2rem)]', panelClassName)}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="menu"
          className={cn(
            'flex w-full min-w-0 items-center gap-1 border border-border bg-surface text-left text-text outline-none transition-[border-color,background-color] duration-[120ms] focus-visible:border-border-strong disabled:cursor-not-allowed disabled:opacity-40',
            FIELD_SIZE[size],
            open && 'border-border-strong',
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate">{current?.label ?? value}</span>
          <ChevronDown size={14} aria-hidden className="shrink-0 text-muted" />
        </button>
      )}
    >
      {(close) => (
        <MenuList aria-label={ariaLabel}>
          {options.map((option) => (
            <MenuItem
              key={option.value}
              hint={option.hint}
              selected={option.value === value}
              disabled={option.disabled}
              role="menuitemradio"
              ariaChecked={option.value === value}
              onSelect={() => {
                close()
                if (option.value !== value) onChange(option.value)
              }}
            >
              {option.label}
            </MenuItem>
          ))}
        </MenuList>
      )}
    </Popover>
  )
}
