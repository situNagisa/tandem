/**
 * 调整工具右侧的面板：换图标、插入控件、容器展开编辑、行为备注、改动清单。
 * 全部是反馈 UI（data-feedback-ui），不参与冻结副本与导出截图。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import * as RPopover from '@radix-ui/react-popover'
import { Layers, ListChecks, MessageSquare, PencilLine, Plus, X } from 'lucide-react'
import { Badge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Input, Textarea } from '../ui/Controls'
import { cn } from '../../lib/cn'
import { portalLayer } from '../../lib/overlay'
import { ADJUST_ICONS, type AdjustIconEntry } from './adjustIcons.generated'
import { renderInsertPreview } from './feedbackAdjustInsert'
import {
  INSERT_GROUPS,
  INSERT_OPTIONS,
  adjustKindLabel,
  type AdjustInsertOption,
  type AdjustInsertedItem,
  type AdjustInsertedRow,
  type AdjustOp,
} from './feedbackAdjust'
import { UI_ATTR } from './feedbackModeHelpers'

// 调整工具是调试版浮层（Radix 负责定位），沿用反馈工具原有的紧凑面板样式。
export const PANEL_SURFACE = 'flex flex-col rounded-xl border border-border bg-surface p-2 shadow-lg' // ui-audit-ignore 浮层表面（非卡片）
export const PANEL_CLASS = `pointer-events-auto fixed z-[133] ${PANEL_SURFACE}`

export interface AdjustRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

interface AdjustFloatingProps {
  /** 虚拟锚点（视口坐标），由 Radix 负责翻转/平移，不手写弹层坐标。 */
  anchor: { x: number; y: number }
  side: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  /** 视口边缘留白，也用于把其它调整浮层的位置让出来。 */
  padding?: number | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>
  layer?: number
  dataAttrs?: Record<string, string>
  ariaLabel?: string
  className?: string
  style?: CSSProperties
  children: ReactNode
  onRect?: (rect: AdjustRect) => void
}

/** 调整工具的浮层：与 ui/Popover 同一套 Radix 碰撞避让，锚点只给参照元素/边缘。 */
export function AdjustFloating({
  anchor,
  side,
  align = 'start',
  sideOffset = 8,
  padding = 8,
  layer = 133,
  dataAttrs,
  ariaLabel,
  className,
  style,
  children,
  onRect,
}: AdjustFloatingProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const reportRef = useRef(onRect)
  reportRef.current = onRect
  const report = useCallback(() => {
    const element = contentRef.current
    if (!element || !reportRef.current) return
    const rect = element.getBoundingClientRect()
    reportRef.current({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    })
  }, [])
  useEffect(() => {
    // Radix 在布局阶段/下一帧完成定位，量两次并跟随尺寸变化。
    const frames: number[] = []
    const first = requestAnimationFrame(() => {
      const second = requestAnimationFrame(report)
      frames.push(second)
    })
    frames.push(first)
    const element = contentRef.current
    const observer = element ? new ResizeObserver(report) : null
    if (element) observer?.observe(element)
    window.addEventListener('resize', report)
    return () => {
      for (const frame of frames.splice(0)) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [report, anchor.x, anchor.y])
  return (
    <RPopover.Root open modal={false}>
      <RPopover.Anchor asChild>
        <span
          aria-hidden
          style={{ position: 'fixed', left: anchor.x, top: anchor.y, width: 0, height: 0, pointerEvents: 'none' }}
        />
      </RPopover.Anchor>
      <RPopover.Portal>
        <RPopover.Content
          {...portalLayer('adjust')}
          role="dialog"
          aria-label={ariaLabel}
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={padding}
          avoidCollisions
          sticky="always"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onFocusOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className={cn('outline-none', layer === 134 ? 'z-[134]' : 'z-[133]')}
        >
          <div
            ref={contentRef}
            {...{ [UI_ATTR]: '' }}
            {...dataAttrs}
            className={className}
            style={style}
          >
            {children}
          </div>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}

/** 窄视口（手机/小窗）下，插入面板改为底部抽屉。 */
export function useWideViewport(): boolean {
  const [wide, setWide] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth >= 1024))
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)')
    const update = () => setWide(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return wide
}

interface IconPickerProps {
  currentIcon?: string
  query: string
  onQueryChange: (query: string) => void
  onPick: (entry: AdjustIconEntry) => void
  onClose: () => void
}

export function AdjustIconPicker({ currentIcon, query, onQueryChange, onPick, onClose }: IconPickerProps) {
  const normalized = query.trim().toLowerCase()
  const filtered = normalized
    ? ADJUST_ICONS.filter(
        (entry) => entry.name.includes(normalized) || entry.keywords.includes(normalized),
      )
    : ADJUST_ICONS
  return (
    <div
      {...{ [UI_ATTR]: '' }}
      data-adjust-icon-picker=""
      className={cn(PANEL_CLASS, 'bottom-20 right-4 max-h-[min(460px,70vh)] w-[318px]')}
      role="dialog"
      aria-label="替换图标"
    >
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        <WandIcon />
        <span className="text-[12.5px] font-medium text-text">替换图标</span>
        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted">
          lucide · {currentIcon ?? '—'}
        </span>
        <IconButton label="关闭图标选择器" size="inline" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </div>
      <Input
        size="sm"
        autoFocus
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="搜索图标（名称或中文关键词）"
        aria-label="搜索图标"
      />
      <p className="px-1 pb-1 pt-1 text-[11px] text-muted">
        只列项目在用的 lucide 图标（{ADJUST_ICONS.length} 个）。
      </p>
      <div className="grid min-h-0 grid-cols-8 gap-0.5 overflow-y-auto p-0.5">
        {filtered.map((entry) => {
          const Icon = entry.Icon
          return (
            <button
              data-raw-button
              key={entry.name}
              type="button"
              data-tip={entry.name}
              aria-label={`使用图标 ${entry.name}`}
              data-adjust-icon={entry.name}
              className={cn(
                'flex size-8 items-center justify-center rounded-md text-text-secondary hover:bg-hover hover:text-text',
                currentIcon === entry.name && 'bg-hover text-text',
              )}
              onClick={() => onPick(entry)}
            >
              <Icon size={16} />
            </button>
          )
        })}
        {filtered.length === 0 && (
          <p className="col-span-8 py-4 text-center text-[12px] text-muted">没有匹配的图标</p>
        )}
      </div>
    </div>
  )
}

function WandIcon() {
  return <Layers size={13} className="text-annotation" />
}

interface InsertPanelProps {
  onPick: (option: AdjustInsertOption) => void
  onOptionPointerDown: (option: AdjustInsertOption, event: ReactPointerEvent<HTMLButtonElement>) => void
  onClose: () => void
  /** 底部调整工具条的上沿，窄视口下抽屉放在它上方。 */
  toolbarTop?: number
  /** 悬停预览出现/消失，父级据此重新计算选中工具条的避让边距。 */
  onPreviewChange?: (key: string | null) => void
}

export function AdjustInsertPanel({
  onPick,
  onOptionPointerDown,
  onClose,
  toolbarTop,
  onPreviewChange,
}: InsertPanelProps) {
  const [hover, setHover] = useState<AdjustInsertOption | null>(null)
  const [panelRect, setPanelRect] = useState<AdjustRect | null>(null)
  const wide = useWideViewport()
  const showHover = (option: AdjustInsertOption | null) => {
    setHover(option)
    onPreviewChange?.(option?.key ?? null)
  }
  const handleRect = useCallback((rect: AdjustRect) => {
    setPanelRect((prev) =>
      prev &&
      Math.abs(prev.left - rect.left) < 0.5 &&
      Math.abs(prev.top - rect.top) < 0.5 &&
      Math.abs(prev.width - rect.width) < 0.5 &&
      Math.abs(prev.height - rect.height) < 0.5
        ? prev
        : rect,
    )
  }, [])
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
  const bottomAnchor = Math.max(64, (toolbarTop ?? viewportHeight - 120) - 8)
  const panelAnchor = wide
    ? { x: viewportWidth - 12, y: 64 }
    : { x: viewportWidth / 2, y: bottomAnchor }
  const previewAnchor = panelRect
    ? wide
      ? { x: panelRect.left, y: panelRect.top }
      : { x: panelRect.left + panelRect.width / 2, y: panelRect.top }
    : null
  return (
    <>
      <AdjustFloating
        anchor={panelAnchor}
        side={wide ? 'left' : 'top'}
        align={wide ? 'start' : 'center'}
        padding={8}
        ariaLabel="插入控件"
        dataAttrs={{ 'data-adjust-insert-panel': '' }}
        onRect={handleRect}
        className={cn(
          PANEL_SURFACE,
          wide
            ? 'max-h-[min(560px,calc(100vh-96px))] w-[330px]'
            : 'max-h-[38vh] w-[calc(100vw-24px)] max-w-[480px]',
        )}
      >
        <div className="flex items-center gap-1.5 px-1 pb-1.5">
          <Plus size={13} className="text-annotation" />
          <span className="text-[12.5px] font-medium text-text">插入控件</span>
          <span className="ml-auto text-[11px] text-muted">ui/* 现有组件</span>
          <IconButton label="关闭插入面板" size="inline" onClick={onClose}>
            <X size={12} />
          </IconButton>
        </div>
        <p className="px-1 pb-1 text-[11px] text-muted">
          点按放在视口中部，或拖到画面上落下。
        </p>
        <div className="min-h-0 overflow-y-auto">
          {INSERT_GROUPS.map((group) => {
            const options = INSERT_OPTIONS.filter((option) => option.group === group)
            if (options.length === 0) return null
            return (
              <div key={group} className="pb-1">
                <p className="px-1 pb-0.5 text-[11px] text-muted">{group}</p>
                {options.map((option) => (
                  <button
                    data-raw-button
                    key={option.key}
                    type="button"
                    data-insert-option={option.key}
                    className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-left text-[12.5px] text-text-soft hover:bg-hover hover:text-text"
                    onClick={() => onPick(option)}
                    onPointerDown={(event) => onOptionPointerDown(option, event)}
                    onPointerEnter={() => showHover(option)}
                    onFocus={() => showHover(option)}
                  >
                    <span>{option.label}</span>
                    <span className="text-[11px] text-muted">{option.variant}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </AdjustFloating>
      {hover && previewAnchor && (
        <AdjustFloating
          anchor={previewAnchor}
          side={wide ? 'left' : 'top'}
          align={wide ? 'start' : 'center'}
          padding={8}
          ariaLabel={`${hover.label} 预览`}
          dataAttrs={{ 'data-adjust-insert-preview': hover.key }}
          className={cn(
            PANEL_SURFACE,
            'pointer-events-none w-[min(320px,calc(100vw-24px))]',
            !wide && 'max-h-[min(88px,20vh)] overflow-hidden',
          )}
        >
          <div className="flex items-center gap-1.5 px-1 pb-1.5">
            <span className="text-[12px] font-medium text-text">预览 · {hover.label}</span>
            <span className="ml-auto text-[11px] text-muted">
              ui/{hover.group === '组合控件' ? 'Card + ListRow' : hover.group}
            </span>
          </div>
          <p className="px-1 pb-1.5 text-[11px] text-muted max-lg:hidden">
            用真实 ui/* 组件渲染的示例；插入后按当前主题显示。
          </p>
          <div className="flex min-h-0 justify-center overflow-auto rounded-lg border border-dashed border-border bg-bg-subtle p-2 lg:p-3">
            {renderInsertPreview(hover)}
          </div>
        </AdjustFloating>
      )}
    </>
  )
}

interface ListEditorProps {
  item: AdjustInsertedItem
  onBehaviorChange: (value: string) => void
  onAddRow: () => void
  onUpdateRow: (rowId: string, patch: Partial<AdjustInsertedRow>) => void
  onRemoveRow: (rowId: string) => void
  onClose: () => void
}

const ROW_COMPONENTS: AdjustInsertedRow['component'][] = ['ListRow', 'Button', 'Badge']

export function AdjustListEditor({
  item,
  onBehaviorChange,
  onAddRow,
  onUpdateRow,
  onRemoveRow,
  onClose,
}: ListEditorProps) {
  return (
    <div
      {...{ [UI_ATTR]: '' }}
      data-adjust-expand=""
      className={cn(PANEL_CLASS, 'right-4 top-16 max-h-[min(620px,78vh)] w-[342px]')}
      role="dialog"
      aria-label="展开编辑"
    >
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        <Layers size={13} className="text-annotation" />
        <span className="text-[12.5px] font-medium text-text">
          {item.kind === 'menu' ? '菜单' : item.kind === 'card' ? '卡片' : '列表'} · 展开编辑
        </span>
        <IconButton label="关闭展开编辑" size="inline" className="ml-auto" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </div>
      <p className="px-1 pb-1 text-[11px] leading-4 text-muted">
        交互动作用文字备注；示意行只表达信息结构，实现时按 ui/* 复刻。
      </p>
      <Textarea
        size="sm"
        rows={2}
        value={item.behavior}
        onChange={(event) => onBehaviorChange(event.target.value)}
        placeholder="容器行为（如：按最近使用排序；点击行打开会话；空状态显示说明）"
        aria-label="容器行为备注"
      />
      <div className="mt-1.5 flex items-center gap-1 px-1">
        <span className="text-[12px] text-text">示意行 {item.rows.length}</span>
        <Button
          size="inline"
          variant="ghost"
          icon={<Plus size={12} />}
          className="ml-auto"
          onClick={onAddRow}
        >
          添加行
        </Button>
      </div>
      <div className="mt-1 min-h-0 space-y-1 overflow-y-auto">
        {item.rows.map((row, index) => (
          <div key={row.id} className="rounded-lg border border-border p-1.5">
            <div className="flex items-center gap-1">
              <span className="w-3 text-[11px] text-muted">{index + 1}</span>
              <Button
                size="inline"
                variant="ghost"
                tooltip="切换行组件（ListRow / Button / Badge）"
                onClick={() =>
                  onUpdateRow(row.id, {
                    component:
                      ROW_COMPONENTS[(ROW_COMPONENTS.indexOf(row.component) + 1) % ROW_COMPONENTS.length],
                  })
                }
              >
                {row.component}
              </Button>
              <Input
                size="inline"
                value={row.title}
                onChange={(event) => onUpdateRow(row.id, { title: event.target.value })}
                placeholder="行标题（如：会话标题）"
                aria-label={`第 ${index + 1} 行标题`}
              />
              <IconButton
                label={`删除第 ${index + 1} 行`}
                size="inline"
                onClick={() => onRemoveRow(row.id)}
              >
                <X size={11} />
              </IconButton>
            </div>
            <Input
              size="inline"
              className="mt-1"
              value={row.note}
              onChange={(event) => onUpdateRow(row.id, { note: event.target.value })}
              placeholder="行备注（显示哪些字段、点击/悬停行为）"
              aria-label={`第 ${index + 1} 行备注`}
            />
          </div>
        ))}
        {item.rows.length === 0 && (
          <p className="px-1 py-2 text-center text-[12px] text-muted">还没有示意行；点「添加行」。</p>
        )}
      </div>
    </div>
  )
}

interface NotePanelProps {
  title: string
  value: string
  onChange: (value: string) => void
  onSave: () => void
  onClose: () => void
}

export function AdjustNotePanel({ title, value, onChange, onSave, onClose }: NotePanelProps) {
  return (
    <div
      {...{ [UI_ATTR]: '' }}
      data-adjust-note-panel=""
      className={cn(PANEL_CLASS, 'bottom-24 right-4 w-[330px]')}
      role="dialog"
      aria-label="行为备注"
    >
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        <MessageSquare size={13} className="text-annotation" />
        <span className="text-[12.5px] font-medium text-text">行为备注</span>
        <IconButton label="关闭备注面板" size="inline" className="ml-auto" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </div>
      <p className="px-1 pb-1 text-[11px] leading-4 text-muted">
        {title} · 说明点击、悬停、展开后要做什么；导出后紧跟对应改动。
      </p>
      <Textarea
        size="sm"
        rows={3}
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSave()
        }}
        placeholder="例如：点击后打开设置 → 主机；悬停显示完整路径"
        aria-label="行为备注文字"
      />
      <div className="mt-1.5 flex justify-end gap-1">
        <Button size="inline" variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button size="inline" variant="primary" onClick={onSave}>
          保存备注
        </Button>
      </div>
    </div>
  )
}

interface ChangeListProps {
  ops: AdjustOp[]
  onSelect: (op: AdjustOp) => void
  onNote: (op: AdjustOp) => void
  onRevert: (op: AdjustOp) => void
}

function changeSubtitle(op: AdjustOp): string {
  const change = op.change
  if (change.kind === 'icon') {
    const before = (change.before as { icon?: string } | undefined)?.icon ?? '?'
    const after = (change.after as { icon?: string } | undefined)?.icon ?? '?'
    return `${before} → ${after}`
  }
  if (change.kind === 'reorder') {
    const index = (change.after as { index?: number } | undefined)?.index ?? 0
    return `第 ${index + 1} 个位置`
  }
  if (change.kind === 'insert') {
    return '示意草稿 · 按 ui/* 复刻'
  }
  if (change.kind === 'note') return '行为说明'
  return change.target.selector || change.target.tag
}

export function AdjustChangeList({ ops, onSelect, onNote, onRevert }: ChangeListProps) {
  const wide = useWideViewport()
  if (ops.length === 0) return null
  return (
    <AdjustFloating
      anchor={{ x: 12, y: wide ? 64 : 96 }}
      side="bottom"
      align="start"
      ariaLabel="改动清单"
      dataAttrs={{ 'data-adjust-changes': '' }}
      className={cn(
        PANEL_SURFACE,
        wide
          ? 'max-h-[min(440px,62vh)] w-[306px]'
          : 'max-h-[min(64px,12vh)] w-[min(306px,calc(100vw-24px))]',
      )}
    >
      <div className="flex items-center gap-1.5 px-1 pb-1">
        <ListChecks size={12} className="text-annotation" />
        <span className="text-[12.5px] font-medium text-text">改动清单</span>
        <span className="ml-auto text-[11px] text-muted">{ops.length} 项</span>
      </div>
      <div className="min-h-0 overflow-y-auto">
        {ops.map((op, index) => (
          <div
            key={op.change.id}
            data-adjust-change={op.change.kind}
            className="flex items-start gap-1.5 rounded-md px-1 py-1 hover:bg-hover"
          >
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-annotation text-[11px] font-semibold text-white">
              {index + 1}
            </span>
            <button
              data-raw-button
              type="button"
              className="min-w-0 flex-1 text-left"
              data-tip="在副本上定位这条改动"
              onClick={() => onSelect(op)}
            >
              <p className="truncate text-[12px] text-text">
                {adjustKindLabel(op.change.kind)} ·{' '}
                {String(
                  (op.change.after as { component?: string } | undefined)?.component ??
                    op.change.target.component ??
                    op.change.target.ariaLabel ??
                    op.change.target.tag,
                )}
              </p>
              <p className="truncate text-[11px] text-muted">{changeSubtitle(op)}</p>
              {op.change.behavior && (
                <p className="line-clamp-2 text-[11px] text-annotation" data-tip={op.change.behavior}>
                  备注：{op.change.behavior}
                </p>
              )}
              {op.change.standard === false && (
                <p className="text-[11px] text-warning">尺寸非标准值</p>
              )}
            </button>
            <button
              data-raw-button
              type="button"
              className="shrink-0 rounded px-1 text-[11px] text-muted hover:text-text"
              onClick={() => onNote(op)}
            >
              备注
            </button>
            <button
              data-raw-button
              type="button"
              className="shrink-0 rounded px-1 text-[11px] text-muted hover:text-danger"
              onClick={() => onRevert(op)}
            >
              回退
            </button>
          </div>
        ))}
      </div>
    </AdjustFloating>
  )
}

interface VariantPanelProps {
  component: string
  variants: ReadonlyArray<string>
  current?: string
  onPick: (variant: string) => void
  onClose: () => void
}

/** 换 Button / IconButton / Badge 的样式变体；每个选项用真实组件渲染。 */
export function AdjustVariantPanel({ component, variants, current, onPick, onClose }: VariantPanelProps) {
  return (
    <div
      {...{ [UI_ATTR]: '' }}
      data-adjust-variant-panel=""
      className={cn(PANEL_CLASS, 'bottom-24 right-4 w-[min(300px,calc(100vw-24px))]')}
      role="dialog"
      aria-label="换样式变体"
    >
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        <Layers size={13} className="text-annotation" />
        <span className="text-[12.5px] font-medium text-text">换变体 · {component}</span>
        <IconButton label="关闭变体面板" size="inline" className="ml-auto" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </div>
      <p className="px-1 pb-1 text-[11px] leading-4 text-muted">
        只记录 ui/* 的变体名；实现时用同名组件的 variant 属性，不抄 class。
      </p>
      <div className="grid min-h-0 grid-cols-1 gap-1 overflow-y-auto p-0.5">
        {variants.map((variant) => (
          <button
            data-raw-button
            key={variant}
            type="button"
            data-adjust-variant={variant}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover',
              current === variant && 'bg-hover',
            )}
            onClick={() => onPick(variant)}
          >
            <span className="pointer-events-none flex min-w-[92px] items-center">
              {component === 'Badge' ? (
                <Badge tone={variant as never}>{variant}</Badge>
              ) : component === 'IconButton' ? (
                <IconButton label={variant} variant={variant as never} size="inline" tabIndex={-1}>
                  <Plus size={14} />
                </IconButton>
              ) : (
                <Button variant={variant as never} size="md" tabIndex={-1}>
                  {variant}
                </Button>
              )}
            </span>
            <span className="ml-auto font-mono text-[11px] text-muted">{variant}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

interface TextPanelProps {
  title: string
  value: string
  onChange: (value: string) => void
  onSave: () => void
  onClose: () => void
}

/** 改文字：只允许纯文本节点，记录改前/改后。 */
export function AdjustTextPanel({ title, value, onChange, onSave, onClose }: TextPanelProps) {
  return (
    <div
      {...{ [UI_ATTR]: '' }}
      data-adjust-text-panel=""
      className={cn(PANEL_CLASS, 'bottom-24 right-4 w-[min(330px,calc(100vw-24px))]')}
      role="dialog"
      aria-label="改文字"
    >
      <div className="flex items-center gap-1.5 px-1 pb-1.5">
        <PencilLine size={13} className="text-annotation" />
        <span className="text-[12.5px] font-medium text-text">改文字</span>
        <IconButton label="关闭改文字面板" size="inline" className="ml-auto" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </div>
      <p className="px-1 pb-1 text-[11px] leading-4 text-muted">
        {title} · 只改这段纯文本；富文本/代码块请先在真实界面改。
      </p>
      <Input
        size="sm"
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSave()
        }}
        placeholder="新的文字"
        aria-label="新的文字"
      />
      <div className="mt-1.5 flex justify-end gap-1">
        <Button size="inline" variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button size="inline" variant="primary" onClick={onSave}>
          保存文字
        </Button>
      </div>
    </div>
  )
}

export function AdjustStateBadge({ standard, label }: { standard: boolean; label: string }) {
  return <Badge tone={standard ? 'neutral' : 'warn'}>{standard ? label : '非标准值'}</Badge>
}
