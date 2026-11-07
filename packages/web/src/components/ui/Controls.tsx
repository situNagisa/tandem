import {
  Children,
  forwardRef,
  isValidElement,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '../../lib/cn'
import type { ControlSize } from './Button'
import { MenuSelect } from './Menu'

const FIELD_SIZE: Record<ControlSize, string> = {
  sm: 'h-[28px] rounded-md px-2 text-[13px]',
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

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  size?: ControlSize
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { size = 'md', className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        FIELD_BASE,
        'min-h-[64px] resize-y py-1.5 leading-5',
        size === 'sm' ? 'rounded-md px-2 text-[12.5px]' : 'rounded-lg px-2.5 text-[13px]',
        className,
      )}
      {...rest}
    />
  )
})

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: ControlSize
  wrapperClassName?: string
}

/**
 * 统一下拉选择。保留原生 <option> 写法以兼容旧调用，但实际渲染的是
 * ui/Menu 的弹出列表——尺寸、hover、选中、键盘与全应用一致。
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', className, wrapperClassName, children, onChange, value, disabled, ...rest },
  _ref,
) {
  const options = Children.toArray(children).flatMap((child) => {
    if (!isValidElement<{ value?: unknown; children?: ReactNode; disabled?: boolean }>(child)) {
      return []
    }
    return [
      {
        value: String(child.props.value ?? ''),
        label: child.props.children,
        disabled: child.props.disabled,
      },
    ]
  })
  const current = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return (
    <span className={cn('relative flex min-w-0 items-center', wrapperClassName ?? 'w-full')}>
      <MenuSelect
        size={size}
        value={current}
        options={options}
        disabled={disabled}
        className={className}
        aria-label={rest['aria-label']}
        onChange={(next) => {
          onChange?.({
            target: { value: next },
            currentTarget: { value: next },
          } as ChangeEvent<HTMLSelectElement>)
        }}
      />
    </span>
  )
})

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  title?: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  size?: ControlSize
  className?: string
  disabled?: boolean
  'aria-label'?: string
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
  disabled,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  const item = size === 'sm' ? 'h-[24px] px-2 text-[12px]' : 'h-[28px] px-2.5 text-[13px]'
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-lg bg-[var(--t-surface-2)] p-0.5',
        disabled && 'opacity-40',
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
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-md font-medium leading-none transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:opacity-40',
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
  /** 无障碍名称；已有可见文字标签时可省略。 */
  label?: string
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
          : 'border-transparent bg-[color-mix(in_srgb,var(--t-text)_18%,transparent)]',
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
