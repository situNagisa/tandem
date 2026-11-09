import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Card } from './Card'
import { Tooltip } from './Tooltip'

export interface SettingRowProps {
  label: ReactNode
  /** 标题前的小图标：固定 14px 槽位，整页图标列左缘一致，与标题垂直居中。 */
  icon?: ReactNode
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
  icon,
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
      <div className="setting-row-label" data-has-icon={icon ? true : undefined}>
        {icon ? <span className="setting-row-icon">{icon}</span> : null}
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

export interface SettingNoteProps {
  children: ReactNode
  icon?: ReactNode
  /** 与同一行标题文字的左缘对齐（标题前有 14px 图标槽时用）。 */
  indent?: boolean
  tone?: 'muted' | 'warning'
  className?: string
}

/** 设置行下方的次要说明：小图标 + 小字，缩进与标题对齐，不压卡片边框。 */
export function SettingNote({
  children,
  icon,
  indent = false,
  tone = 'muted',
  className,
}: SettingNoteProps) {
  return (
    <p
      className={cn('setting-note', className)}
      data-indent={indent || undefined}
      data-tone={tone}
    >
      {icon ? <span className="setting-note-icon">{icon}</span> : null}
      <span className="min-w-0 flex-1">{children}</span>
    </p>
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
    <Card data-setting-id={settingId} className={className}>
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
    </Card>
  )
}
