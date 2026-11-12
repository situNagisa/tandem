/**
 * 反馈模式「调整」：在冻结副本上改 UI，产出给 agent 的逐条实现说明。
 *
 * P0 冻结副本 / 选中（Alt 选父级）/ 8 手柄改尺寸（吸附 token）/ 换图标 / 删除 /
 * 撤销重做 / 单条回退；P1 完成时生成反馈条目（前后截图、清单 JSON、结构快照）；
 * P2 插入 ui/* 控件与示意行、行为备注、默认换序 + Alt 自由拖动吸附线。
 *
 * 真实界面从不被编辑：所有改动只发生在 stage 克隆里，退出时 stage.remove()。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import {
  AlertTriangle,
  Check,
  EyeOff,
  Layers,
  PencilLine,
  MessageSquare,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { captureSnapshotShot, cssSelectorFor } from '../../lib/feedbackCapture'
import type { AdjustChange, AdjustSnapshot, FeedbackRect } from '../../lib/feedback'
import { Badge, BADGE_TONE_CLASS } from '../ui/Badge'
import { BUTTON_VARIANT_CLASS, Button, IconButton } from '../ui/Button'
import { cn } from '../../lib/cn'
import { ADJUST_ICONS, type AdjustIconEntry } from './adjustIcons.generated'
import {
  adjustKindLabel,
  buildAdjustSnapshot,
  createAdjustStage,
  describeSize,
  freezeAppViewport,
  iconSvgFor,
  lucideIconName,
  metaForClone,
  newAdjustId,
  snapSize,
  styleSnapshot,
  type AdjustFreeze,
  type AdjustInsertOption,
  type AdjustInsertedItem,
  type AdjustInsertedRow,
  type AdjustOp,
  type AdjustSummary,
  type AdjustTargetMeta,
} from './feedbackAdjust'
import {
  applyVariant,
  captureBoxStyle,
  elementOwnText,
  isInsertedTarget,
  opFromChange,
  reattachChanges,
  restoreBoxStyle,
  setElementText,
} from './feedbackAdjustApply'
import {
  AdjustChangeList,
  AdjustFloating,
  AdjustIconPicker,
  AdjustInsertPanel,
  AdjustListEditor,
  AdjustNotePanel,
  AdjustStateBadge,
  AdjustTextPanel,
  AdjustVariantPanel,
  type AdjustRect,
} from './FeedbackAdjustPanels'
import { useUiStore } from '../../store/useUiStore'
import { renderInserted } from './feedbackAdjustInsert'
import { UI_ATTR } from './feedbackModeHelpers'

const HANDLE_LIST: Array<{
  key: string
  className: string
  cursor: string
  fx: -1 | 0 | 1
  fy: -1 | 0 | 1
}> = [
  { key: 'nw', className: 'left-0 top-0', cursor: 'nwse-resize', fx: -1, fy: -1 },
  { key: 'n', className: 'left-1/2 top-0', cursor: 'ns-resize', fx: 0, fy: -1 },
  { key: 'ne', className: 'left-full top-0', cursor: 'nesw-resize', fx: 1, fy: -1 },
  { key: 'e', className: 'left-full top-1/2', cursor: 'ew-resize', fx: 1, fy: 0 },
  { key: 'se', className: 'left-full top-full', cursor: 'nwse-resize', fx: 1, fy: 1 },
  { key: 's', className: 'left-1/2 top-full', cursor: 'ns-resize', fx: 0, fy: 1 },
  { key: 'sw', className: 'left-0 top-full', cursor: 'nesw-resize', fx: -1, fy: 1 },
  { key: 'w', className: 'left-0 top-1/2', cursor: 'ew-resize', fx: -1, fy: 0 },
]

interface OffsetState {
  x: number
  y: number
  base: string
}

interface ResizeDrag {
  kind: 'resize'
  handle: (typeof HANDLE_LIST)[number]
  element: Element
  /** 拖的是插入的示意控件时，尺寸写回条目而不是副本内联样式。 */
  insertedId?: string
  startX: number
  startY: number
  startW: number
  startH: number
  startOffsetX: number
  startOffsetY: number
  live: {
    width: number
    height: number
    offsetX: number
    offsetY: number
    tokens?: { width?: string; height?: string }
    standard?: boolean
  } | null
}

interface MoveDrag {
  kind: 'move'
  element: Element
  startX: number
  startY: number
  startOffsetX: number
  startOffsetY: number
  startRect: { left: number; top: number; width: number; height: number }
  live: { offsetX: number; offsetY: number } | null
}

interface ReorderDrag {
  kind: 'reorder'
  element: Element
  parent: Element
  siblings: Element[]
  startIndex: number
  oldNextSibling: Node | null
  axis: 'x' | 'y'
  index: number
  line: { left: number; top: number; width: number; height: number } | null
}

type DragState = ResizeDrag | MoveDrag | ReorderDrag

interface PendingDrag {
  element: Element
  startX: number
  startY: number
  freeMove: boolean
}

interface InsertedMove {
  itemId: string
  startX: number
  startY: number
  x: number
  y: number
  moved: boolean
}

interface InsertDrag {
  option: AdjustInsertOption
  startX: number
  startY: number
}

export interface AdjustPayload {
  id: string
  /** 继续调整已有条目时复用原条目 id，保存时更新同一条，不新建。 */
  itemId?: string
  snapshot: AdjustSnapshot
  beforeImage: string | null
  afterImage: string | null
  sourceAvailable: boolean
}

export interface FeedbackAdjustProps {
  onClose: () => void
  onProgress: (payload: AdjustPayload) => void
  onFinish: (payload: AdjustPayload) => void
  /** 父组件处理 Esc：返回 true 表示调整工具自己消费了（关面板/取消选择）。 */
  escapeRef: MutableRefObject<(() => boolean) | null>
  /** 继续调整：从已有条目恢复冻结副本与改动清单。 */
  resume?: { itemId: string; snapshot: AdjustSnapshot } | null
  /** 临时退出副本操作真实界面时，通知反馈模式暂停捕获层。 */
  onReleaseChange?: (released: boolean) => void
}

/** 副本 HTML 上限：再大就截断并提示可以重新冻结。 */
const COPY_HTML_LIMIT = 3_000_000
const BUTTON_VARIANTS = Object.keys(BUTTON_VARIANT_CLASS)
const BADGE_VARIANTS = Object.keys(BADGE_TONE_CLASS)

function clampRect(rect: FeedbackRect): FeedbackRect {
  const x = Math.max(0, Math.min(Math.round(rect.x), window.innerWidth - 4))
  const y = Math.max(0, Math.min(Math.round(rect.y), window.innerHeight - 4))
  return {
    ...rect,
    x,
    y,
    width: Math.max(4, Math.min(Math.round(rect.width), window.innerWidth - x)),
    height: Math.max(4, Math.min(Math.round(rect.height), window.innerHeight - y)),
  }
}

function rectOf(element: Element): FeedbackRect {
  const box = element.getBoundingClientRect()
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
    pageX: Math.round(box.left + window.scrollX),
    pageY: Math.round(box.top + window.scrollY),
  }
}

function insertedMeta(item: AdjustInsertedItem, element?: HTMLElement): AdjustTargetMeta {
  const rect = element ? rectOf(element) : { x: item.x, y: item.y, width: 0, height: 0, pageX: item.x, pageY: item.y }
  const component =
    item.kind === 'list'
      ? '列表（Card + ListRow）'
      : item.kind === 'menu'
        ? '菜单（Card + ListRow 示意）'
        : item.label
  return {
    selector: `[data-adjust-inserted="${item.id}"]`,
    component,
    tag: item.kind === 'button' || item.kind === 'icon-button' ? 'button' : 'div',
    classes: [],
    textSnippet: item.label,
    testId: item.id,
    rect,
  }
}

function insertedComponentLabel(item: AdjustInsertedItem): string {
  if (item.kind === 'list') return '列表（Card + ListRow）'
  if (item.kind === 'menu') return '菜单（Card + ListRow 示意；实现时用 ui/Menu.Item）'
  if (item.kind === 'card') return '卡片（Card）'
  if (item.kind === 'icon-button') return 'IconButton'
  if (item.kind === 'button') return 'Button'
  if (item.kind === 'badge') return 'Badge'
  if (item.kind === 'list-row') return 'ListRow'
  return 'Input'
}

/** 继续调整 / 重新冻结时，从 insert 改动重建插入的示意控件。 */
function insertedItemFromChange(change: AdjustChange): AdjustInsertedItem | null {
  if (change.kind !== 'insert') return null
  const after = (change.after ?? {}) as {
    itemId?: string
    component?: string
    variant?: string
    rows?: Array<{ component?: string; title?: string; note?: string }>
    note?: string
    position?: { x?: number; y?: number }
    width?: number
    height?: number
    container?: boolean
  }
  if (!after.itemId) return null
  const component = after.component ?? ''
  const kind: AdjustInsertedItem['kind'] = component.startsWith('列表')
    ? 'list'
    : component.startsWith('菜单')
      ? 'menu'
      : component.startsWith('卡片')
        ? 'card'
        : component === 'IconButton'
          ? 'icon-button'
          : component === 'Button'
            ? 'button'
            : component === 'Badge'
              ? 'badge'
              : component === 'ListRow'
                ? 'list-row'
                : 'input'
  return {
    id: after.itemId,
    kind,
    group: '',
    label: after.component ?? '控件',
    variant: after.variant ?? '',
    x: after.position?.x ?? 0,
    y: after.position?.y ?? 0,
    width: after.width,
    height: after.height,
    behavior: after.note ?? change.behavior ?? '',
    rows: (after.rows ?? []).map((row, index) => ({
      id: `${after.itemId}-row-${index}`,
      component: (row.component === 'Button' || row.component === 'Badge' ? row.component : 'ListRow') as AdjustInsertedRow['component'],
      title: row.title ?? '',
      note: row.note ?? '',
    })),
    container: after.container ?? (kind === 'list' || kind === 'menu' || kind === 'card'),
  }
}

export function FeedbackAdjust({
  onClose,
  onProgress,
  onFinish,
  escapeRef,
  resume,
  onReleaseChange,
}: FeedbackAdjustProps) {
  const [phase, setPhase] = useState<'freezing' | 'ready' | 'released'>('freezing')
  /** 调整期间的提示显示在底部工具条状态区，不再弹 toast。 */
  const [notice, setNotice] = useState<{ id: number; text: string; tone: 'info' | 'success' | 'error' } | null>(null)
  const noticeSeq = useRef(0)
  const notify = useCallback((message: string, tone: 'info' | 'success' | 'error' = 'info') => {
    noticeSeq.current += 1
    setNotice({ id: noticeSeq.current, text: message, tone })
  }, [])

  // 进入调整先收起已有提示条，并在调整期间停用 toast；提示改走底部状态区。
  useEffect(() => {
    const ui = useUiStore.getState()
    ui.clearToasts()
    ui.setToastSuppressed(true)
    return () => ui.setToastSuppressed(false)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])
  const [freeze, setFreeze] = useState<AdjustFreeze | null>(null)
  const freezeRef = useRef<AdjustFreeze | null>(null)
  const [selected, setSelected] = useState<Element | null>(null)
  const selectedRef = useRef<Element | null>(null)
  selectedRef.current = selected
  const [selectedInsertedId, setSelectedInsertedId] = useState<string | null>(null)
  const selectedInsertedRef = useRef<string | null>(null)
  selectedInsertedRef.current = selectedInsertedId
  const [hover, setHover] = useState<Element | null>(null)
  const [tick, setTick] = useState(0)
  const [ops, setOps] = useState<AdjustOp[]>([])
  const opsRef = useRef<AdjustOp[]>(ops)
  opsRef.current = ops
  const redoRef = useRef<AdjustOp[]>([])
  const [redoCount, setRedoCount] = useState(0)
  const [iconPicker, setIconPicker] = useState(false)
  const [iconQuery, setIconQuery] = useState('')
  const [insertPanel, setInsertPanel] = useState(false)
  const [insertPreviewKey, setInsertPreviewKey] = useState<string | null>(null)
  /** 调整浮层的实际视口矩形，用于让选中工具条避开面板/预览/清单/底栏。 */
  const [adjustRects, setAdjustRects] = useState<{
    changes?: AdjustRect
    panel?: AdjustRect
    preview?: AdjustRect
    toolbar?: AdjustRect
  }>({})
  const [inserted, setInserted] = useState<AdjustInsertedItem[]>([])
  const insertedRef = useRef<AdjustInsertedItem[]>(inserted)
  insertedRef.current = inserted
  const insertedDomRef = useRef(new Map<string, HTMLElement>())
  const insertedLayerRef = useRef<HTMLDivElement | null>(null)
  const [listEditorId, setListEditorId] = useState<string | null>(null)
  const [noteTarget, setNoteTarget] = useState<
    { kind: 'selection' } | { kind: 'change'; id: string } | null
  >(null)
  const [noteText, setNoteText] = useState('')
  const [lastSnap, setLastSnap] = useState<{ label: string; standard: boolean } | null>(null)
  const [snapLines, setSnapLines] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] })
  const [reorderLine, setReorderLine] = useState<ReorderDrag['line']>(null)
  const [dropGhost, setDropGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const [finishBusy, setFinishBusy] = useState(false)
  const [variantPanel, setVariantPanel] = useState(false)
  const [textPanel, setTextPanel] = useState(false)
  const [textDraft, setTextDraft] = useState('')
  const [cursor, setCursor] = useState<'default' | 'grab' | 'grabbing' | 'move'>('default')
  const resumeRef = useRef(resume ?? null)
  const itemIdRef = useRef<string | undefined>(resume?.itemId)
  const releasedRef = useRef(false)
  const offsetsRef = useRef(new WeakMap<Element, OffsetState>())
  const moveMergeRef = useRef<{ element: Element; op: AdjustOp; at: number } | null>(null)
  const pointerRef = useRef<{ x: number; y: number; alt: boolean; raf: number } | null>(null)
  const pendingRef = useRef<PendingDrag | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const insertDragRef = useRef<InsertDrag | null>(null)
  const insertedMoveRef = useRef<InsertedMove | null>(null)
  const suppressClickRef = useRef(false)
  const beforeImageRef = useRef<string | null>(null)
  const sessionIdRef = useRef(resume?.snapshot.id ?? newAdjustId('adj'))
  const publishTimerRef = useRef<number | null>(null)
  const [dirty, setDirty] = useState(false)

  const stage = freeze?.stage ?? null

  const insertedSelected = useMemo(
    () => inserted.find((item) => item.id === selectedInsertedId) ?? null,
    [inserted, selectedInsertedId],
  )

  const selectedMeta = useMemo(() => {
    void tick
    if (insertedSelected) {
      return insertedMeta(insertedSelected, insertedDomRef.current.get(insertedSelected.id))
    }
    if (!freeze || !selected) return null
    return metaForClone(freeze, selected)
  }, [freeze, selected, insertedSelected, tick])

  const selectedRect = useMemo(() => {
    void tick
    const element = insertedSelected
      ? insertedDomRef.current.get(insertedSelected.id)
      : selected
    if (!element) return null
    try {
      return clampRect(rectOf(element))
    } catch {
      return null
    }
  }, [selected, insertedSelected, tick, inserted])

  // 插入控件首次提交后 ref 才登记 DOM；补一次渲染，选中框/手柄才会出现。
  useEffect(() => {
    if (inserted.length > 0) bump()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inserted])

  const sizeInfo = useMemo(() => {
    if (!selectedRect) return null
    return describeSize(selectedRect.width, selectedRect.height)
  }, [selectedRect])

  const hoverRect = useMemo(() => {
    void tick
    if (!hover || hover === selected) return null
    try {
      return clampRect(rectOf(hover))
    } catch {
      return null
    }
  }, [hover, selected, tick])

  const hoverMeta = useMemo(() => {
    if (!freeze || !hover) return null
    return metaForClone(freeze, hover)
  }, [freeze, hover])

  const iconTarget = !insertedSelected && selected ? iconSvgFor(selected) : null
  const currentIconName = lucideIconName(iconTarget)

  const variantInfo = useMemo(() => {
    void tick
    if (!selected || insertedSelected) return null
    const tone = selected.getAttribute('data-tone')
    if (tone) return { component: 'Badge', current: tone, variants: BADGE_VARIANTS }
    const variant = selected.getAttribute('data-variant')
    if (!variant) return null
    const component =
      selected.getAttribute('data-icon-button') !== null
        ? 'IconButton'
        : selectedMeta?.component === 'Button'
          ? 'Button'
          : 'Button'
    return { component, current: variant, variants: BUTTON_VARIANTS }
  }, [selected, insertedSelected, selectedMeta, tick])

  const ownText = useMemo(
    () => (selected && !insertedSelected ? elementOwnText(selected) : ''),
    [selected, insertedSelected, tick],
  )

  const bump = useCallback(() => setTick((value) => value + 1), [])

  useEffect(() => {
    const onResize = () => bump()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [bump])

  // Radix 定位完成后再量浮层矩形，供选中工具条计算碰撞留白。
  useEffect(() => {
    const measure = () => {
      const read = (selector: string): AdjustRect | undefined => {
        const element = document.querySelector(selector)
        if (!element) return undefined
        const rect = element.getBoundingClientRect()
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        }
      }
      const next = {
        changes: read('[data-adjust-changes]'),
        panel: read('[data-adjust-insert-panel]'),
        preview: read('[data-adjust-insert-preview]'),
        toolbar: read('[data-adjust-toolbar]'),
      }
      const same = (a?: AdjustRect, b?: AdjustRect) =>
        a === b ||
        (!!a &&
          !!b &&
          Math.abs(a.left - b.left) < 0.5 &&
          Math.abs(a.top - b.top) < 0.5 &&
          Math.abs(a.right - b.right) < 0.5 &&
          Math.abs(a.bottom - b.bottom) < 0.5)
      setAdjustRects((prev) =>
        same(prev.changes, next.changes) &&
        same(prev.panel, next.panel) &&
        same(prev.preview, next.preview) &&
        same(prev.toolbar, next.toolbar)
          ? prev
          : next,
      )
    }
    const frame = requestAnimationFrame(measure)
    const timers = [window.setTimeout(measure, 80), window.setTimeout(measure, 260)]
    return () => {
      cancelAnimationFrame(frame)
      for (const timer of timers) window.clearTimeout(timer)
    }
  })

  /** 选中工具条：上/下方优先，同时避开左右两侧的清单/面板/预览与底部工具条。 */
  const selectionPadding = useMemo(() => {
    if (!selectedRect) return { top: 8, left: 8, right: 8, bottom: 8 }
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const wide = viewportWidth >= 1024
    const padding = { top: 8, left: 8, right: 8, bottom: 8 }
    // 工具条可能落在元素上/下方，取一段竖直范围判断是否和侧边浮层重叠。
    const bandTop = selectedRect.y - 48
    const bandBottom = selectedRect.y + selectedRect.height + 72
    const overlapsVertically = (rect: AdjustRect) => rect.top < bandBottom && rect.bottom > bandTop
    if (adjustRects.changes) {
      if (wide) {
        if (overlapsVertically(adjustRects.changes)) {
          padding.left = Math.max(padding.left, Math.ceil(adjustRects.changes.right) + 8)
        }
      } else {
        // 窄视口下清单是顶部横条，工具条整体让到它下方。
        padding.top = Math.max(padding.top, Math.ceil(adjustRects.changes.bottom) + 8)
      }
    }
    if (adjustRects.panel) {
      if (adjustRects.panel.width >= viewportWidth * 0.8) {
        padding.bottom = Math.max(padding.bottom, Math.ceil(viewportHeight - adjustRects.panel.top) + 8)
      } else {
        padding.right = Math.max(padding.right, Math.ceil(viewportWidth - adjustRects.panel.left) + 8)
      }
    }
    if (adjustRects.preview) {
      if (wide) {
        if (overlapsVertically(adjustRects.preview)) {
          padding.right = Math.max(padding.right, Math.ceil(viewportWidth - adjustRects.preview.left) + 8)
        }
      } else {
        padding.bottom = Math.max(padding.bottom, Math.ceil(viewportHeight - adjustRects.preview.top) + 8)
      }
    }
    if (adjustRects.toolbar) {
      padding.bottom = Math.max(padding.bottom, Math.ceil(viewportHeight - adjustRects.toolbar.top) + 8)
    }
    return padding
  }, [selectedRect, adjustRects])

  // 窄视口里清单/预览/抽屉几乎占满整行，选中元素若被浮层盖住时，
  // 把工具条的锚点移到浮层之间的空档（上/下由空档决定），再由 Radix 做碰撞。
  const barPlacement = useMemo(() => {
    if (!selectedRect) return { anchor: { x: 0, y: 0 }, side: 'bottom' as const }
    const centerX = selectedRect.x + selectedRect.width / 2
    const bottomY = selectedRect.y + selectedRect.height
    if (window.innerWidth >= 1024) return { anchor: { x: centerX, y: bottomY }, side: 'bottom' as const }
    const safeTop = (adjustRects.changes?.bottom ?? 0) + 8
    const safeBottom =
      Math.min(
        adjustRects.preview?.top ?? Number.POSITIVE_INFINITY,
        adjustRects.panel?.top ?? Number.POSITIVE_INFINITY,
      ) - 8
    if (safeBottom - safeTop >= 44) {
      if (bottomY > safeBottom) return { anchor: { x: centerX, y: safeBottom }, side: 'top' as const }
      if (selectedRect.y < safeTop) return { anchor: { x: centerX, y: safeTop }, side: 'bottom' as const }
    }
    return { anchor: { x: centerX, y: bottomY }, side: 'bottom' as const }
  }, [selectedRect, adjustRects])

  const structureFor = useCallback((): AdjustSnapshot['structure'] => {
    const out: AdjustSnapshot['structure'] = []
    for (const op of opsRef.current) {
      if (op.structure) {
        out.push({
          changeId: op.change.id,
          selector: op.change.target.selector,
          html: op.structure.html,
          styles: op.structure.styles,
        })
      }
      if (op.change.kind === 'insert') {
        const itemId = (op.change.after as { itemId?: string } | undefined)?.itemId
        const element = itemId ? insertedDomRef.current.get(itemId) : undefined
        if (element) {
          out.push({
            changeId: op.change.id,
            selector: op.change.target.selector,
            html: element.outerHTML.slice(0, 12000),
            styles: styleSnapshot(element),
          })
        }
      }
    }
    return out
  }, [])

  const buildSnapshot = useCallback((includeCopy = false): AdjustSnapshot | null => {
    const frozen = freezeRef.current
    if (!frozen) return null
    const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    const html = frozen.stage.innerHTML
    const copy = includeCopy
      ? {
          html: html.slice(0, COPY_HTML_LIMIT),
          width: window.innerWidth,
          height: window.innerHeight,
          theme: theme as 'light' | 'dark',
          truncated: html.length > COPY_HTML_LIMIT,
        }
      : undefined
    return buildAdjustSnapshot({
      id: sessionIdRef.current,
      route: window.location.hash || '#/',
      theme,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      },
      freeze: frozen.stats,
      changes: opsRef.current.map((op) => op.change),
      structure: structureFor(),
      copy,
    })
  }, [structureFor])

  const publishNow = useCallback(() => {
    const snapshot = buildSnapshot()
    // 进入调整但还没改动时不留空条目；第一次改动后草稿开始实时落盘。
    if (!snapshot || snapshot.changes.length === 0) return
    onProgress({
      id: sessionIdRef.current,
      itemId: itemIdRef.current,
      snapshot,
      beforeImage: beforeImageRef.current,
      afterImage: null,
      sourceAvailable: snapshot.changes.some((change) => !!change.target.source),
    })
  }, [buildSnapshot, onProgress])

  const publish = useCallback(
    (delay = 400) => {
      setDirty(true)
      if (publishTimerRef.current) window.clearTimeout(publishTimerRef.current)
      publishTimerRef.current = window.setTimeout(() => {
        publishTimerRef.current = null
        publishNow()
      }, delay)
    },
    [publishNow],
  )

  // 进入调整：继续调整时从快照恢复副本；否则先截「调整前」，再同步克隆当前视口。
  // 两段之间让「正在冻结」提示绘制出来。
  useEffect(() => {
    let cancelled = false
    let raf = 0

    const exposeDebug = (frozen: AdjustFreeze) => {
      const debugWindow = window as unknown as Record<string, unknown>
      debugWindow.__feedbackAdjust = {
        stats: frozen.stats,
        changes: () => opsRef.current.map((op) => op.change),
        inserted: () => insertedRef.current,
        insertedSelected: () => selectedInsertedRef.current,
        insertedDom: () => [...insertedDomRef.current.keys()],
        selected: () => {
          const el = selectedRef.current
          return el
            ? {
                tag: el.tagName,
                label: el.getAttribute('aria-label'),
                inStage: !!freezeRef.current?.stage.contains(el),
              }
            : null
        },
        select: (target: string) => {
          const item = insertedRef.current.find((entry) => entry.id === target)
          if (item) {
            setSelected(null)
            setSelectedInsertedId(item.id)
            bump()
            return true
          }
          let element: Element | null = null
          try {
            element = frozen.stage.querySelector(target)
          } catch {
            element = null
          }
          if (!element && /^[\w.-]+$/.test(target)) {
            element = frozen.stage.querySelector(`[data-testid="${target}"]`)
          }
          if (!element) return false
          setSelected(element)
          setSelectedInsertedId(null)
          bump()
          return true
        },
        freeze: frozen,
        hit: (x: number, y: number, alt = false) => {
          const element = hitTest(x, y, alt)
          return element
            ? {
                tag: element.tagName,
                src: element.getAttribute('data-tandem-src'),
                rect: rectOf(element),
              }
            : null
        },
        cursor: () => (document.querySelector('[data-adjust-hit-layer]') as HTMLElement | null)?.style.cursor ?? '',
      }
    }

    /** 恢复条目里的改动清单；reapply=true 表示新副本需要重放改动。 */
    const seed = (frozen: AdjustFreeze, snapshot: AdjustSnapshot, reapply: boolean) => {
      const changes = snapshot.changes.map((change) => ({ ...change, stale: false }))
      if (reapply) reattachChanges(changes, frozen.stage)
      const items = changes
        .map((change) => insertedItemFromChange(change))
        .filter((item): item is AdjustInsertedItem => item !== null)
      insertedRef.current = items
      setInserted(items)
      const rebuilt = changes.map((change) => opFromChange(change, frozen.stage))
      opsRef.current = rebuilt
      setOps(rebuilt)
      redoRef.current = []
      setRedoCount(0)
      bump()
    }

    const enter = async () => {
      const initial = resumeRef.current
      if (initial?.snapshot.copy?.html) {
        raf = requestAnimationFrame(() => {
          if (cancelled) return
          const copy = initial.snapshot.copy!
          const restored = createAdjustStage()
          restored.innerHTML = copy.html
          document.body.appendChild(restored)
          const frozen: AdjustFreeze = {
            stage: restored,
            originals: new WeakMap(),
            metas: new WeakMap(),
            stats: initial.snapshot.freeze,
            dispose: () => restored.remove(),
          }
          freezeRef.current = frozen
          setFreeze(frozen)
          seed(frozen, initial.snapshot, false)
          setPhase('ready')
          exposeDebug(frozen)
          notify(
            `已恢复上次的冻结副本 · ${initial.snapshot.changes.length} 项改动${copy.truncated ? '（HTML 超限已截断，可重新冻结）' : ''}`,
            'info',
          )
        })
        return
      }
      if (!initial) {
        const before = await captureSnapshotShot(document.body)
        if (cancelled) return
        beforeImageRef.current = before
      }
      raf = requestAnimationFrame(() => {
        if (cancelled) return
        const frozen = freezeAppViewport()
        freezeRef.current = frozen
        setFreeze(frozen)
        if (initial) seed(frozen, initial.snapshot, true)
        setPhase('ready')
        exposeDebug(frozen)
        notify(
          initial
            ? `已重新冻结并重放 ${initial.snapshot.changes.length} 项改动`
            : `画面已冻结 · ${frozen.stats.clonedNodes.toLocaleString('zh-CN')} 个节点 · ${frozen.stats.durationMs}ms`,
          'info',
        )
        publishNow()
      })
    }
    void enter()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      if (publishTimerRef.current) window.clearTimeout(publishTimerRef.current)
      freezeRef.current?.dispose()
      freezeRef.current = null
      onReleaseChange?.(false)
      const debugWindow = window as unknown as Record<string, unknown>
      delete debugWindow.__feedbackAdjust
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pushOp = useCallback(
    (op: AdjustOp) => {
      op.redo()
      const last = opsRef.current[opsRef.current.length - 1]
      // 反馈1603：同一元素的连续改尺寸 / 移动合并成一条，保留第一次的改前值与最后一次的改后值，
      // 清单不再逐次列出拖动过程。撤销回到第一次拖动前，重做落到最后一次。
      if (
        op.mergeTarget &&
        (op.change.kind === 'resize' || op.change.kind === 'move') &&
        last?.mergeTarget === op.mergeTarget &&
        last.change.kind === op.change.kind
      ) {
        last.change.after = op.change.after
        last.change.tokens = op.change.tokens
        last.change.standard = op.change.standard
        last.change.note = op.change.note
        last.change.at = op.change.at
        last.redo = op.redo
        redoRef.current = []
        setRedoCount(0)
        moveMergeRef.current = null
        setOps((current) => [...current])
        bump()
        publish()
        return
      }
      setOps((current) => [...current, op])
      redoRef.current = []
      setRedoCount(0)
      moveMergeRef.current = null
      bump()
      publish()
    },
    [bump, publish],
  )

  const undo = useCallback(() => {
    const op = opsRef.current[opsRef.current.length - 1]
    if (!op) return
    op.undo()
    redoRef.current = [...redoRef.current, op]
    setRedoCount(redoRef.current.length)
    setOps((current) => current.slice(0, -1))
    moveMergeRef.current = null
    bump()
    publish()
  }, [bump, publish])

  const redo = useCallback(() => {
    const op = redoRef.current[redoRef.current.length - 1]
    if (!op) return
    redoRef.current = redoRef.current.slice(0, -1)
    setRedoCount(redoRef.current.length)
    op.redo()
    setOps((current) => [...current, op])
    moveMergeRef.current = null
    bump()
    publish()
  }, [bump, publish])

  const revertOne = useCallback(
    (id: string) => {
      const op = opsRef.current.find((entry) => entry.change.id === id)
      if (!op) return
      op.undo()
      redoRef.current = []
      setRedoCount(0)
      setOps((current) => current.filter((entry) => entry.change.id !== id))
      if (op.change.kind === 'insert') {
        const itemId = (op.change.after as { itemId?: string } | undefined)?.itemId
        if (itemId) {
          setSelectedInsertedId((current) => (current === itemId ? null : current))
          setListEditorId((current) => (current === itemId ? null : current))
        }
      }
      moveMergeRef.current = null
      bump()
      publish()
    },
    [bump, publish],
  )

  /** 把宽度/高度/偏移写进副本；偏移用独立的 translate，不覆盖元素原有 transform。 */
  const applyBox = (
    element: Element,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
  ) => {
    const html = element as HTMLElement
    html.style.width = `${Math.max(8, Math.round(width))}px`
    html.style.height = `${Math.max(8, Math.round(height))}px`
    html.style.maxWidth = 'none'
    html.style.maxHeight = 'none'
    const base = offsetsRef.current.get(element)?.base ?? html.style.translate ?? ''
    if (offsetX || offsetY) {
      html.style.translate = `${offsetX}px ${offsetY}px`
    } else {
      html.style.translate = base
    }
    offsetsRef.current.set(element, { x: offsetX, y: offsetY, base })
  }

  const addResizeOp = (state: ResizeDrag, live: NonNullable<ResizeDrag['live']>) => {
    const insertedItem = state.insertedId
      ? insertedRef.current.find((entry) => entry.id === state.insertedId)
      : undefined
    const meta = insertedItem
      ? insertedMeta(insertedItem, state.element as HTMLElement)
      : freezeRef.current
        ? metaForClone(freezeRef.current, state.element)
        : null
    if (!meta) return
    const changed =
      Math.round(state.startW) !== live.width ||
      Math.round(state.startH) !== live.height ||
      state.startOffsetX !== live.offsetX ||
      state.startOffsetY !== live.offsetY
    if (!changed) return
    const tokenText = [live.tokens?.width, live.tokens?.height].filter(Boolean).join('、')
    const change: AdjustChange = {
      id: newAdjustId('chg'),
      kind: 'resize',
      at: Date.now(),
      target: meta,
      before: {
        width: Math.round(state.startW),
        height: Math.round(state.startH),
        offsetX: state.startOffsetX,
        offsetY: state.startOffsetY,
        ...(insertedItem ? {} : { style: captureBoxStyle(state.element) }),
      },
      after: live,
      tokens: live.tokens,
      standard: live.standard,
      note:
        live.standard === false
          ? `非标准值：未命中尺寸档位${tokenText ? `（已接近 ${tokenText}）` : ''}，实现时就近取 ui 档位。`
          : `已吸附：${tokenText || '4px 栅格'}。`,
    }
    let structure: AdjustOp['structure']
    if (!insertedItem) {
      try {
        structure = { html: state.element.outerHTML.slice(0, 6000), styles: styleSnapshot(state.element) }
      } catch {
        structure = undefined
      }
    }
    const applyInsertedSize = (width?: number, height?: number) => {
      if (!insertedItem) return
      setInserted((current) =>
        current.map((entry) => (entry.id === insertedItem.id ? { ...entry, width, height } : entry)),
      )
      const insertOp = opsRef.current.find(
        (entry) =>
          entry.change.kind === 'insert' &&
          (entry.change.after as { itemId?: string } | undefined)?.itemId === insertedItem.id,
      )
      if (insertOp) {
        insertOp.change.after = { ...(insertOp.change.after ?? {}), width, height }
        setOps((entries) => [...entries])
      }
    }
    pushOp({
      change,
      structure,
      mergeTarget: state.element,
      undo: () =>
        insertedItem
          ? applyInsertedSize(insertedItem.width, insertedItem.height)
          : applyBox(state.element, state.startW, state.startH, state.startOffsetX, state.startOffsetY),
      redo: () =>
        insertedItem
          ? applyInsertedSize(live.width, live.height)
          : applyBox(state.element, live.width, live.height, live.offsetX, live.offsetY),
    })
  }

  const addMoveOp = (
    element: Element,
    startOffsetX: number,
    startOffsetY: number,
    offsetX: number,
    offsetY: number,
    width: number,
    height: number,
  ) => {
    const meta = freezeRef.current ? metaForClone(freezeRef.current, element) : null
    if (!meta) return
    if (startOffsetX === offsetX && startOffsetY === offsetY) return
    const change: AdjustChange = {
      id: newAdjustId('chg'),
      kind: 'move',
      at: Date.now(),
      target: meta,
      before: {
        offsetX: startOffsetX,
        offsetY: startOffsetY,
        style: captureBoxStyle(element),
      },
      after: { offsetX, offsetY },
      note: `自由拖动 translate(${offsetX}px, ${offsetY}px)；实现时优先按布局语义（间距/对齐）落位。`,
    }
    let structure: AdjustOp['structure']
    try {
      structure = { html: element.outerHTML.slice(0, 6000), styles: styleSnapshot(element) }
    } catch {
      structure = undefined
    }
    pushOp({
      change,
      structure,
      mergeTarget: element,
      undo: () => applyBox(element, width, height, startOffsetX, startOffsetY),
      redo: () => {
        const offsets = offsetsRef.current.get(element)
        const html = element as HTMLElement
        html.style.translate = `${offsetX}px ${offsetY}px`
        offsetsRef.current.set(element, { x: offsetX, y: offsetY, base: offsets?.base ?? '' })
      },
    })
  }

  /** 方向键自由偏移（1px / Shift 8px），同一元素的连续按键合并成一条改动。 */
  const nudge = (dx: number, dy: number) => {
    const element = selectedRef.current
    if (!element) return
    const state = offsetsRef.current.get(element) ?? {
      x: 0,
      y: 0,
      base: (element as HTMLElement).style.translate || '',
    }
    const nextX = state.x + dx
    const nextY = state.y + dy
    const html = element as HTMLElement
    html.style.translate = `${nextX}px ${nextY}px`
    offsetsRef.current.set(element, { ...state, x: nextX, y: nextY })
    bump()
    publish()
    const now = Date.now()
    const last = moveMergeRef.current
    if (last && last.element === element && now - last.at < 800) {
      last.at = now
      last.op.change.at = now
      last.op.change.after = { offsetX: nextX, offsetY: nextY }
      const base = state.base
      last.op.undo = () => {
        html.style.translate = base
      }
      last.op.redo = () => {
        html.style.translate = `${nextX}px ${nextY}px`
      }
      setOps((current) => [...current])
      return
    }
    const meta = freezeRef.current ? metaForClone(freezeRef.current, element) : null
    if (!meta) return
    const change: AdjustChange = {
      id: newAdjustId('chg'),
      kind: 'move',
      at: now,
      target: meta,
      before: { offsetX: state.x, offsetY: state.y },
      after: { offsetX: nextX, offsetY: nextY },
      note: `方向键偏移 translate(${nextX}px, ${nextY}px)；实现时按同一容器内的间距/换序处理。`,
    }
    const op: AdjustOp = {
      change,
      structure: { html: element.outerHTML.slice(0, 6000), styles: styleSnapshot(element) },
      undo: () => {
        html.style.translate = state.base
      },
      redo: () => {
        html.style.translate = `${nextX}px ${nextY}px`
      },
    }
    op.redo()
    setOps((current) => [...current, op])
    redoRef.current = []
    setRedoCount(0)
    moveMergeRef.current = { element, op, at: now }
  }

  const selectElement = (element: Element | null) => {
    setSelected(element && element !== stage ? element : null)
    setSelectedInsertedId(null)
    setIconPicker(false)
    setInsertPanel(false)
    setListEditorId(null)
    setNoteTarget(null)
    setVariantPanel(false)
    setTextPanel(false)
    bump()
  }

  const selectInserted = (item: AdjustInsertedItem) => {
    setSelected(null)
    setSelectedInsertedId(item.id)
    setIconPicker(false)
    setInsertPanel(false)
    setNoteTarget(null)
    bump()
  }

  const clearSelection = () => {
    setSelected(null)
    setSelectedInsertedId(null)
    setIconPicker(false)
    setInsertPanel(false)
    setListEditorId(null)
    setNoteTarget(null)
    setVariantPanel(false)
    setTextPanel(false)
    setSnapLines({ v: [], h: [] })
    setReorderLine(null)
    bump()
  }

  /** 命中：小于 16px 的元素把命中区向外扩 8px，指针擦边也能选中。 */
  const hitTest = (x: number, y: number, alt: boolean): Element | null => {
    const root = freezeRef.current?.stage
    if (!root) return null
    const usable = (element: Element) =>
      root.contains(element) &&
      element !== root &&
      element.tagName !== 'STYLE' &&
      element.tagName !== 'SCRIPT'
    try {
      const chain = document.elementsFromPoint(x, y).filter((element) => element instanceof Element && usable(element)) as Element[]
      let base = chain[0] ?? null
      if (base) {
        const box = base.getBoundingClientRect()
        if (box.width < 16 || box.height < 16) {
          // 直接命中的就是小元素：保持它。
        } else {
          // 背景容器命中时，找指针外扩 8px 内的小元素（例如 10px 状态点、图标）。
          let best: Element | null = null
          let bestArea = Infinity
          const near = new Set<Element>()
          for (const [dx, dy] of [
            [0, 0],
            [8, 0],
            [-8, 0],
            [0, 8],
            [0, -8],
            [8, 8],
            [-8, -8],
          ] as const) {
            for (const element of document.elementsFromPoint(x + dx, y + dy)) {
              if (!(element instanceof Element) || !usable(element)) continue
              if (element !== base) near.add(element)
            }
          }
          for (const candidate of near) {
            const box = candidate.getBoundingClientRect()
            if (box.width >= 16 && box.height >= 16) continue
            // 另一个可交互控件里的图标不抢当前指针，避免点此及彼。
            if (!base.contains(candidate)) {
              const foreignInteractive = candidate.closest(
                'button, a[href], [role="button"], [role="menuitem"]',
              )
              if (foreignInteractive) continue
            }
            const distance = Math.max(
              box.left - x,
              0,
              x - box.right,
              0,
            ) + Math.max(box.top - y, 0, y - box.bottom, 0)
            if (distance > 8) continue
            const area = Math.max(1, box.width * box.height)
            if (area < bestArea) {
              best = candidate
              bestArea = area
            }
          }
          if (best) base = best
        }
      }
      if (!base) return null
      const interactive = base.closest(
        'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
      )
      let picked = interactive && root.contains(interactive) ? interactive : base
      if (alt) {
        const parent = picked.parentElement
        if (parent && parent !== root) picked = parent
      }
      return picked
    } catch {
      /* 节点失效 */
    }
    return null
  }

  const updateHover = () => {
    const point = pointerRef.current
    if (!point) return
    point.raf = 0
    if (dragRef.current || pendingRef.current) return
    const element = hitTest(point.x, point.y, point.alt)
    setHover((current) => (current === element ? current : element))
    setCursor(element ? (point.alt ? 'move' : 'grab') : 'default')
  }

  const queueHover = (x: number, y: number, alt: boolean) => {
    const point = pointerRef.current
    if (!point) {
      pointerRef.current = { x, y, alt, raf: requestAnimationFrame(updateHover) }
      return
    }
    point.x = x
    point.y = y
    point.alt = alt
    if (!point.raf) point.raf = requestAnimationFrame(updateHover)
  }

  const deleteSelected = () => {
    const item = insertedSelected
    if (item) {
      const op = opsRef.current.find(
        (entry) =>
          entry.change.kind === 'insert' &&
          (entry.change.after as { itemId?: string } | undefined)?.itemId === item.id,
      )
      if (op) {
        revertOne(op.change.id)
      } else {
        setInserted((current) => current.filter((entry) => entry.id !== item.id))
        setSelectedInsertedId(null)
      }
      notify('已删除插入的示意控件', 'success')
      return
    }
    const element = selectedRef.current
    if (!element) return
    const meta = freezeRef.current ? metaForClone(freezeRef.current, element) : null
    if (!meta) return
    const parent = element.parentNode
    const next = element.nextSibling
    const html = element.outerHTML.slice(0, 6000)
    const parentSelector = element.parentElement ? cssSelectorFor(element.parentElement) : undefined
    const siblingIndex = element.parentElement
      ? Array.from(element.parentElement.children).indexOf(element)
      : undefined
    const change: AdjustChange = {
      id: newAdjustId('chg'),
      kind: 'delete',
      at: Date.now(),
      target: meta,
      before: {
        html: `${html.slice(0, 400)}${html.length > 400 ? '…' : ''}`,
        htmlFull: html,
        parentSelector,
        index: siblingIndex,
      },
      note: '删除该元素及其子树。',
    }
    pushOp({
      change,
      structure: { html, styles: styleSnapshot(element) },
      undo: () => {
        if (parent) parent.insertBefore(element, next)
      },
      redo: () => {
        element.remove()
      },
    })
    setSelected(null)
    setHover(null)
    notify('已记录删除；可从改动清单回退', 'success')
  }

  /** 用 lucide 图标组件生成一颗静态 svg，替换选中元素里的图标（保留尺寸相关 class/属性）。 */
  const iconSvgMarkup = (Icon: LucideIcon, size: number): SVGSVGElement | null => {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-9999px;top:0;pointer-events:none'
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      flushSync(() => root.render(<Icon size={size} />))
      const svg = host.querySelector('svg')
      return svg ? (svg.cloneNode(true) as SVGSVGElement) : null
    } catch {
      return null
    } finally {
      root.unmount()
      host.remove()
    }
  }

  const replaceIcon = (entry: AdjustIconEntry) => {
    const element = selectedRef.current
    const oldSvg = iconSvgFor(element)
    if (!element || !oldSvg) return
    const meta = freezeRef.current ? metaForClone(freezeRef.current, element) : null
    if (!meta) return
    const beforeName = lucideIconName(oldSvg) ?? 'unknown'
    const size = Math.max(
      12,
      Math.round(oldSvg.getBoundingClientRect().width || oldSvg.width.baseVal.value || 16),
    )
    const fresh = iconSvgMarkup(entry.Icon, size)
    if (!fresh) return
    const extraClasses = Array.from(oldSvg.classList).filter((name) => !name.startsWith('lucide'))
    fresh.setAttribute('class', [...Array.from(fresh.classList), ...extraClasses].join(' '))
    for (const attr of ['width', 'height', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill', 'aria-hidden']) {
      const value = oldSvg.getAttribute(attr)
      if (value) fresh.setAttribute(attr, value)
    }
    if (!oldSvg.getAttribute('width')) fresh.removeAttribute('width')
    if (!oldSvg.getAttribute('height')) fresh.removeAttribute('height')

    const oldParent = oldSvg.parentNode
    const oldNext = oldSvg.nextSibling
    oldSvg.replaceWith(fresh)
    setSelected((current) => (current === oldSvg ? fresh : current))
    bump()
    const change: AdjustChange = {
      id: newAdjustId('chg'),
      kind: 'icon',
      at: Date.now(),
      target: meta,
      before: { icon: beforeName },
      after: { icon: entry.name },
      note: `图标库：lucide / ${entry.name}（只从项目在用的图标集中选）。`,
    }
    pushOp({
      change,
      structure: { html: element.outerHTML.slice(0, 6000), styles: styleSnapshot(element) },
      undo: () => {
        fresh.replaceWith(oldSvg)
        setSelected((current) => (current === fresh ? oldSvg : current))
        bump()
      },
      redo: () => {
        if (oldParent) oldParent.insertBefore(fresh, oldNext)
        setSelected((current) => (current === oldSvg ? fresh : current))
        bump()
      },
    })
    setIconPicker(false)
    notify(`图标已换成 ${entry.name}`, 'success')
  }

  /** 换样式变体：只改 ui/* 的变体 class 并记录变体名。 */
  const changeVariant = (variant: string) => {
    const element = selectedRef.current
    if (!element || !variantInfo) return
    const meta = freezeRef.current ? metaForClone(freezeRef.current, element) : null
    if (!meta) return
    const before = (element.getAttribute('data-tone') ?? element.getAttribute('data-variant') ?? '') as string
    if (!applyVariant(element, variant)) return
    const change: AdjustChange = {
      id: newAdjustId('chg'),
      kind: 'variant',
      at: Date.now(),
      target: meta,
      before: { variant: before },
      after: { variant },
      note: `样式变体：${variantInfo.component} ${before || '?'} → ${variant}（实现时用组件的 variant 属性）。`,
    }
    pushOp({
      change,
      structure: { html: element.outerHTML.slice(0, 6000), styles: styleSnapshot(element) },
      undo: () => {
        applyVariant(element, before)
        bump()
      },
      redo: () => {
        applyVariant(element, variant)
        bump()
      },
    })
    setVariantPanel(false)
    bump()
    notify(`变体已换成 ${variant}`, 'success')
  }

  /** 改纯文本：替换元素下的直接文本节点，记录改前/改后。 */
  const saveText = () => {
    const element = selectedRef.current
    if (!element) return
    const before = elementOwnText(element)
    const after = textDraft.trim()
    setTextPanel(false)
    if (!after || after === before) return
    const meta = freezeRef.current ? metaForClone(freezeRef.current, element) : null
    if (!meta) return
    setElementText(element, after)
    const change: AdjustChange = {
      id: newAdjustId('chg'),
      kind: 'text',
      at: Date.now(),
      target: meta,
      before: { text: before },
      after: { text: after },
      note: '纯文本改文字；富文本与代码块不在此开放。',
    }
    pushOp({
      change,
      structure: { html: element.outerHTML.slice(0, 6000), styles: styleSnapshot(element) },
      undo: () => {
        setElementText(element, before)
        bump()
      },
      redo: () => {
        setElementText(element, after)
        bump()
      },
    })
    bump()
    notify('已记录改文字', 'success')
  }

  /** 隐藏：保留布局占位，只设 visibility:hidden，与删除区分。 */
  const hideSelected = () => {
    const element = selectedRef.current
    if (!element || insertedSelected) return
    const meta = freezeRef.current ? metaForClone(freezeRef.current, element) : null
    if (!meta) return
    const before = { style: captureBoxStyle(element) }
    const html = element as HTMLElement
    html.style.visibility = 'hidden'
    element.setAttribute('data-adjust-hidden', '')
    const change: AdjustChange = {
      id: newAdjustId('chg'),
      kind: 'hide',
      at: Date.now(),
      target: meta,
      before,
      after: { hidden: true },
      note: '隐藏（保留布局占位），不是删除。',
    }
    pushOp({
      change,
      structure: { html: element.outerHTML.slice(0, 6000), styles: styleSnapshot(element) },
      undo: () => {
        restoreBoxStyle(element, before.style)
        element.removeAttribute('data-adjust-hidden')
        bump()
      },
      redo: () => {
        ;(element as HTMLElement).style.visibility = 'hidden'
        element.setAttribute('data-adjust-hidden', '')
        bump()
      },
    })
    bump()
    notify('已隐藏（保留占位）；可从改动清单回退', 'success')
  }

  const insertControl = (option: AdjustInsertOption, x?: number, y?: number) => {
    const id = newAdjustId('ins')
    const index = insertedRef.current.length
    const item: AdjustInsertedItem = {
      id,
      kind: option.kind,
      group: option.group,
      label: option.label,
      variant: option.variant,
      x: Math.round(x ?? window.innerWidth / 2 - 150 + index * 24),
      y: Math.round(y ?? window.innerHeight / 2 - 80 + index * 24),
      behavior: '',
      rows: [],
      container: option.container,
    }
    const meta = insertedMeta(item)
    const change: AdjustChange = {
      id: newAdjustId('chg'),
      kind: 'insert',
      at: Date.now(),
      target: meta,
      after: {
        itemId: id,
        component: insertedComponentLabel(item),
        variant: option.variant,
        rows: [],
        note: '',
        position: { x: item.x, y: item.y },
      },
      note: option.container
        ? '示意草稿：容器与示意行只表达信息结构，实现时按 ui/* 复刻，尺寸与间距取设计 token。'
        : '示意草稿：实现时按 ui/* 的同名组件与变体复刻，不要直接搬副本 HTML。',
    }
    pushOp({
      change,
      undo: () => {
        setInserted((current) => current.filter((entry) => entry.id !== id))
        setSelectedInsertedId((current) => (current === id ? null : current))
        setListEditorId((current) => (current === id ? null : current))
      },
      redo: () => {
        setInserted((current) => (current.some((entry) => entry.id === id) ? current : [...current, item]))
        setSelectedInsertedId(id)
        setSelected(null)
      },
    })
    setInsertPanel(false)
    setSelected(null)
    setSelectedInsertedId(id)
    bump()
    if (option.container) setListEditorId(id)
    notify(`已插入${option.label}`, 'success')
  }

  /** 更新插入的示意控件，并把内容/备注同步进改动清单。 */
  const patchInserted = (id: string, patch: Partial<AdjustInsertedItem>) => {
    const current = insertedRef.current.find((entry) => entry.id === id)
    if (!current) return
    const merged: AdjustInsertedItem = { ...current, ...patch }
    insertedRef.current = insertedRef.current.map((entry) => (entry.id === id ? merged : entry))
    setInserted(insertedRef.current)
    const op = opsRef.current.find(
      (entry) =>
        entry.change.kind === 'insert' &&
        (entry.change.after as { itemId?: string } | undefined)?.itemId === id,
    )
    if (op) {
      op.change.after = {
        itemId: merged.id,
        component: insertedComponentLabel(merged),
        variant: merged.variant,
        rows: merged.rows.map((row) => ({
          component: row.component,
          title: row.title,
          note: row.note,
        })),
        note: merged.behavior,
        position: { x: merged.x, y: merged.y },
      }
      op.change.behavior = merged.behavior || undefined
      setOps((entries) => [...entries])
    }
    bump()
    publish()
  }

  const addListRow = (item: AdjustInsertedItem) => {
    const row: AdjustInsertedRow = {
      id: newAdjustId('row'),
      component: 'ListRow',
      title: `列表项 ${item.rows.length + 1}`,
      note: '',
    }
    patchInserted(item.id, { rows: [...item.rows, row] })
  }

  const updateListRow = (item: AdjustInsertedItem, rowId: string, patch: Partial<AdjustInsertedRow>) => {
    patchInserted(item.id, {
      rows: item.rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
    })
  }

  const removeListRow = (item: AdjustInsertedItem, rowId: string) => {
    patchInserted(item.id, { rows: item.rows.filter((row) => row.id !== rowId) })
  }

  const openNoteForSelection = () => {
    if (!selectedMeta) return
    setIconPicker(false)
    setInsertPanel(false)
    setListEditorId(null)
    setNoteTarget({ kind: 'selection' })
    setNoteText(insertedSelected?.behavior ?? '')
  }

  const openNoteForChange = (op: AdjustOp) => {
    setIconPicker(false)
    setInsertPanel(false)
    setListEditorId(null)
    setNoteTarget({ kind: 'change', id: op.change.id })
    setNoteText(op.change.behavior ?? '')
  }

  const saveNote = () => {
    const text = noteText.trim()
    if (noteTarget?.kind === 'change') {
      const op = opsRef.current.find((entry) => entry.change.id === noteTarget.id)
      if (op) {
        op.change.behavior = text || undefined
        setOps((prev) => [...prev])
        publish()
        notify(text ? '行为备注已更新' : '已清除行为备注', 'success')
      }
      setNoteTarget(null)
      return
    }
    if (insertedSelected) {
      patchInserted(insertedSelected.id, { behavior: text })
      setNoteTarget(null)
      if (text) notify('行为备注已更新', 'success')
      return
    }
    const meta = selectedMeta
    const element = selectedRef.current
    if (!meta || !element) {
      setNoteTarget(null)
      return
    }
    if (!text) {
      setNoteTarget(null)
      return
    }
    const change: AdjustChange = {
      id: newAdjustId('chg'),
      kind: 'note',
      at: Date.now(),
      target: meta,
      after: { behavior: text },
      behavior: text,
      note: '行为备注：实现时按描述补交互，不改视觉。',
    }
    pushOp({
      change,
      structure: { html: element.outerHTML.slice(0, 6000), styles: styleSnapshot(element) },
      undo: () => undefined,
      redo: () => undefined,
    })
    setNoteTarget(null)
    notify('已记录行为备注', 'success')
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>, handle: (typeof HANDLE_LIST)[number]) => {
    const insertedId = selectedInsertedRef.current ?? undefined
    const element = insertedId
      ? insertedDomRef.current.get(insertedId) ?? null
      : selectedRef.current
    if (!element) return
    event.preventDefault()
    event.stopPropagation()
    const box = element.getBoundingClientRect()
    const offset = offsetsRef.current.get(element)
    const drag: ResizeDrag = {
      kind: 'resize',
      handle,
      element,
      ...(insertedId ? { insertedId } : {}),
      startX: event.clientX,
      startY: event.clientY,
      startW: box.width,
      startH: box.height,
      startOffsetX: offset?.x ?? 0,
      startOffsetY: offset?.y ?? 0,
      live: null,
    }
    dragRef.current = drag
    setHover(null)
    bump()
  }

  /**
   * 指针常落在行内按钮/文字上：向上找「同容器里有尺寸相近的兄弟」的最小单元（如整行）。
   * 行尾的挂载/操作图标与整行宽度差很多，不会被当成换序对象。
   */
  const reorderUnit = (element: Element): Element => {
    let target = element
    let parent = target.parentElement
    for (let depth = 0; depth < 4 && parent && parent !== stage; depth++) {
      const box = target.getBoundingClientRect()
      const similar = Array.from(parent.children).filter((child) => {
        if (child === target || !(child instanceof Element)) return false
        const rect = child.getBoundingClientRect()
        return Math.abs(rect.width - box.width) <= 32 && Math.abs(rect.height - box.height) <= 32
      })
      if (similar.length >= 1) break
      target = parent
      parent = target.parentElement
    }
    return target
  }

  const beginReorder = (element: Element, startX: number, startY: number): ReorderDrag | null => {
    const parent = element.parentElement
    if (!parent || parent === stage) return null
    const siblings = Array.from(parent.children).filter(
      (child): child is Element => child instanceof Element && child !== element,
    )
    if (siblings.length === 0) return null
    const boxes = siblings.map((child) => child.getBoundingClientRect())
    const tops = boxes.map((box) => box.top)
    const horizontal = tops.every((top) => Math.abs(top - tops[0]) < 4)
    return {
      kind: 'reorder',
      element,
      parent,
      siblings,
      // 全体子元素中的位置，与 siblings（不含自身）里的插入位置同一把尺子。
      startIndex: Array.from(parent.children).indexOf(element),
      oldNextSibling: element.nextSibling,
      axis: horizontal ? 'x' : 'y',
      index: siblings.length,
      line: null,
    }
  }

  const updateReorder = (drag: ReorderDrag, clientX: number, clientY: number) => {
    const horizontal = drag.axis === 'x'
    const position = horizontal ? clientX : clientY
    let index = drag.siblings.length
    let line: ReorderDrag['line'] = null
    for (let i = 0; i < drag.siblings.length; i++) {
      const box = drag.siblings[i].getBoundingClientRect()
      const middle = horizontal ? box.left + box.width / 2 : box.top + box.height / 2
      if (position < middle) {
        index = i
        line = horizontal
          ? { left: box.left, top: box.top, width: 1, height: box.height }
          : { left: box.left, top: box.top, width: box.width, height: 1 }
        break
      }
    }
    if (index === drag.siblings.length) {
      const last = drag.siblings[drag.siblings.length - 1].getBoundingClientRect()
      line = horizontal
        ? { left: last.right, top: last.top, width: 1, height: last.height }
        : { left: last.left, top: last.bottom, width: last.width, height: 1 }
    }
    drag.index = index
    drag.line = line
    setReorderLine(line)
  }

  const finishReorder = (drag: ReorderDrag) => {
    setReorderLine(null)
    const next = drag.index < drag.siblings.length ? drag.siblings[drag.index] : null
    if (drag.startIndex === drag.index) return
    const previous = drag.index > 0 ? drag.siblings[drag.index - 1] : null
    const afterLabel =
      previous?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 40) || undefined
    const meta = freezeRef.current ? metaForClone(freezeRef.current, drag.element) : null
    if (!meta) {
      drag.parent.insertBefore(drag.element, next)
      bump()
      return
    }
    const change: AdjustChange = {
      id: newAdjustId('chg'),
      kind: 'reorder',
      at: Date.now(),
      target: meta,
      before: { index: drag.startIndex, siblings: drag.siblings.length + 1 },
      after: { index: drag.index, siblings: drag.siblings.length + 1, afterLabel },
      note: afterLabel
        ? `同容器换序：在「${afterLabel}」之后（第 ${drag.index + 1} 个位置）。`
        : `同容器换序：移到第 ${drag.index + 1} 个位置。`,
    }
    let structure: AdjustOp['structure']
    try {
      structure = { html: drag.parent.outerHTML.slice(0, 6000), styles: styleSnapshot(drag.parent) }
    } catch {
      structure = undefined
    }
    pushOp({
      change,
      structure,
      undo: () => {
        drag.parent.insertBefore(drag.element, drag.oldNextSibling)
        bump()
      },
      redo: () => {
        drag.parent.insertBefore(drag.element, next)
        bump()
      },
    })
    bump()
  }

  const beginMove = (element: Element, startX: number, startY: number): MoveDrag => {
    const box = element.getBoundingClientRect()
    const offset = offsetsRef.current.get(element)
    return {
      kind: 'move',
      element,
      startX,
      startY,
      startOffsetX: offset?.x ?? 0,
      startOffsetY: offset?.y ?? 0,
      startRect: { left: box.left, top: box.top, width: box.width, height: box.height },
      live: null,
    }
  }

  const updateMove = (drag: MoveDrag, clientX: number, clientY: number) => {
    let dx = clientX - drag.startX
    let dy = clientY - drag.startY
    const boxes: DOMRect[] = []
    if (drag.element.parentElement) {
      for (const child of Array.from(drag.element.parentElement.children)) {
        if (child !== drag.element && child instanceof Element) boxes.push(child.getBoundingClientRect())
      }
      boxes.push(drag.element.parentElement.getBoundingClientRect())
    }
    const candidatesX: number[] = []
    const candidatesY: number[] = []
    for (const box of boxes) {
      candidatesX.push(box.left, box.left + box.width / 2, box.right)
      candidatesY.push(box.top, box.top + box.height / 2, box.bottom)
    }
    const edgesX = [drag.startRect.left + dx, drag.startRect.left + dx + drag.startRect.width / 2, drag.startRect.left + dx + drag.startRect.width]
    const edgesY = [drag.startRect.top + dy, drag.startRect.top + dy + drag.startRect.height / 2, drag.startRect.top + dy + drag.startRect.height]
    let bestX: number | null = null
    let bestY: number | null = null
    let bestDx = Infinity
    let bestDy = Infinity
    for (const edge of edgesX) {
      for (const candidate of candidatesX) {
        const delta = candidate - edge
        if (Math.abs(delta) <= 6 && Math.abs(delta) < Math.abs(bestDx)) {
          bestDx = delta
          bestX = candidate
        }
      }
    }
    for (const edge of edgesY) {
      for (const candidate of candidatesY) {
        const delta = candidate - edge
        if (Math.abs(delta) <= 6 && Math.abs(delta) < Math.abs(bestDy)) {
          bestDy = delta
          bestY = candidate
        }
      }
    }
    if (bestX !== null) dx += bestDx
    if (bestY !== null) dy += bestDy
    setSnapLines({ v: bestX !== null ? [bestX] : [], h: bestY !== null ? [bestY] : [] })
    dx = Math.round(dx)
    dy = Math.round(dy)
    const nextX = drag.startOffsetX + dx
    const nextY = drag.startOffsetY + dy
    const html = drag.element as HTMLElement
    html.style.translate = `${nextX}px ${nextY}px`
    const base = offsetsRef.current.get(drag.element)?.base ?? ''
    offsetsRef.current.set(drag.element, { x: nextX, y: nextY, base })
    drag.live = { offsetX: nextX, offsetY: nextY }
    bump()
  }

  /** 窗口级拖动处理：读 ref 里的最新状态，避免 window 监听器闭包过期。 */
  const handleWindowMove = (event: PointerEvent) => {
    if (insertedMoveRef.current) {
      const move = insertedMoveRef.current
      if (!move.moved && Math.hypot(event.clientX - move.startX, event.clientY - move.startY) <= 3) return
      move.moved = true
      const item = insertedRef.current.find((entry) => entry.id === move.itemId)
      if (!item) return
      const x = Math.round(move.x + event.clientX - move.startX)
      const y = Math.round(move.y + event.clientY - move.startY)
      setInserted((current) =>
        current.map((entry) => (entry.id === move.itemId ? { ...entry, x, y } : entry)),
      )
      bump()
      return
    }
    if (insertDragRef.current) {
      const drag = insertDragRef.current
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
        setDropGhost({ x: event.clientX, y: event.clientY, label: drag.option.label })
      }
      return
    }
    const pending = pendingRef.current
    if (pending && !dragRef.current) {
      if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) <= 4) return
      const element = pending.freeMove ? pending.element : reorderUnit(pending.element)
      const parent = element.parentElement
      const canReorder = !pending.freeMove && parent && parent !== stage && parent.children.length > 1
      const drag = canReorder ? beginReorder(element, pending.startX, pending.startY) : null
      dragRef.current = drag ?? beginMove(element, pending.startX, pending.startY)
      if (drag && element !== pending.element) setSelected(element)
      pendingRef.current = null
      setHover(null)
      bump()
    }
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'resize') {
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      let width = drag.startW
      let height = drag.startH
      let offsetX = drag.startOffsetX
      let offsetY = drag.startOffsetY
      if (drag.handle.fx > 0) width += dx
      if (drag.handle.fx < 0) {
        width -= dx
        offsetX += dx
      }
      if (drag.handle.fy > 0) height += dy
      if (drag.handle.fy < 0) {
        height -= dy
        offsetY += dy
      }
      const snapped = snapSize(Math.max(8, width), Math.max(8, height))
      if (drag.insertedId) {
        const id = drag.insertedId
        setInserted((current) =>
          current.map((entry) =>
            entry.id === id
              ? { ...entry, width: snapped.width, height: snapped.height }
              : entry,
          ),
        )
      } else {
        applyBox(drag.element, snapped.width, snapped.height, offsetX, offsetY)
      }
      drag.live = {
        width: snapped.width,
        height: snapped.height,
        offsetX: Math.round(offsetX),
        offsetY: Math.round(offsetY),
        tokens: snapped.tokens,
        standard: snapped.standard,
      }
      setLastSnap({
        label: [snapped.tokens.width, snapped.tokens.height].filter(Boolean).join(' · ') || '自由值',
        standard: snapped.standard,
      })
      bump()
      return
    }
    if (drag.kind === 'reorder') {
      updateReorder(drag, event.clientX, event.clientY)
      return
    }
    updateMove(drag, event.clientX, event.clientY)
  }

  const handleWindowUp = () => {
    if (insertedMoveRef.current) {
      const move = insertedMoveRef.current
      insertedMoveRef.current = null
      if (move.moved) {
        const item = insertedRef.current.find((entry) => entry.id === move.itemId)
        if (item) patchInserted(item.id, { x: item.x, y: item.y })
      }
      return
    }
    if (insertDragRef.current) {
      const drag = insertDragRef.current
      insertDragRef.current = null
      const ghost = dropGhostRef.current
      setDropGhost(null)
      if (ghost) {
        suppressClickRef.current = true
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 350)
        insertControl(drag.option, ghost.x - 60, ghost.y - 16)
      }
      return
    }
    const drag = dragRef.current
    dragRef.current = null
    pendingRef.current = null
    if (!drag) return
    if (drag.kind === 'resize') {
      if (drag.live) addResizeOp(drag, drag.live)
    } else if (drag.kind === 'reorder') {
      finishReorder(drag)
    } else if (drag.live) {
      addMoveOp(
        drag.element,
        drag.startOffsetX,
        drag.startOffsetY,
        drag.live.offsetX,
        drag.live.offsetY,
        drag.startRect.width,
        drag.startRect.height,
      )
    }
    setSnapLines({ v: [], h: [] })
    setLastSnap(null)
    setCursor(hover ? 'grab' : 'default')
    bump()
  }

  const dropGhostRef = useRef(dropGhost)
  dropGhostRef.current = dropGhost
  const handlersRef = useRef({ move: handleWindowMove, up: handleWindowUp })
  handlersRef.current = { move: handleWindowMove, up: handleWindowUp }

  useEffect(() => {
    if (phase !== 'ready') return
    const move = (event: PointerEvent) => handlersRef.current.move(event)
    const up = () => handlersRef.current.up()
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
    }
  }, [phase])

  // 键盘：Delete 删除、Ctrl+Z 撤销、方向键微调。反馈模式的全局拦截已为调整模式放行这些键。
  const keyboardRef = useRef<(event: KeyboardEvent) => void>(() => undefined)
  keyboardRef.current = (event: KeyboardEvent) => {
    const target = event.target
    if (target instanceof Element && target.closest('input,textarea,[contenteditable="true"]')) return
    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.shiftKey) redo()
      else undo()
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!selectedRef.current && !selectedInsertedRef.current) return
      event.preventDefault()
      event.stopImmediatePropagation()
      deleteSelected()
      return
    }
    if (event.key === 'Tab') {
      const current = selectedRef.current
      if (!current) return
      const parent = current.parentElement
      const root = freezeRef.current?.stage
      if (!parent || parent === root) return
      const siblings = Array.from(parent.children).filter(
        (child): child is Element => child instanceof Element && child !== current,
      )
      if (siblings.length === 0) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const index = Array.from(parent.children).indexOf(current)
      const total = parent.children.length
      const ordered = [...siblings].sort((a, b) => {
        const ai = Array.from(parent.children).indexOf(a)
        const bi = Array.from(parent.children).indexOf(b)
        const delta = (i: number) => (event.shiftKey ? (index - i + total) % total : (i - index + total) % total)
        return delta(ai) - delta(bi)
      })
      selectElement(ordered[0] ?? null)
      setHover(ordered[0] ?? null)
      return
    }
    if (event.key === 'Enter') {
      const current = selectedRef.current
      if (!current) return
      const child = Array.from(current.children).find((node): node is Element => node instanceof Element)
      if (!child) return
      event.preventDefault()
      event.stopImmediatePropagation()
      selectElement(child)
      setHover(child)
      return
    }
    if (event.key.startsWith('Arrow')) {
      if (!selectedRef.current) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const step = event.shiftKey ? 8 : 1
      if (event.key === 'ArrowLeft') nudge(-step, 0)
      if (event.key === 'ArrowRight') nudge(step, 0)
      if (event.key === 'ArrowUp') nudge(0, -step)
      if (event.key === 'ArrowDown') nudge(0, step)
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyboardRef.current(event)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const handleEscape = (): boolean => {
    if (finishBusy) return true
    if (noteTarget) {
      setNoteTarget(null)
      return true
    }
    if (iconPicker) {
      setIconPicker(false)
      return true
    }
    if (insertPanel) {
      setInsertPanel(false)
      return true
    }
    if (variantPanel) {
      setVariantPanel(false)
      return true
    }
    if (textPanel) {
      setTextPanel(false)
      return true
    }
    if (listEditorId) {
      setListEditorId(null)
      return true
    }
    if (selectedRef.current || selectedInsertedRef.current) {
      clearSelection()
      return true
    }
    return false
  }
  const escapeHandlerRef = useRef(handleEscape)
  escapeHandlerRef.current = handleEscape
  useEffect(() => {
    escapeRef.current = () => escapeHandlerRef.current()
    return () => {
      escapeRef.current = null
    }
  }, [escapeRef])

  /** 临时退出冻结副本：让用户先操作真实界面（打开菜单、展开行等），随后重新冻结。 */
  const releaseCopy = () => {
    if (phase !== 'ready') return
    freezeRef.current?.dispose()
    freezeRef.current = null
    setFreeze(null)
    releasedRef.current = true
    clearSelection()
    setIconPicker(false)
    setInsertPanel(false)
    setListEditorId(null)
    setNoteTarget(null)
    setVariantPanel(false)
    setTextPanel(false)
    setPhase('released')
    onReleaseChange?.(true)
    notify('已退出副本：现在可以操作真实界面，摆好状态后点「重新冻结」', 'info')
  }

  /** 重新冻结真实界面，并按选择器把已有改动挂到新副本；挂不上的标红。 */
  const refreezeCopy = () => {
    if (phase !== 'released' && phase !== 'ready') return
    setPhase('freezing')
    requestAnimationFrame(() => {
      if (freezeRef.current) freezeRef.current.dispose()
      const frozen = freezeAppViewport()
      freezeRef.current = frozen
      setFreeze(frozen)
      const changes = opsRef.current.map((op) => op.change)
      const failed = reattachChanges(changes, frozen.stage)
      const rebuilt = changes.map((change) => opFromChange(change, frozen.stage))
      opsRef.current = rebuilt
      setOps(rebuilt)
      redoRef.current = []
      setRedoCount(0)
      releasedRef.current = false
      onReleaseChange?.(false)
      setPhase('ready')
      bump()
      publish()
      notify(
        failed.length
          ? `已重新冻结；${failed.length} 项改动按选择器没挂上（清单已标红）`
          : '已重新冻结，已有改动全部挂到新副本',
        failed.length ? 'error' : 'success',
      )
    })
  }

  const copyMarkdown = async () => {
    const snapshot = buildSnapshot()
    if (!snapshot) return
    try {
      await navigator.clipboard.writeText(snapshot.markdown)
      notify('已复制 Markdown 说明', 'success')
    } catch {
      notify('复制失败', 'error')
    }
  }

  const finish = async () => {
    const frozen = freezeRef.current
    if (!frozen || finishBusy) return
    setFinishBusy(true)
    try {
      setIconPicker(false)
      setInsertPanel(false)
      setListEditorId(null)
      setNoteTarget(null)
      let clone: HTMLElement | null = null
      const layer = insertedLayerRef.current
      if (layer) {
        clone = layer.cloneNode(true) as HTMLElement
        clone.removeAttribute(UI_ATTR)
        clone.removeAttribute('data-adjust-ui')
        clone.setAttribute('aria-hidden', 'true')
        clone.style.pointerEvents = 'none'
        frozen.stage.appendChild(clone)
      }
      let afterImage: string | null = null
      try {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        afterImage = await captureSnapshotShot(frozen.stage)
      } finally {
        clone?.remove()
      }
      const snapshot = buildSnapshot(true)
      if (!snapshot) return
      onFinish({
        id: sessionIdRef.current,
        itemId: itemIdRef.current,
        snapshot,
        beforeImage: beforeImageRef.current,
        afterImage,
        sourceAvailable: snapshot.changes.some((change) => !!change.target.source),
      })
    } finally {
      setFinishBusy(false)
    }
  }

  const summary: AdjustSummary = useMemo(
    () => ({
      changeCount: ops.length,
      freezeMs: freeze?.stats.durationMs ?? 0,
      tokens: [...new Set(ops.flatMap((op) => [op.change.tokens?.width, op.change.tokens?.height]).filter((value): value is string => !!value))],
      nonStandard: ops.filter((op) => op.change.standard === false).length,
      sourceAvailable: ops.some((op) => !!op.change.target.source),
    }),
    [ops, freeze],
  )

  const selectionLabel = insertedSelected
    ? insertedComponentLabel(insertedSelected)
    : selectedMeta?.component ?? selectedMeta?.ariaLabel ?? selectedMeta?.tag ?? ''

  if (typeof document === 'undefined') return null

  const ready = phase === 'ready'

  return createPortal(
    <>
      {/* 命中层：在冻结副本之上接管指针；工具栏与面板在其上方。 */}
      {ready && (
        <div
          {...{ [UI_ATTR]: '' }}
          data-adjust-hit-layer=""
          data-cursor={cursor}
          aria-hidden
          className="fixed inset-0 z-[120] touch-none"
          style={{ cursor }}
          onPointerMove={(event) => {
            if (dragRef.current || pendingRef.current) return
            queueHover(event.clientX, event.clientY, event.altKey)
          }}
          onPointerLeave={() => {
            setHover(null)
            pointerRef.current = null
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            const base = hitTest(event.clientX, event.clientY, false)
            if (!base) {
              clearSelection()
              return
            }
            // Alt+点击选父级；按住 Alt 拖动则自由移动（默认拖动是同容器换序）。
            const freeMove = event.altKey
            let element = base
            if (event.altKey && base !== selectedRef.current && base.parentElement && base.parentElement !== stage) {
              element = base.parentElement
            }
            selectElement(element)
            setCursor('grabbing')
            pendingRef.current = {
              element,
              startX: event.clientX,
              startY: event.clientY,
              freeMove,
            }
          }}
        />
      )}

      {/* 悬停/选中框、8 手柄、换序/吸附线：pointer-events:none，不改元素自身样式。 */}
      <div {...{ [UI_ATTR]: '' }} className="pointer-events-none fixed inset-0 z-[121]" aria-hidden>
        {ready && hover && hoverRect && (
          <div
            className="absolute rounded-[2px]"
            style={{
              left: hoverRect.x,
              top: hoverRect.y,
              width: hoverRect.width,
              height: hoverRect.height,
              boxShadow: '0 0 0 2px var(--t-annotation)',
            }}
          >
            <span className="absolute -top-5 left-0 max-w-[280px] truncate rounded bg-annotation px-1.5 py-0.5 text-[11px] font-medium leading-none text-white">
              {hoverMeta?.component ?? hoverMeta?.ariaLabel ?? hover.tagName.toLowerCase()}
            </span>
          </div>
        )}
        {reorderLine && (
          <div
            className="absolute bg-annotation"
            style={{
              left: reorderLine.left,
              top: reorderLine.top,
              width: Math.max(2, reorderLine.width),
              height: Math.max(2, reorderLine.height),
              boxShadow: '0 0 0 1px var(--t-annotation)',
            }}
          />
        )}
        {snapLines.v.map((x) => (
          <div key={`v-${x}`} className="absolute inset-y-0 w-px bg-annotation/80" style={{ left: x }} />
        ))}
        {snapLines.h.map((y) => (
          <div key={`h-${y}`} className="absolute inset-x-0 h-px bg-annotation/80" style={{ top: y }} />
        ))}
        {ready && selectionBox(selectedRect, selected || insertedSelected ? HANDLE_LIST : null, startResize)}
      </div>

      {/* 选中元素旁的快捷操作条 */}
      {ready && selectedRect && selectedMeta && (
        <AdjustFloating
          key={`bar-${selectionPadding.top}-${selectionPadding.right}-${selectionPadding.bottom}-${selectionPadding.left}`}
          anchor={barPlacement.anchor}
          side={barPlacement.side}
          align="center"
          sideOffset={selectedRect.width < 28 || selectedRect.height < 28 ? 20 : 12}
          padding={selectionPadding}
          layer={134}
          ariaLabel="选中元素操作"
          dataAttrs={{ 'data-adjust-selection-bar': '' }}
          className="pointer-events-auto flex max-w-[calc(100vw-16px)] flex-wrap items-center gap-1 rounded-lg border border-border bg-surface p-1 shadow-md"
          style={{
            maxWidth: Math.max(
              220,
              window.innerWidth - selectionPadding.left - selectionPadding.right - 2,
            ),
          }}
        >
          <span
            className="max-w-[150px] truncate px-1 text-[11px] text-muted"
            data-tip={insertedSelected ? '刚插入的示意控件' : selectedMeta.selector}
          >
            {selectionLabel}
          </span>
          <span className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
            {selectedRect.width}×{selectedRect.height}
          </span>
          {insertedSelected ? (
            <Badge tone="neutral">ui 组件默认尺寸</Badge>
          ) : (
            sizeInfo && <AdjustStateBadge standard={sizeInfo.standard} label={sizeInfo.label} />
          )}
          {lastSnap && <Badge tone={lastSnap.standard ? 'neutral' : 'warn'}>{lastSnap.label}</Badge>}
          <Button
            size="inline"
            variant="ghost"
            icon={<MessageSquare size={12} />}
            onClick={openNoteForSelection}
          >
            行为备注
          </Button>
          {insertedSelected ? (
            <>
              {insertedSelected.container && (
                <Button
                  size="inline"
                  variant="ghost"
                  icon={<Layers size={12} />}
                  onClick={() => {
                    setNoteTarget(null)
                    setInsertPanel(false)
                    setIconPicker(false)
                    setListEditorId((current) =>
                      current === insertedSelected.id ? null : insertedSelected.id,
                    )
                  }}
                >
                  展开编辑
                </Button>
              )}
              <Button
                size="inline"
                variant="danger-ghost"
                icon={<Trash2 size={12} />}
                onClick={deleteSelected}
              >
                删除
              </Button>
            </>
          ) : (
            <>
              {variantInfo && (
                <Button
                  size="inline"
                  variant="ghost"
                  icon={<Layers size={12} />}
                  tooltip={`当前变体：${variantInfo.current}`}
                  onClick={() => {
                    setTextPanel(false)
                    setIconPicker(false)
                    setVariantPanel((open) => !open)
                  }}
                >
                  换变体
                </Button>
              )}
              {ownText && (
                <Button
                  size="inline"
                  variant="ghost"
                  icon={<PencilLine size={12} />}
                  onClick={() => {
                    setVariantPanel(false)
                    setIconPicker(false)
                    setTextDraft(ownText)
                    setTextPanel(true)
                  }}
                >
                  改文字
                </Button>
              )}
              <Button
                size="inline"
                variant="ghost"
                icon={<EyeOff size={12} />}
                tooltip="隐藏但保留布局占位（与删除区分）"
                onClick={hideSelected}
              >
                隐藏
              </Button>
              <Button
                size="inline"
                variant="ghost"
                icon={<Wand2 size={12} />}
                disabled={!iconTarget}
                tooltip={iconTarget ? `当前图标：${currentIconName ?? '未知'}` : '选中的元素里没有图标'}
                onClick={() => {
                  setInsertPanel(false)
                  setListEditorId(null)
                  setIconPicker((open) => !open)
                }}
              >
                换图标
              </Button>
              <Button
                size="inline"
                variant="danger-ghost"
                icon={<Trash2 size={12} />}
                onClick={deleteSelected}
              >
                删除
              </Button>
            </>
          )}
        </AdjustFloating>
      )}

      {/* 插入的示意控件：真实复用 ui/* 组件，渲染在冻结副本之上 */}
      <div
        {...{ [UI_ATTR]: '' }}
        data-adjust-inserted-layer=""
        ref={insertedLayerRef}
        className={cn(
          'pointer-events-none fixed inset-0 z-[122]',
          phase !== 'ready' && 'invisible',
        )}
      >
        {inserted.map((item) => (
          <div
            key={item.id}
            data-adjust-inserted={item.id}
            ref={(element) => {
              if (element) insertedDomRef.current.set(item.id, element)
              else insertedDomRef.current.delete(item.id)
            }}
            className={cn(
              'pointer-events-auto absolute',
              selectedInsertedId === item.id &&
                'rounded-lg outline-2 outline-offset-4 outline-annotation',
            )}
            style={{ left: item.x, top: item.y }}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              event.stopPropagation()
              selectInserted(item)
              insertedMoveRef.current = {
                itemId: item.id,
                startX: event.clientX,
                startY: event.clientY,
                x: item.x,
                y: item.y,
                moved: false,
              }
            }}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              selectInserted(item)
            }}
          >
            {renderInserted(item)}
          </div>
        ))}
      </div>

      {dropGhost && (
        <div
          {...{ [UI_ATTR]: '' }}
          className="pointer-events-none fixed z-[134] rounded-md border border-annotation bg-surface px-2 py-1 text-[11px] text-text shadow-md"
          style={{ left: dropGhost.x + 12, top: dropGhost.y + 12 }}
        >
          {dropGhost.label} · 松开插入
        </div>
      )}

      {iconPicker && (
        <AdjustIconPicker
          currentIcon={currentIconName}
          query={iconQuery}
          onQueryChange={setIconQuery}
          onPick={replaceIcon}
          onClose={() => setIconPicker(false)}
        />
      )}

      {insertPanel && (
        <AdjustInsertPanel
          onPick={(option) => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false
              return
            }
            insertControl(option)
          }}
          onOptionPointerDown={(option, event) => {
            if (event.button !== 0) return
            insertDragRef.current = { option, startX: event.clientX, startY: event.clientY }
          }}
          onClose={() => {
            setInsertPreviewKey(null)
            setInsertPanel(false)
          }}
          toolbarTop={adjustRects.toolbar?.top}
          onPreviewChange={setInsertPreviewKey}
        />
      )}

      {listEditorId &&
        (() => {
          const item = inserted.find((entry) => entry.id === listEditorId)
          if (!item) return null
          return (
            <AdjustListEditor
              item={item}
              onBehaviorChange={(value) => patchInserted(item.id, { behavior: value })}
              onAddRow={() => addListRow(item)}
              onUpdateRow={(rowId, patch) => updateListRow(item, rowId, patch)}
              onRemoveRow={(rowId) => removeListRow(item, rowId)}
              onClose={() => setListEditorId(null)}
            />
          )
        })()}

      {variantPanel && variantInfo && (
        <AdjustVariantPanel
          component={variantInfo.component}
          variants={variantInfo.variants}
          current={variantInfo.current}
          onPick={changeVariant}
          onClose={() => setVariantPanel(false)}
        />
      )}

      {textPanel && selected && (
        <AdjustTextPanel
          title={selectionLabel}
          value={textDraft}
          onChange={setTextDraft}
          onSave={saveText}
          onClose={() => setTextPanel(false)}
        />
      )}

      {noteTarget && (
        <AdjustNotePanel
          title={
            noteTarget.kind === 'change'
              ? adjustKindLabel(
                  opsRef.current.find((op) => op.change.id === noteTarget.id)?.change.kind ?? 'note',
                )
              : selectionLabel
          }
          value={noteText}
          onChange={setNoteText}
          onSave={saveNote}
          onClose={() => setNoteTarget(null)}
        />
      )}

      <AdjustChangeList
        ops={ops}
        onSelect={(op) => {
          if (op.change.kind === 'insert') {
            const itemId = (op.change.after as { itemId?: string } | undefined)?.itemId
            const item = inserted.find((entry) => entry.id === itemId)
            if (item) {
              selectInserted(item)
              return
            }
          }
          const element = freezeRef.current?.stage.querySelector(op.change.target.selector)
          if (element) selectElement(element)
        }}
        onNote={openNoteForChange}
        onRevert={(op) => revertOne(op.change.id)}
      />

      {/* 底部状态条 */}
      <div
        {...{ [UI_ATTR]: '' }}
        data-adjust-toolbar=""
        className="pointer-events-auto fixed bottom-4 left-1/2 z-[131] w-[min(860px,calc(100vw-16px))] -translate-x-1/2 rounded-xl border border-border bg-surface p-2 shadow-lg"
        role="region"
        aria-label="调整工具"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="annotation">调整</Badge>
          <span
            data-adjust-status=""
            className={cn(
              'min-w-0 flex-1 truncate text-[12px]',
              notice?.tone === 'error' ? 'text-danger' : 'text-text-secondary',
            )}
          >
            {notice?.text ??
              (phase === 'freezing'
                ? '正在截取调整前画面并冻结当前视口…'
                : phase === 'released'
                  ? `已退出副本 · ${ops.length} 项改动保留；摆好真实界面后点「重新冻结」`
                  : `已冻结 · ${freeze?.stats.clonedNodes.toLocaleString('zh-CN') ?? 0} 个节点 · ${freeze?.stats.durationMs ?? 0}ms · ${ops.length} 项改动${summary.nonStandard ? ` · ${summary.nonStandard} 项非标准值` : ''}`)}
          </span>
          {dirty && <span className="text-[11px] text-warning">未导出</span>}
          <Button
            size="inline"
            variant="ghost"
            icon={<RefreshCw size={12} />}
            disabled={phase === 'freezing'}
            onClick={phase === 'released' ? refreezeCopy : releaseCopy}
            tooltip="临时退出副本操作真实界面，再重新冻结并保留已有改动"
          >
            重新冻结
          </Button>
          <Button
            size="inline"
            variant="ghost"
            icon={<Undo2 size={12} />}
            disabled={ops.length === 0 || phase !== 'ready'}
            onClick={undo}
            tooltip="撤销（Ctrl+Z）"
          >
            撤销
          </Button>
          <Button
            size="inline"
            variant="ghost"
            icon={<RefreshCw size={12} />}
            disabled={redoCount === 0 || phase !== 'ready'}
            onClick={redo}
            tooltip="重做（Ctrl+Shift+Z）"
          >
            重做
          </Button>
          <Button
            size="inline"
            variant="ghost"
            icon={<Plus size={12} />}
            disabled={phase !== 'ready'}
            onClick={() => {
              setInsertPanel((open) => !open)
              setListEditorId(null)
              setNoteTarget(null)
              setIconPicker(false)
            }}
            tooltip="从 ui/* 现有组件与变体中插入"
          >
            插入控件
          </Button>
          <Button size="inline" variant="ghost" onClick={() => void copyMarkdown()}>
            复制说明
          </Button>
          <Button
            size="inline"
            variant="primary"
            icon={<Check size={12} />}
            disabled={phase !== 'ready' || finishBusy || ops.length === 0}
            onClick={() => void finish()}
            tooltip="生成一条调整反馈条目（前后截图 + 改动清单），随后在反馈模式导出 .tfb"
          >
            {finishBusy ? '截图…' : '完成并保存'}
          </Button>
          <Button size="inline" variant="ghost" icon={<X size={12} />} onClick={onClose}>
            退出调整
          </Button>
        </div>
        <p className="mt-1 px-1 text-[11px] leading-4 text-muted">
          点击选中 · Alt+点击选父级 · Tab/Shift+Tab 切兄弟 · Enter 进子级 · 拖动换序 ·
          Alt+拖动自由移动 · 方向键微调 · Delete 删除 · Ctrl+Z 撤销。悬停才出现的按钮/菜单请先打开再进入调整，
          或点「重新冻结」临时操作真实界面；所有改动只作用于冻结副本。
        </p>
      </div>

      {phase === 'freezing' && (
        <div
          {...{ [UI_ATTR]: '' }}
          className="pointer-events-none fixed inset-x-0 top-16 z-[132] flex justify-center"
        >
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[12px] text-text-secondary shadow-md">
            <AlertTriangle size={12} className="text-annotation" /> 正在冻结当前画面…
          </span>
        </div>
      )}

      {phase === 'released' && (
        <div
          {...{ [UI_ATTR]: '' }}
          data-adjust-released=""
          className="pointer-events-auto fixed left-1/2 top-16 z-[140] -translate-x-1/2 px-2"
        >
          <div className="flex w-[min(620px,calc(100vw-24px))] flex-wrap items-center gap-2 rounded-xl border border-annotation/50 bg-surface px-3 py-2 shadow-lg">
            <span className="min-w-0 flex-1 text-[12px] leading-4 text-text">
              已退出副本：可先操作真实界面，摆好后重新冻结（改动会按选择器挂回新副本）。
            </span>
            <Button size="inline" variant="primary" icon={<RefreshCw size={12} />} onClick={refreezeCopy}>
              现在重新冻结
            </Button>
            <Button size="inline" variant="ghost" onClick={onClose}>
              退出调整
            </Button>
          </div>
        </div>
      )}
    </>,
    document.body,
  )

  function selectionBox(
    rect: FeedbackRect | null,
    handles: Element | typeof HANDLE_LIST | null,
    onHandleDown: (event: ReactPointerEvent<HTMLDivElement>, handle: (typeof HANDLE_LIST)[number]) => void,
  ) {
    if (!rect || !handles) return null
    // 元素比手柄还小时，把手柄放到外侧，避免盖住要调整的元素。
    const outset = rect.width < 28 || rect.height < 28 ? 8 : 0
    return (
      <>
        <div
          className="absolute rounded-[2px]"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            boxShadow:
              '0 0 0 2px var(--t-annotation), 0 0 0 6px color-mix(in srgb, var(--t-annotation) 18%, transparent)',
          }}
        />
        {HANDLE_LIST.map((handle) => {
          const x =
            handle.fx < 0 ? rect.x - outset : handle.fx > 0 ? rect.x + rect.width + outset : rect.x + rect.width / 2
          const y =
            handle.fy < 0 ? rect.y - outset : handle.fy > 0 ? rect.y + rect.height + outset : rect.y + rect.height / 2
          return (
            <div
              data-adjust-handle={handle.key}
              data-resize-cursor={handle.cursor}
              key={handle.key}
              aria-label={`调整 ${handle.key}`}
              className="pointer-events-auto absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
              style={{ left: x, top: y, cursor: handle.cursor }}
              onPointerDown={(event) => onHandleDown(event, handle)}
            >
              <span className="pointer-events-none size-2.5 rounded-[2px] border border-white bg-annotation shadow-sm" />
            </div>
          )
        })}
      </>
    )
  }
}
