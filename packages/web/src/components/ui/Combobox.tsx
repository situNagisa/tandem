import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { ControlSize } from './Button'
import { MenuItem, MenuList } from './Menu'
import { Popover } from './Popover'

const FIELD_SIZE: Record<ControlSize, string> = {
  inline: 'h-6 rounded-md px-1.5 text-[12px]',
  sm: 'h-[28px] rounded-md px-2 text-[13px]', // ui-audit-ignore 输入框高度
  md: 'h-[32px] rounded-lg px-2.5 text-[13px]',
  lg: 'h-[36px] rounded-[10px] px-3 text-[13px]',
}

const FIELD_BASE =
  'w-full min-w-0 border border-border bg-surface text-text outline-none transition-[border-color,background-color] duration-[120ms] placeholder:text-muted focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-40'

export interface ComboboxProps {
  value: string
  onChange: (value: string) => void
  /** 候选列表；输入时按包含关系过滤。 */
  options: readonly string[]
  placeholder?: string
  'aria-label'?: string
  size?: ControlSize
  className?: string
  id?: string
  disabled?: boolean
  /** 回车但没有选中候选时的回调（例如「添加」）。 */
  onSubmit?: () => void
  emptyText?: string
  spellCheck?: boolean
}

/**
 * 可输入 + 候选列表的下拉框，替代浏览器自带候选下拉（反馈10#06 / R37）。
 * 候选、键盘与视觉都复用 `ui/Menu`；不选中候选时保留用户输入的自由文本。
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  'aria-label': ariaLabel,
  size = 'md',
  className,
  id,
  disabled,
  onSubmit,
  emptyText = '没有匹配项',
  spellCheck = false,
}: ComboboxProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase()
    const list = q ? options.filter((option) => option.toLowerCase().includes(q)) : options
    return list.slice(0, 100)
  }, [options, value])

  const pick = (option: string) => {
    onChange(option)
    setOpen(false)
    inputRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(0)
        return
      }
      if (filtered.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive((prev) => (prev + delta + filtered.length) % filtered.length)
      return
    }
    if (event.key === 'Enter') {
      const option = open ? filtered[active] : undefined
      if (option) {
        event.preventDefault()
        pick(option)
        return
      }
      if (onSubmit) {
        event.preventDefault()
        setOpen(false)
        onSubmit()
      }
      return
    }
    if (event.key === 'Escape') {
      if (!open) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => {
        if (!disabled) setOpen(next)
      }}
      side="bottom"
      align="left"
      padded={false}
      className="w-full"
      panelClassName="w-[var(--radix-popover-trigger-width)] min-w-[220px] p-0"
      trigger={() => (
        <div className="relative w-full">
          <input
              ref={inputRef}
              id={id}
              role="combobox"
              aria-label={ariaLabel}
              aria-expanded={open}
              aria-autocomplete="list"
              aria-controls={open ? `${id ?? 'combobox'}-list` : undefined}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={spellCheck}
              disabled={disabled}
              value={value}
              placeholder={placeholder}
              onChange={(event) => {
                onChange(event.target.value)
                setActive(0)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              className={cn(FIELD_BASE, FIELD_SIZE[size], 'pr-7 font-mono', className)}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted"
            >
              <ChevronDown size={12} />
            </span>
          </div>
      )}
    >
      {(close) => (
        <MenuList
          aria-label={ariaLabel}
          keyboard={false}
          activeIndex={active}
          onActiveIndexChange={setActive}
          className="max-h-[200px] overflow-y-auto"
        >
          {filtered.map((option) => (
            <MenuItem
              key={option}
              title={option}
              onMouseDown={(event) => event.preventDefault()}
              onSelect={() => {
                pick(option)
                close()
              }}
            >
              {option}
            </MenuItem>
          ))}
          {filtered.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] leading-4 text-muted">{emptyText}</p>
          )}
        </MenuList>
      )}
    </Popover>
  )
}
