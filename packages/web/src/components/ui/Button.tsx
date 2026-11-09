import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Tip } from './Tooltip'

export type ControlSize = 'sm' | 'md' | 'lg'
export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger-ghost'

const SIZE_CLASS: Record<ControlSize, string> = {
  sm: 'h-[28px] rounded-md px-2.5 gap-1.5 [&_svg]:size-3.5',
  md: 'h-[32px] rounded-lg px-3 gap-1.5 [&_svg]:size-4',
  lg: 'h-[36px] rounded-[10px] px-3.5 gap-2 [&_svg]:size-4',
}

const ICON_SIZE_CLASS: Record<ControlSize, string> = {
  sm: 'size-[28px] rounded-md [&_svg]:size-3.5',
  md: 'size-[32px] rounded-lg [&_svg]:size-4',
  lg: 'size-[36px] rounded-[10px] [&_svg]:size-4',
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'border border-transparent bg-[var(--t-primary-bg)] text-[var(--t-primary-fg)] hover:bg-[var(--t-primary-hover)]',
  accent:
    'border border-transparent bg-accent-strong text-on-accent hover:bg-accent-strong-hover',
  secondary:
    'border border-border bg-[var(--t-surface-2)] text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text',
  ghost:
    'border border-transparent text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text',
  'danger-ghost':
    'border border-transparent text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-danger',
}

const BASE =
  // 反馈10#07：按钮也承载选项卡/菜单项文字；行高 ≥ 1.4 才不会被固定高度裁掉字形上下缘。
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap text-left text-[13px] font-medium leading-[1.4] transition-[background-color,border-color,color,opacity,transform] duration-[80ms] active:scale-[.98] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--t-focus-ring)]'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ControlSize
  /** 悬停/聚焦时显示的统一 tooltip；同时作为 aria-label 的兜底。 */
  tooltip?: string
  tooltipSide?: 'top' | 'bottom'
  /** 前置图标或任意内容。 */
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    tooltip,
    tooltipSide = 'bottom',
    icon,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        BASE,
        SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        className,
      )}
      aria-label={rest['aria-label'] ?? (tooltip && !children ? tooltip : undefined)}
      {...rest}
    >
      {icon}
      {children}
      {tooltip ? <Tip label={tooltip} side={tooltipSide} /> : null}
    </button>
  )
})

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** 无障碍名称；tooltip 缺省时同时作为 tooltip 文案。 */
  label: string
  variant?: ButtonVariant
  size?: ControlSize
  tooltip?: string
  tooltipSide?: 'top' | 'bottom'
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    variant = 'ghost',
    size = 'md',
    tooltip,
    tooltipSide = 'bottom',
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const tip = tooltip ?? label
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        BASE,
        ICON_SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        className,
      )}
      {...rest}
    >
      {children}
      {tip ? <Tip label={tip} side={tooltipSide} /> : null}
    </button>
  )
})
