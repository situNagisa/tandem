import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Tip } from './Tooltip'

/**
 * 控件 32 / 图标 32 / 行内 24（打分卡 U1-A）。
 * sm / lg 保留为类型兼容，渲染高度与 md 相同；新代码只用 md 与 inline。
 */
export type ControlSize = 'inline' | 'sm' | 'md' | 'lg'
export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger-ghost'

const CONTROL_CLASS = 'h-[32px] rounded-lg px-3 gap-1.5 max-md:min-h-11 [&_svg]:size-4'
const SIZE_CLASS: Record<ControlSize, string> = {
  inline: 'h-6 rounded-md px-1 gap-1 text-[12px] [&_svg]:size-3.5',
  sm: CONTROL_CLASS,
  md: CONTROL_CLASS,
  lg: CONTROL_CLASS,
}

const ICON_CLASS = 'size-[32px] rounded-lg max-md:size-11 [&_svg]:size-4'
const ICON_SIZE_CLASS: Record<ControlSize, string> = {
  inline: 'size-6 rounded-md [&_svg]:size-3.5',
  sm: ICON_CLASS,
  md: ICON_CLASS,
  lg: ICON_CLASS,
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'border border-transparent bg-[var(--t-primary-bg)] text-[var(--t-primary-fg)] hover:bg-[var(--t-primary-hover)] active:opacity-90',
  accent:
    'border border-transparent bg-accent-strong text-on-accent hover:bg-accent-strong-hover active:opacity-90',
  secondary:
    'border border-border bg-[var(--t-surface-2)] text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text active:bg-[var(--t-bg-active)]',
  ghost:
    'border border-transparent text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text active:bg-[var(--t-bg-active)]',
  'danger-ghost':
    'border border-transparent text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-danger active:bg-[var(--t-bg-active)]',
}

/** 调试版「调整」按变体名换 class 时读取；样式仍以本文件为准，不要在别处复制。 */
export const BUTTON_VARIANT_CLASS = VARIANT_CLASS

const BASE =
  // 反馈10#07：按钮也承载选项卡/菜单项文字；行高 ≥ 1.4 才不会被固定高度裁掉字形上下缘。
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap text-left text-[13px] font-medium leading-[1.4] transition-[background-color,border-color,color,opacity,transform] duration-[80ms] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--t-focus-ring)]'

// 反馈14#01/#02（R52 复发）：Radix 用触发器的 rect 定位弹层，按下时缩放会让面板
// 跟着触发器一起缩、松手再弹回，点开瞬间就是一次抖动。弹层触发器不做按压缩放。
const PRESS_SCALE = 'active:scale-[.98]'

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
      data-variant={variant}
      data-size={size}
      className={cn(
        BASE,
        !rest['aria-haspopup'] && PRESS_SCALE,
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
      data-variant={variant}
      data-size={size}
      data-icon-button=""
      className={cn(
        BASE,
        !rest['aria-haspopup'] && PRESS_SCALE,
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
