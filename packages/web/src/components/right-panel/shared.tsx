import type { ReactNode } from 'react'
import {
  BarChart3,
  BookOpen,
  Bot,
  Brain,
  FileDiff,
  Gauge,
  GripVertical,
  Info,
  ListTodo,
  ScrollText,
} from 'lucide-react'
import { cn } from '../../lib/cn'

export type GroupId = 'plan' | 'todos' | 'agents' | 'usage' | 'context' | 'changes' | 'memory' | 'wiki' | 'details'

export const GROUPS: Array<{ id: GroupId; label: string; Icon: typeof ListTodo }> = [
  { id: 'plan', label: '当前计划', Icon: ScrollText },
  { id: 'todos', label: '待办', Icon: ListTodo },
  { id: 'agents', label: '代理', Icon: Bot },
  { id: 'usage', label: '用量', Icon: BarChart3 },
  { id: 'context', label: '上下文', Icon: Gauge },
  { id: 'changes', label: '改动摘要', Icon: FileDiff },
  { id: 'memory', label: '记忆', Icon: Brain },
  { id: 'wiki', label: 'Wiki', Icon: BookOpen },
  { id: 'details', label: '详情', Icon: Info },
]

export const GROUP_META = Object.fromEntries(GROUPS.map((g) => [g.id, g])) as Record<
  GroupId,
  (typeof GROUPS)[number]
>
export const DEFAULT_ORDER = GROUPS.map((g) => g.id)
export const GROUP_IDS = new Set<GroupId>(DEFAULT_ORDER)
const PREFS_KEY = 'tandem.rightPanel.v1'

/** 会话信息面板宽度：280–600，记住用户拖过的位置（#03）。 */
export const PANEL_WIDTH_KEY = 'tandem.rightPanelWidth.v1'
export const PANEL_WIDTH_DEFAULT = 300
export const PANEL_WIDTH_MIN = 280
export const PANEL_WIDTH_MAX = 600

export function loadPanelWidth(): number {
  try {
    const n = Number(localStorage.getItem(PANEL_WIDTH_KEY))
    return Number.isFinite(n) && n >= PANEL_WIDTH_MIN && n <= PANEL_WIDTH_MAX
      ? Math.round(n)
      : PANEL_WIDTH_DEFAULT
  } catch {
    return PANEL_WIDTH_DEFAULT
  }
}

export function savePanelWidth(width: number): void {
  try {
    localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)))
  } catch {
    // localStorage 不可用时仅本次会话有效
  }
}

export interface PanelPrefs {
  order: GroupId[]
  hidden: GroupId[]
  /**
   * 用户显式要求显示的空分组（反馈10#03）。没有数据的分组默认隐藏；
   * 在面板顶部 ⋯ 菜单勾选后才出现在这里。旧版本的整体开关 `showEmpty` 不再使用。
   */
  shown: GroupId[]
}

export function loadPanelPrefs(): PanelPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { order: [...DEFAULT_ORDER], hidden: [], shown: [] }
    const parsed = JSON.parse(raw) as { order?: unknown; hidden?: unknown; shown?: unknown }
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((id): id is GroupId => typeof id === 'string' && GROUP_IDS.has(id as GroupId))
      : []
    for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id)
    const hidden = Array.isArray(parsed.hidden)
      ? parsed.hidden.filter((id): id is GroupId => typeof id === 'string' && GROUP_IDS.has(id as GroupId))
      : []
    const shown = Array.isArray(parsed.shown)
      ? parsed.shown.filter((id): id is GroupId => typeof id === 'string' && GROUP_IDS.has(id as GroupId))
      : []
    return { order, hidden: [...new Set(hidden)], shown: [...new Set(shown)] }
  } catch {
    return { order: [...DEFAULT_ORDER], hidden: [], shown: [] }
  }
}

export function savePanelPrefs(prefs: PanelPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage 不可用时只保留本次会话内的顺序与显隐。
  }
}

export const CHANGE_MARK: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}


export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[52px_minmax(0,1fr)] items-baseline gap-2 py-[3px] text-[13px] leading-[18px]">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="min-w-0 break-words text-text">{children}</span>
    </div>
  )
}

export function Card({
  id,
  label,
  icon: Icon,
  dragging = false,
  activeHandle = false,
  onHandleDown,
  onHandleUp,
  onDragStart,
  onDragEnd,
  onDragOver,
  right,
  cardRef,
  children,
}: {
  id: GroupId
  label: string
  icon: typeof ListTodo
  dragging?: boolean
  activeHandle?: boolean
  onHandleDown?: () => void
  onHandleUp?: () => void
  onDragStart?: (e: React.DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent<HTMLElement>) => void
  right?: ReactNode
  cardRef?: (el: HTMLElement | null) => void
  children: ReactNode
}) {
  return (
    <section
      ref={cardRef}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      data-group={id}
      className={cn(
        'group/card rounded-[10px] border border-border px-3 py-2.5 shadow-[var(--t-shadow-sm)] transition-[opacity,box-shadow] duration-150',
        dragging && 'opacity-55',
      )}
      style={{ backgroundColor: 'color-mix(in srgb, var(--t-surface) 38%, var(--t-sidebar))' }}
    >
      <div className="mb-2 flex min-h-4 items-center gap-1.5">
        {onDragStart && (
          <span
            role="button"
            tabIndex={-1}
            aria-label={`拖动排序：${label}`}
            onPointerDown={onHandleDown}
            onPointerUp={onHandleUp}
            className={cn(
              'hidden w-3 shrink-0 cursor-grab items-center justify-center self-stretch text-muted transition-opacity duration-120 active:cursor-grabbing md:flex',
              activeHandle || dragging ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100',
            )}
          >
            <GripVertical size={11} />
          </span>
        )}
        <Icon size={11} className="shrink-0 text-text-tertiary" />
        <h3 className="min-w-0 truncate text-[12px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
          {label}
        </h3>
        <span className="flex-1" />
        {right}
      </div>
      {children}
    </section>
  )
}

