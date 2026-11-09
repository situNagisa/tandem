import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Tooltip } from './Tooltip'

export interface SettingRowProps {
  label: ReactNode
  /** 长说明：标题旁的小 ⓘ，悬停用标准 tooltip，不占表单行高。 */
  hint?: string
  htmlFor?: string
  /** 控件放在右侧；数值输入会自动收窄。 */
  children: ReactNode
  /** 紧贴控件右侧的单位（如 %、轮、tokens）。 */
  unit?: ReactNode
  /** 控件换到下一行（路径、多行文本、列表编辑）。 */
  stacked?: boolean
  /** 控件占满右侧可用宽度（下拉、路径输入）。 */
  wide?: boolean
  className?: string
}

export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
  unit,
  stacked = false,
  wide = false,
  className,
}: SettingRowProps) {
  return (
    <div className={cn('setting-row', className)} data-stacked={stacked || undefined}>
      <div className="setting-row-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint ? (
          <span className="setting-row-hint">
            <Tooltip label={hint}>
              <Info size={12} aria-hidden />
            </Tooltip>
          </span>
        ) : null}
      </div>
      <div className="setting-row-control" data-wide={wide || undefined}>
        {children}
        {unit ? <span className="setting-row-unit">{unit}</span> : null}
      </div>
    </div>
  )
}

export interface SettingSectionProps {
  title: ReactNode
  icon?: ReactNode
  /** 一句话可见说明；更长的内容放 hint。 */
  description?: ReactNode
  /** 标题旁 ⓘ 的完整说明。 */
  hint?: string
  children: ReactNode
  className?: string
  settingId?: string
}

/** 设置卡片：紧凑内边距 + 标题行 ⓘ；页面只写内容。 */
export function SettingSection({
  title,
  icon,
  description,
  hint,
  children,
  className,
  settingId,
}: SettingSectionProps) {
  return (
    <section
      data-setting-id={settingId}
      className={cn('rounded-xl border border-border bg-surface', className)}
    >
      <div className={cn(icon ? 'flex items-start gap-2.5' : undefined)}>
        {icon ? <span className="mt-0.5 shrink-0 text-muted">{icon}</span> : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="min-w-0 text-[13px] font-medium">{title}</h3>
            {hint ? (
              <span className="setting-row-hint">
                <Tooltip label={hint}>
                  <Info size={12} aria-hidden />
                </Tooltip>
              </span>
            ) : null}
          </div>
          {description ? (
            <p className="mt-0.5 truncate text-[12px] leading-4 text-muted">{description}</p>
          ) : null}
          <div className={description ? 'mt-2' : 'mt-1.5'}>{children}</div>
        </div>
      </div>
    </section>
  )
}
