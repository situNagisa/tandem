import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { ControlSize } from './Button'

const FIELD_SIZE: Record<ControlSize, string> = {
  sm: 'h-[28px] rounded-md px-2 text-[12.5px]',
  md: 'h-[32px] rounded-lg px-2.5 text-[13px]',
  lg: 'h-[36px] rounded-[10px] px-3 text-[13px]',
}

const FIELD_BASE =
  'w-full min-w-0 border border-border bg-surface text-text outline-none transition-[border-color,background-color] duration-[120ms] placeholder:text-muted focus:border-border-strong disabled:cursor-not-allowed disabled:opacity-40'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: ControlSize
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', className, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(FIELD_BASE, FIELD_SIZE[size], className)} {...rest} />
})

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: ControlSize
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', className, children, ...rest },
  ref,
) {
  return (
    <span className="relative inline-flex w-full min-w-0 items-center">
      <select
        ref={ref}
        className={cn(FIELD_BASE, FIELD_SIZE[size], 'appearance-none pr-7', className)}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        aria-hidden
        className="pointer-events-none absolute right-2 shrink-0 text-muted"
      />
    </span>
  )
})

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  title?: string
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  size?: ControlSize
  className?: string
  'aria-label'?: string
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  const item = size === 'sm' ? 'h-[24px] px-2 text-[12px]' : 'h-[28px] px-2.5 text-[12.5px]'
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg bg-[var(--t-surface-2)] p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-md font-medium leading-none transition-colors duration-[120ms]',
              item,
              selected
                ? 'bg-[var(--t-bg-active)] text-text'
                : 'text-muted hover:bg-[var(--t-bg-hover)] hover:text-text',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label: string
  className?: string
}

/** 中性开关：轨道 36×20，滑块近白；不参与橙色强调。 */
export function Switch({ checked, onChange, disabled, label, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:opacity-40',
        checked
          ? 'border-transparent bg-[color-mix(in_srgb,var(--t-text)_45%,transparent)]'
          : 'border-border bg-[var(--t-bg-active)]',
        className,
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] size-[14px] rounded-full bg-white shadow-sm transition-[left] duration-[120ms]',
          checked ? 'left-[19px]' : 'left-[2px]',
        )}
      />
    </button>
  )
}
