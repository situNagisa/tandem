import { useSyncExternalStore, type ReactNode } from 'react'
import {
  BarChart3,
  BookOpen,
  Bot,
  Brain,
  ChevronRight,
  FileDiff,
  Gauge,
  GitFork,
  GripVertical,
  Info,
  ListTodo,
  ScrollText,
} from 'lucide-react'
import { cn } from '../../lib/cn'

export type GroupId = 'plan' | 'todos' | 'agents' | 'graph' | 'usage' | 'context' | 'changes' | 'memory' | 'wiki' | 'details'

export const GROUPS: Array<{ id: GroupId; label: string; Icon: typeof ListTodo }> = [
  { id: 'plan', label: '当前计划', Icon: ScrollText },
  { id: 'todos', label: '待办', Icon: ListTodo },
  { id: 'agents', label: '代理', Icon: Bot },
  { id: 'graph', label: '会话图', Icon: GitFork },
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

/**
 * 分组显隐的模块级小仓库：面板（RightPanel）发布「哪些分组有数据」，
 * 顶栏的 ⋯ 菜单（反馈12#06 移到窗口顶栏）与面板共用同一份 prefs。
 */
interface PanelStoreState {
  prefs: PanelPrefs
  availability: Partial<Record<GroupId, boolean>>
}

let panelState: PanelStoreState = { prefs: loadPanelPrefs(), availability: {} }
const panelListeners = new Set<() => void>()
const emitPanel = () => {
  for (const listener of panelListeners) listener()
}

function usePanelStore(): PanelStoreState {
  return useSyncExternalStore(
    (listener) => {
      panelListeners.add(listener)
      return () => panelListeners.delete(listener)
    },
    () => panelState,
  )
}

export function setPanelPrefs(next: PanelPrefs): void {
  panelState = { ...panelState, prefs: next }
  savePanelPrefs(next)
  emitPanel()
}

export function setPanelAvailability(next: Partial<Record<GroupId, boolean>>): void {
  const prev = panelState.availability
  const same =
    Object.keys(next).length === Object.keys(prev).length &&
    DEFAULT_ORDER.every((id) => !!next[id] === !!prev[id])
  if (same) return
  panelState = { ...panelState, availability: next }
  emitPanel()
}

/** 勾选/取消一个分组：有数据的分组取消后记 hidden，空分组勾选后记 shown。 */
export function togglePanelGroup(id: GroupId): void {
  const { prefs, availability } = panelState
  const avail = !!availability[id]
  const visible = !prefs.hidden.includes(id) && (avail || prefs.shown.includes(id))
  const next: PanelPrefs = visible
    ? {
        ...prefs,
        hidden: avail ? [...prefs.hidden, id] : prefs.hidden.filter((x) => x !== id),
        shown: prefs.shown.filter((x) => x !== id),
      }
    : {
        ...prefs,
        hidden: prefs.hidden.filter((x) => x !== id),
        shown: avail || prefs.shown.includes(id) ? prefs.shown : [...prefs.shown, id],
      }
  setPanelPrefs(next)
}

/** 面板与顶栏菜单共用的分组显示状态。 */
export function usePanelGroups(): PanelStoreState {
  return usePanelStore()
}

const COLLAPSED_KEY = 'tandem.rightPanelCollapsed.v1'

/** 反馈12#07：收起的会话信息分组，跨会话/重开记住。 */
export function loadCollapsedGroups(): GroupId[] {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed)
      ? parsed.filter((id): id is GroupId => typeof id === 'string' && GROUP_IDS.has(id as GroupId))
      : []
  } catch {
    return []
  }
}

export function saveCollapsedGroups(ids: GroupId[]): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(ids))
  } catch {
    // localStorage 不可用时仅本次有效
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
  onHandleDown,
  onHandleUp,
  onDragStart,
  onDragEnd,
  onDragOver,
  right,
  cardRef,
  collapsible = false,
  collapsed = false,
  onToggle,
  summary,
  children,
}: {
  id: GroupId
  label: string
  icon: typeof ListTodo
  dragging?: boolean
  onHandleDown?: () => void
  onHandleUp?: () => void
  onDragStart?: (e: React.DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent<HTMLElement>) => void
  right?: ReactNode
  cardRef?: (el: HTMLElement | null) => void
  /** 反馈12#07：分组可收起，收起后标题行只留最关键的数字/结论。 */
  collapsible?: boolean
  collapsed?: boolean
  onToggle?: () => void
  summary?: ReactNode
  children: ReactNode
}) {
  const head = (
    <>
      <Icon size={11} className="shrink-0 text-text-tertiary" />
      <h3 className="min-w-0 truncate text-[12px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
        {label}
      </h3>
    </>
  )
  return (
    <section
      ref={cardRef}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      data-group={id}
      data-collapsed={collapsible && collapsed ? 'true' : undefined}
      className={cn(
        'group/card w-full min-w-0 rounded-[10px] border border-border px-3 py-2.5 shadow-[var(--t-shadow-sm)] transition-[opacity,box-shadow] duration-150',
        collapsible && collapsed && 'py-2',
        dragging && 'opacity-55',
      )}
      style={{ backgroundColor: 'color-mix(in srgb, var(--t-surface) 38%, var(--t-sidebar))' }}
    >
      <div className={cn('flex min-h-4 items-center gap-1.5', !collapsed && 'mb-2')}>
        {collapsible ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            data-card-toggle={id}
            className="-ml-0.5 flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 py-0.5 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
          >
            {head}
            <span className="flex-1" />
            {summary && collapsed ? (
              <span className="min-w-0 shrink truncate text-[12px] font-normal normal-case tracking-normal text-muted tabular-nums">
                {summary}
              </span>
            ) : null}
            {/* 反馈16#07：折叠箭头在标题文字右侧、常显。 */}
            <ChevronRight
              size={11}
              className={cn(
                'shrink-0 text-text-tertiary transition-transform duration-150',
                !collapsed && 'rotate-90',
              )}
            />
          </button>
        ) : (
          <>
            {head}
            <span className="flex-1" />
          </>
        )}
        {!collapsed && right ? <span className="flex shrink-0 items-center">{right}</span> : null}
        {onDragStart && (
          <span
            role="button"
            tabIndex={-1}
            aria-label={`拖动排序：${label}`}
            onPointerDown={onHandleDown}
            onPointerUp={onHandleUp}
            className="flex w-3 shrink-0 cursor-grab items-center justify-center self-stretch text-muted active:cursor-grabbing max-md:hidden"
          >
            <GripVertical size={11} />
          </span>
        )}
      </div>
      {!collapsed && children}
    </section>
  )
}

