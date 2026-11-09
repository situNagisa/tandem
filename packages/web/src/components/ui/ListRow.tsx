import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import { cn } from '../../lib/cn'
import { useOverflowTitle } from '../../lib/hooks'
import { Tip } from './Tooltip'

export type ListRowSize = 'sm' | 'md'

const SIZE: Record<ListRowSize, string> = {
  sm: 'min-h-[28px] px-1.5 py-0 text-[13px]', // ui-audit-ignore 紧凑列表行高度
  md: 'min-h-[32px] px-2 py-1 text-[13.5px]',
}

export interface ListRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  icon?: ReactNode
  title: ReactNode
  /** 标题下方或右侧的次要信息。 */
  detail?: ReactNode
  /** 行尾内容（时间、计数、快捷操作）。 */
  trailing?: ReactNode
  selected?: boolean
  size?: ListRowSize
  tooltip?: string
  /** 紧凑单行；false 时标题与详情上下排列。 */
  inline?: boolean
  /**
   * 行内还要放按钮（如行尾的挂载/修复图标）时渲染成 div；
   * 此时点击、禁用与 type 不生效，只保留列表行的视觉与 hover。
   */
  as?: 'button' | 'div'
}

/**
 * 侧栏 / 设置 / 任意列表的统一样式行：32px 高、圆角 8、选中用中性底色。
 * 菜单行用 Menu.Item；这里是可使用鼠标点击的普通列表行。
 */
function ListRowTitle({ title, fallback }: { title: ReactNode; fallback?: boolean }) {
  const [ref, overflow] = useOverflowTitle<HTMLSpanElement>([title])
  return (
    <span
      ref={ref}
      className="min-w-0 truncate"
      data-tip={
        !fallback && overflow && (typeof title === 'string' || typeof title === 'number')
          ? String(title)
          : undefined
      }
    >
      {title}
    </span>
  )
}

export const ListRow = forwardRef<HTMLButtonElement | HTMLDivElement, ListRowProps>(function ListRow(
  {
    icon,
    title,
    detail,
    trailing,
    selected = false,
    size = 'md',
    tooltip,
    inline = true,
    as = 'button',
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const classes = cn(
    'group/row flex w-full min-w-0 select-none items-center gap-2 rounded-lg text-left text-text-soft outline-none transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text',
    as === 'button' &&
      'focus-visible:bg-[var(--t-bg-hover)] focus-visible:text-text disabled:pointer-events-none disabled:opacity-40',
    SIZE[size],
    selected && 'bg-[var(--t-bg-active)] text-text',
    className,
  )
  const body = (
    <>
      {icon && (
        <span className="flex size-4 shrink-0 items-center justify-center text-muted [&_svg]:size-4">
          {icon}
        </span>
      )}
      <span className={cn('min-w-0 flex-1', inline ? 'flex items-baseline gap-2' : 'flex flex-col')}>
        <ListRowTitle title={title} fallback={!!tooltip} />
        {detail && (
          <span
            className={cn(
              'min-w-0 truncate text-[12px] text-muted',
              !inline && 'mt-0.5 leading-4',
            )}
          >
            {detail}
          </span>
        )}
      </span>
      {trailing && <span className="shrink-0 text-[12px] text-muted">{trailing}</span>}
      {tooltip ? <Tip label={tooltip} /> : null}
    </>
  )

  if (as === 'div') {
    return (
      <div
        ref={ref as Ref<HTMLDivElement>}
        aria-current={selected ? 'true' : undefined}
        className={classes}
        {...(rest as HTMLAttributes<HTMLDivElement>)}
      >
        {body}
      </div>
    )
  }
  return (
    <button
      ref={ref as Ref<HTMLButtonElement>}
      type={type}
      aria-current={selected ? 'true' : undefined}
      className={classes}
      {...rest}
    >
      {body}
    </button>
  )
})
