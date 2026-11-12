/**
 * 反馈模式「调整」：冻结视口副本、元素元数据、改动清单与说明生成。
 *
 * 只在调试版使用（FeedbackMode 由 __TANDEM_DEBUG__ 惰性加载）。
 * 副本在同一文档内克隆，保留 class 与内联样式，因此不需要像截图那样逐节点
 * 内联计算样式；进入调整后应用的重渲染、WS 更新与路由都不会改动这份静态副本，
 * 退出时 stage.remove()，真实界面从未被编辑。
 */
import { cssSelectorFor, visibleTextSnippet } from '../../lib/feedbackCapture'
import type {
  AdjustAnchor,
  AdjustChange,
  AdjustFreezeStats,
  AdjustKind,
  AdjustSnapshot,
  AdjustSourceLocation,
  AdjustSummary,
  AdjustTargetMeta,
  FeedbackRect,
} from '../../lib/feedback'

export type {
  AdjustAnchor,
  AdjustChange,
  AdjustFreezeStats,
  AdjustKind,
  AdjustSnapshot,
  AdjustSourceLocation,
  AdjustSummary,
  AdjustTargetMeta,
} from '../../lib/feedback'

export type InsertKind =
  | 'button'
  | 'icon-button'
  | 'badge'
  | 'list-row'
  | 'input'
  | 'list'
  | 'menu'
  | 'card'

export interface AdjustInsertedRow {
  id: string
  component: 'ListRow' | 'Button' | 'Badge'
  title: string
  note: string
}

export interface AdjustInsertedItem {
  id: string
  kind: InsertKind
  group: string
  label: string
  variant: string
  x: number
  y: number
  /** 手动拖手柄后的尺寸；未拖过时用组件自身尺寸。 */
  width?: number
  height?: number
  behavior: string
  rows: AdjustInsertedRow[]
  container: boolean
}

export interface AdjustInsertOption {
  key: string
  group: string
  label: string
  kind: InsertKind
  variant: string
  container: boolean
}

export interface AdjustOp {
  change: AdjustChange
  undo: () => void
  redo: () => void
  structure?: { html: string; styles: Record<string, string> }
}

export interface AdjustFreeze {
  stage: HTMLDivElement
  originals: WeakMap<Element, Element>
  metas: WeakMap<Element, AdjustTargetMeta>
  stats: AdjustFreezeStats
  dispose: () => void
}

/** 结构快照里保留的关键计算样式。 */
const SNAPSHOT_STYLE_KEYS = [
  'display',
  'position',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'flex',
  'flex-direction',
  'align-items',
  'justify-content',
  'gap',
  'padding',
  'margin',
  'border',
  'border-radius',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
] as const

function shouldSkip(node: Element): boolean {
  if (
    node.matches(
      'script,style,link,meta,noscript,[data-feedback-ui],[data-toast-layer],[data-adjust-stage]',
    )
  ) {
    return true
  }
  return node.closest('[data-feedback-ui]') !== null
}

/** 把 canvas 固化成图片，避免克隆后是空白。 */
function canvasSnapshot(source: HTMLCanvasElement, copy: Element): Element {
  try {
    if (!source.width || !source.height) return copy
    const img = document.createElement('img')
    img.src = source.toDataURL()
    img.className = copy.className
    img.setAttribute('style', copy.getAttribute('style') ?? '')
    const rect = source.getBoundingClientRect()
    img.style.width = `${Math.round(rect.width)}px`
    img.style.height = `${Math.round(rect.height)}px`
    img.setAttribute('aria-hidden', 'true')
    return img
  } catch {
    return copy
  }
}

/** iframe 不能直接克隆（会重新加载页面），替换成等尺寸占位。 */
function iframePlaceholder(source: HTMLIFrameElement, copy: Element): Element {
  const holder = document.createElement('div')
  holder.className = copy.className
  holder.setAttribute('style', copy.getAttribute('style') ?? '')
  const rect = source.getBoundingClientRect()
  holder.style.width = `${Math.round(rect.width)}px`
  holder.style.height = `${Math.round(rect.height)}px`
  holder.style.display = 'flex'
  holder.style.alignItems = 'center'
  holder.style.justifyContent = 'center'
  holder.style.background = 'var(--t-bg-subtle)'
  holder.style.color = 'var(--t-text-tertiary)'
  holder.style.fontSize = '12px'
  holder.textContent = '嵌入页面（调整模式不冻结）'
  holder.setAttribute('data-adjust-iframe', '')
  return holder
}

/**
 * 克隆当前视口。stage 是 fixed 定位的静态副本：
 * - 单独 stacking context（isolation），应用里再高的 z-index 也不会盖住反馈 UI；
 * - 子节点保留 class 与内联样式，图标是内联 SVG，字体沿用当前文档；
 * - 滚动容器沿用原来的 scrollTop/scrollLeft；canvas 固化；iframe 换占位；
 * - 指针事件由上层命中层接管，副本自身不响应。
 */
export function createAdjustStage(): HTMLDivElement {
  const stage = document.createElement('div')
  stage.setAttribute('data-adjust-stage', '')
  stage.setAttribute('aria-hidden', 'true')
  stage.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:100',
    'overflow:hidden',
    'isolation:isolate',
    'background:var(--t-bg)',
    'user-select:none',
    // 命中层（z-120）在副本之上接管指针；副本自身必须保持 pointer-events:auto，
    // 否则 elementsFromPoint 会跳过整棵副本，点击/拖动找不到目标。
    'pointer-events:auto',
    'contain:paint',
  ].join(';')
  return stage
}

export function freezeAppViewport(): AdjustFreeze {
  const startedAt = performance.now()
  const sourceNodes = document.querySelectorAll('*').length
  let clonedNodes = 0
  let skipped = 0
  const scrollContainers: Array<{ source: Element; copy: Element }> = []

  const stage = createAdjustStage()

  const originals = new WeakMap<Element, Element>()
  const metas = new WeakMap<Element, AdjustTargetMeta>()

  const cloneNode = (source: Node): Node | null => {
    if (source.nodeType === Node.TEXT_NODE) {
      clonedNodes += 1
      return source.cloneNode(false)
    }
    if (!(source instanceof Element)) return source.cloneNode(false)
    if (shouldSkip(source)) {
      skipped += 1
      return null
    }
    clonedNodes += 1
    let copy: Element = source.cloneNode(false) as Element
    originals.set(copy, source)

    if (source instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
      if (source.type === 'checkbox' || source.type === 'radio') {
        copy.checked = source.checked
      } else {
        copy.value = source.value
      }
      copy.readOnly = true
      copy.tabIndex = -1
    } else if (source instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) {
      copy.value = source.value
      copy.readOnly = true
      copy.tabIndex = -1
    } else if (source instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
      copy.selectedIndex = source.selectedIndex
      copy.disabled = true
    } else if (source instanceof HTMLCanvasElement) {
      copy = canvasSnapshot(source, copy)
    } else if (source instanceof HTMLIFrameElement) {
      copy = iframePlaceholder(source, copy)
    }

    if (source.scrollTop > 0 || source.scrollLeft > 0) {
      scrollContainers.push({ source, copy })
    }
    for (const child of Array.from(source.childNodes)) {
      const cloned = cloneNode(child)
      if (cloned) copy.appendChild(cloned)
    }
    return copy
  }

  for (const child of Array.from(document.body.children)) {
    if (shouldSkip(child)) continue
    const cloned = cloneNode(child)
    if (cloned) stage.appendChild(cloned)
  }

  // 冻结动效、过渡与文本光标；表单已不可编辑。
  const frozen = document.createElement('style')
  frozen.textContent = [
    '[data-adjust-stage] *, [data-adjust-stage] *::before, [data-adjust-stage] *::after {',
    '  animation: none !important;',
    '  transition: none !important;',
    '  caret-color: transparent !important;',
    '}',
  ].join('\n')
  stage.appendChild(frozen)

  document.body.appendChild(stage)

  const restoreScroll = () => {
    for (const { source, copy } of scrollContainers) {
      try {
        copy.scrollTop = source.scrollTop
        copy.scrollLeft = source.scrollLeft
      } catch {
        /* 节点已失效 */
      }
    }
  }
  restoreScroll()
  requestAnimationFrame(restoreScroll)

  const durationMs = Math.round((performance.now() - startedAt) * 10) / 10
  return {
    stage,
    originals,
    metas,
    stats: {
      durationMs,
      sourceNodes,
      clonedNodes,
      scrollContainers: scrollContainers.length,
      skipped,
    },
    dispose: () => {
      stage.remove()
    },
  }
}

/**
 * React 19 生产运行时没有 `_debugSource`；调试版保留函数名后，
 * 开发运行时/`jsxDEV` 的 `_debugSource`/`_debugInfo`/`__source` 可能仍在，拿到就用。
 * 拿不到不伪造，清单退回 aria-label / data-testid / 标签名与锚点选择器。
 */
function reactSource(element: Element): AdjustSourceLocation | undefined {
  const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))
  if (!key) return undefined
  let fiber = (element as unknown as Record<string, unknown>)[key] as
    | {
        return?: unknown
        _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number }
        _debugInfo?: Array<{ fileName?: string; lineNumber?: number }>
        memoizedProps?: {
          __source?: { fileName?: string; lineNumber?: number; columnNumber?: number }
        }
      }
    | undefined
  for (let depth = 0; fiber && depth < 40; depth++) {
    const source: { fileName?: string; lineNumber?: number; columnNumber?: number } | undefined =
      fiber._debugSource ??
      fiber._debugInfo?.find((entry) => entry.fileName) ??
      fiber.memoizedProps?.__source
    if (source?.fileName) {
      return {
        fileName: source.fileName,
        lineNumber: typeof source.lineNumber === 'number' ? source.lineNumber : undefined,
        columnNumber: typeof source.columnNumber === 'number' ? source.columnNumber : undefined,
      }
    }
    fiber = fiber.return as typeof fiber
  }
  return undefined
}

/** 最近带 data-testid / aria-label / data-* 的祖先，作为源码拿不到时的定位锚点。 */
function anchorFor(element: Element): AdjustAnchor | undefined {
  let node: Element | null = element
  for (let depth = 0; node && depth < 12; depth++) {
    const testId = node.getAttribute('data-testid') ?? undefined
    const ariaLabel = node.getAttribute('aria-label') ?? undefined
    const dataAttrs: Record<string, string> = {}
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('data-') && attr.name !== 'data-feedback-ui') {
        dataAttrs[attr.name] = attr.value.slice(0, 80)
      }
    }
    const hasData = Object.keys(dataAttrs).length > 0
    if (testId || ariaLabel || hasData) {
      return {
        selector: cssSelectorFor(node),
        ...(testId ? { testId } : {}),
        ...(ariaLabel ? { ariaLabel } : {}),
        ...(hasData ? { dataAttrs } : {}),
      }
    }
    node = node.parentElement
  }
  return undefined
}

/**
 * 只认「这个元素本身是该组件渲染的根节点」的组件名：
 * 最近命名的祖先组件（如按钮所在 Sidebar）会被误读成要改整个 Sidebar，宁可不写。
 */
function ownComponentName(element: Element): string | undefined {
  const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))
  if (!key) return undefined
  let fiber = (element as unknown as Record<string, unknown>)[key] as
    | { type?: unknown; return?: unknown; child?: unknown }
    | undefined
  for (let depth = 0; fiber && depth < 12; depth++) {
    const node = fiber.return as typeof fiber
    if (!node) return undefined
    const type = node.type as
      | (Function & { displayName?: string })
      | { displayName?: string; render?: Function; type?: Function }
      | string
      | undefined
    const isComponent = typeof type === 'function' || (typeof type === 'object' && type !== null)
    if (isComponent) {
      let name: string | undefined
      if (typeof type === 'function') {
        name = type.displayName || type.name
      } else if (type && typeof type === 'object') {
        const render = (type as { render?: Function & { displayName?: string } }).render
        const inner = (type as { type?: Function & { displayName?: string } }).type
        name =
          (type as { displayName?: string }).displayName ||
          render?.displayName ||
          render?.name ||
          inner?.displayName ||
          inner?.name
      }
      // 该组件子树里的第一个真实 DOM 元素
      let first: unknown = node.child
      let guard = 0
      while (first && guard < 8) {
        const stateNode = (first as { stateNode?: unknown }).stateNode
        if (stateNode instanceof Element) break
        first = (first as { child?: unknown }).child
        guard += 1
      }
      const owner = (first as { stateNode?: unknown } | null)?.stateNode
      if (owner !== element) return undefined
      if (name && name !== 'Anonymous' && name !== '_default' && !/^\$?[A-Za-z]{1,2}\d*$/.test(name)) {
        return name
      }
    }
    fiber = node
  }
  return undefined
}

/** 调试版构建注入的源码位置（`data-tandem-src="packages/web/src/…:行号"`）。 */
function injectedSource(element: Element): AdjustSourceLocation | undefined {
  const node = element.closest('[data-tandem-src]')
  const value = node?.getAttribute('data-tandem-src')
  if (!value) return undefined
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(value)
  if (!match) return undefined
  return {
    fileName: match[1] ?? value,
    lineNumber: Number(match[2]),
    ...(match[3] ? { columnNumber: Number(match[3]) } : {}),
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

export function metaFor(element: Element): AdjustTargetMeta {
  // 生产构建会把组件名压成 1–2 个字符（如 $c），调试版 keepNames 后应拿到真名；
  // 仍拿到压缩名、或只是祖先组件时宁可不写，清单退回标签名 + 锚点。
  const component = ownComponentName(element)
  return {
    selector: cssSelectorFor(element),
    component,
    tag: element.tagName.toLowerCase(),
    classes: Array.from(element.classList).slice(0, 6),
    textSnippet: visibleTextSnippet(element),
    ariaLabel: element.closest('[aria-label]')?.getAttribute('aria-label') ?? undefined,
    testId: element.closest('[data-testid]')?.getAttribute('data-testid') ?? undefined,
    anchor: anchorFor(element),
    source: injectedSource(element) ?? reactSource(element),
    rect: rectOf(element),
  }
}

export function metaForClone(freeze: AdjustFreeze, clone: Element | null): AdjustTargetMeta | null {
  if (!clone) return null
  const cached = freeze.metas.get(clone)
  if (cached) return cached
  const original = freeze.originals.get(clone)
  // 从快照恢复的副本没有「原元素」映射；直接从副本自己读 class/aria/data-tandem-src。
  const meta = original ? metaFor(original) : metaFor(clone)
  if (meta) freeze.metas.set(clone, meta)
  return meta
}

/** 选中元素上的图标：自身是 svg、或最近的 svg 祖先、或第一个 svg 子节点。 */
export function iconSvgFor(element: Element | null): SVGSVGElement | null {
  if (!element) return null
  if (element instanceof SVGSVGElement) return element
  const inside = element.closest('svg')
  if (inside instanceof SVGSVGElement) return inside
  const child = element.querySelector('svg')
  return child instanceof SVGSVGElement ? child : null
}

export function lucideIconName(svg: SVGSVGElement | null | Element): string | undefined {
  if (!svg) return undefined
  for (const name of Array.from(svg.classList)) {
    if (name.startsWith('lucide-')) return name.slice('lucide-'.length)
  }
  return undefined
}

export function styleSnapshot(element: Element): Record<string, string> {
  const style = getComputedStyle(element)
  const out: Record<string, string> = {}
  for (const key of SNAPSHOT_STYLE_KEYS) out[key] = style.getPropertyValue(key)
  return out
}

export function newAdjustId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 既有控件尺寸档位（高）：Button inline 24 / Input sm 28 / Button md 32 / Button lg 36 / 触控 44。 */
export const HEIGHT_TOKENS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 24, label: 'Button inline 24' },
  { value: 28, label: 'Input sm / ListRow sm 28' },
  { value: 32, label: 'Button md / ListRow md 32' },
  { value: 36, label: 'Button lg / Input lg 36' },
  { value: 44, label: '触控目标 44' },
]

/** 宽度只吸附到 4px 栅格；命中组件宽度档位时再标名字。 */
export const WIDTH_TOKENS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 24, label: 'IconButton inline 24' },
  { value: 32, label: 'IconButton 32' },
  { value: 44, label: '触控目标 44' },
]

export const SNAP_TOLERANCE = 2

export interface SizeSnap {
  width: number
  height: number
  tokens: { width?: string; height?: string }
  standardWidth: boolean
  standardHeight: boolean
  standard: boolean
}

function nearestToken(
  value: number,
  tokens: ReadonlyArray<{ value: number; label: string }>,
  tolerance: number,
): { value: number; label: string } | null {
  let best: { value: number; label: string } | null = null
  let distance = Infinity
  for (const token of tokens) {
    const delta = Math.abs(token.value - value)
    if (delta <= tolerance && delta < distance) {
      best = token
      distance = delta
    }
  }
  return best
}

/** 拖动时吸附：高度优先贴控件档位（±2px），宽度贴 4px 栅格；其余保留自由值。 */
export function snapSize(width: number, height: number): SizeSnap {
  const rawWidth = Math.max(8, Math.round(width))
  const rawHeight = Math.max(8, Math.round(height))
  const heightToken = nearestToken(rawHeight, HEIGHT_TOKENS, SNAP_TOLERANCE)
  const widthToken = nearestToken(rawWidth, WIDTH_TOKENS, SNAP_TOLERANCE)
  const snappedHeight = heightToken?.value ?? rawHeight
  const widthStep = Math.round(rawWidth / 4) * 4
  const snappedWidth =
    widthToken?.value ?? (Math.abs(widthStep - rawWidth) <= SNAP_TOLERANCE ? widthStep : rawWidth)
  const standardWidth = !!widthToken || snappedWidth % 4 === 0
  const standardHeight = !!heightToken || snappedHeight % 4 === 0
  return {
    width: snappedWidth,
    height: snappedHeight,
    tokens: {
      ...(widthToken
        ? { width: widthToken.label }
        : snappedWidth % 4 === 0
          ? { width: '4px 栅格' }
          : {}),
      ...(heightToken
        ? { height: heightToken.label }
        : snappedHeight % 4 === 0
          ? { height: '4px 栅格' }
          : {}),
    },
    standardWidth,
    standardHeight,
    standard: standardWidth && standardHeight,
  }
}

/** 选中元素当前尺寸落在哪个 token 上（用于面板展示）。 */
export function describeSize(width: number, height: number): { label: string; standard: boolean } {
  const roundedWidth = Math.round(width)
  const roundedHeight = Math.round(height)
  const heightToken = HEIGHT_TOKENS.find((token) => token.value === roundedHeight)
  const widthToken = WIDTH_TOKENS.find((token) => token.value === roundedWidth)
  const standardWidth = !!widthToken || roundedWidth % 4 === 0
  const standardHeight = !!heightToken || roundedHeight % 4 === 0
  if (!standardWidth && !standardHeight) return { label: '非标准值', standard: false }
  const parts: string[] = []
  parts.push(widthToken?.label ?? (standardWidth ? '宽 4px 栅格' : '宽非标准'))
  parts.push(heightToken?.label ?? (standardHeight ? '高 4px 栅格' : '高非标准'))
  return { label: parts.join(' · '), standard: standardWidth && standardHeight }
}

const KIND_LABEL: Record<AdjustKind, string> = {
  resize: '改尺寸',
  icon: '换图标',
  variant: '换变体',
  delete: '删除',
  move: '移动',
  text: '改文字',
  hide: '隐藏',
  insert: '插入控件',
  reorder: '换序',
  note: '行为备注',
}

export function adjustKindLabel(kind: AdjustKind): string {
  return KIND_LABEL[kind] ?? kind
}

/** 插入控件白名单：只列 ui/* 现有导出与变体。 */
export const INSERT_OPTIONS: ReadonlyArray<AdjustInsertOption> = [
  { key: 'button-primary', group: 'Button', label: '主要按钮', kind: 'button', variant: 'primary', container: false },
  { key: 'button-secondary', group: 'Button', label: '次要按钮', kind: 'button', variant: 'secondary', container: false },
  { key: 'button-accent', group: 'Button', label: '强调按钮', kind: 'button', variant: 'accent', container: false },
  { key: 'button-ghost', group: 'Button', label: '幽灵按钮', kind: 'button', variant: 'ghost', container: false },
  { key: 'button-danger', group: 'Button', label: '危险文字按钮', kind: 'button', variant: 'danger-ghost', container: false },
  { key: 'icon-ghost', group: 'IconButton', label: '图标按钮', kind: 'icon-button', variant: 'ghost', container: false },
  { key: 'icon-secondary', group: 'IconButton', label: '描边图标按钮', kind: 'icon-button', variant: 'secondary', container: false },
  { key: 'badge-neutral', group: 'Badge', label: '中性徽标', kind: 'badge', variant: 'neutral', container: false },
  { key: 'badge-success', group: 'Badge', label: '成功徽标', kind: 'badge', variant: 'success', container: false },
  { key: 'badge-warn', group: 'Badge', label: '警告徽标', kind: 'badge', variant: 'warn', container: false },
  { key: 'badge-danger', group: 'Badge', label: '错误徽标', kind: 'badge', variant: 'danger', container: false },
  { key: 'badge-annotation', group: 'Badge', label: '标注徽标', kind: 'badge', variant: 'annotation', container: false },
  { key: 'list-row', group: 'ListRow', label: '列表行', kind: 'list-row', variant: 'md', container: false },
  { key: 'input', group: 'Input', label: '输入框', kind: 'input', variant: 'md', container: false },
  { key: 'card', group: 'Card', label: '卡片', kind: 'card', variant: 'default', container: true },
  { key: 'list', group: '组合控件', label: '列表（Card + ListRow）', kind: 'list', variant: '组合', container: true },
  { key: 'menu', group: '组合控件', label: '菜单（示意，按 ui/Menu 实现）', kind: 'menu', variant: '组合', container: true },
]

export const INSERT_GROUPS = ['Button', 'IconButton', 'Badge', 'ListRow', 'Input', 'Card', '组合控件'] as const

function oneLine(value: unknown): string {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
}

function targetLine(meta: AdjustTargetMeta): string {
  const bits = [meta.component ? `\`${meta.component}\`` : `\`${meta.tag}\``]
  bits.push(`选择器 \`${meta.selector.replace(/`/g, "'")}\``)
  if (meta.ariaLabel) bits.push(`aria-label=${meta.ariaLabel}`)
  if (meta.testId) bits.push(`data-testid=${meta.testId}`)
  return bits.join('；')
}

function anchorLine(meta: AdjustTargetMeta): string | null {
  const anchor = meta.anchor
  if (!anchor) return null
  if (anchor.selector === meta.selector && !anchor.testId && !anchor.dataAttrs) return null
  const bits: string[] = [`定位锚点 \`${anchor.selector.replace(/`/g, "'")}\``]
  if (anchor.testId) bits.push(`data-testid=${anchor.testId}`)
  if (anchor.ariaLabel) bits.push(`aria-label=${anchor.ariaLabel}`)
  if (anchor.dataAttrs) {
    const attrs = Object.entries(anchor.dataAttrs)
      .slice(0, 3)
      .map(([key, value]) => `${key}=${value || '（空）'}`)
    if (attrs.length) bits.push(attrs.join('、'))
  }
  return bits.join('；')
}

function sourceLine(meta: AdjustTargetMeta): string | null {
  if (!meta.source) return null
  const file = meta.source.fileName.replace(/^.*?packages\//, 'packages/')
  return `源码：\`${file}${meta.source.lineNumber ? `:${meta.source.lineNumber}` : ''}\`（调试版构建注入的源码位置）`
}

function iconMarkdownName(name: string | undefined): string {
  return name ? `\`${name}\`` : '未知'
}

/** 每条改动给 agent 的一句可执行说明。 */
export function adjustInstruction(change: AdjustChange): string {
  const target = targetLine(change.target)
  if (change.kind === 'resize') {
    const before = change.before as { width?: number; height?: number } | undefined
    const after = change.after as { width?: number; height?: number } | undefined
    const parts: string[] = []
    if (before?.width !== undefined && after?.width !== undefined && before.width !== after.width) {
      parts.push(`宽度 ${before.width}→${after.width}`)
    }
    if (
      before?.height !== undefined &&
      after?.height !== undefined &&
      before.height !== after.height
    ) {
      parts.push(`高度 ${before.height}→${after.height}`)
    }
    return `把 ${target} 的${parts.join('、') || '尺寸'}。`
  }
  if (change.kind === 'icon') {
    const before = change.before as { icon?: string } | undefined
    const after = change.after as { icon?: string } | undefined
    return `把 ${target} 的图标从 ${iconMarkdownName(before?.icon)} 换成 ${iconMarkdownName(after?.icon)}（lucide）。`
  }
  if (change.kind === 'delete') {
    return `删除 ${target}（连同子树）。`
  }
  if (change.kind === 'hide') {
    return `隐藏 ${target}，但保留布局占位。`
  }
  if (change.kind === 'move') {
    const after = change.after as { offsetX?: number; offsetY?: number } | undefined
    return `把 ${target} 移动 translate(${after?.offsetX ?? 0}px, ${after?.offsetY ?? 0}px)；实现时优先按布局语义（间距/对齐）落位。`
  }
  if (change.kind === 'reorder') {
    const after = change.after as { index?: number; afterLabel?: string } | undefined
    const index = typeof after?.index === 'number' ? after.index : 0
    const sibling = after?.afterLabel ? `（在「${oneLine(after.afterLabel)}」之后）` : ''
    return `把 ${target} 在同一容器内换序到第 ${index + 1} 个位置${sibling}。`
  }
  if (change.kind === 'text') {
    const before = change.before as { text?: string } | undefined
    const after = change.after as { text?: string } | undefined
    return `把 ${target} 的文字「${oneLine(before?.text)}」改成「${oneLine(after?.text)}」。`
  }
  if (change.kind === 'note') {
    return `给 ${target} 补行为备注：${oneLine(change.behavior) || '（空）'}`
  }
  if (change.kind === 'insert') {
    const after = change.after as
      | { component?: string; variant?: string; position?: { x?: number; y?: number } }
      | undefined
    const position = after?.position
    const where = position ? `（视口坐标 x=${position.x ?? 0}, y=${position.y ?? 0}，按布局语义落位）` : ''
    return `插入 ${after?.component ?? '控件'}${after?.variant ? `（${after.variant}）` : ''}${where}；只用 ui/* 现有组件与变体。`
  }
  return `${adjustKindLabel(change.kind)}：${target}。`
}

/** 单条改动的说明块（Markdown 缩进即为列表子项）。 */
function changeBlock(change: AdjustChange, index: number): string[] {
  const lines: string[] = [`${index + 1}. **${adjustKindLabel(change.kind)}**：${adjustInstruction(change)}`]
  const anchor = anchorLine(change.target)
  if (anchor) lines.push(`   - ${anchor}`)
  const source = sourceLine(change.target)
  if (source) lines.push(`   - ${source}`)
  if (change.kind !== 'resize') {
    if (change.before) lines.push(`   - 改前：\`${JSON.stringify(change.before)}\``)
    if (change.after) lines.push(`   - 改后：\`${JSON.stringify(change.after)}\``)
  }
  if (change.tokens) {
    const tokenText = [change.tokens.width, change.tokens.height].filter(Boolean).join('、')
    lines.push(`   - 尺寸 token：${tokenText || '自由值'}`)
  }
  if (change.standard === false) {
    lines.push(
      `   - **非标准值**：未命中 ui 尺寸档位，实现时就近取最近档位并保持现有间距。`,
    )
  }
  if (change.stale) {
    lines.push(`   - **恢复副本后未挂上**：目标选择器在恢复的副本里已失效，实现时按目标描述与截图重新定位。`)
  }
  if (change.note) lines.push(`   - 说明：${oneLine(change.note)}`)
  const after = change.after as
    | {
        rows?: Array<{ component?: string; title?: string; note?: string }>
        note?: string
        component?: string
      }
    | undefined
  if (change.kind === 'insert' && after) {
    if (after.note) lines.push(`   - 容器备注：${oneLine(after.note)}`)
    if (after.rows?.length) {
      lines.push('   - 示意内容（草稿，实现时按 ui/* 复刻）：')
      after.rows.forEach((row, rowIndex) => {
        lines.push(
          `     ${rowIndex + 1}. ${row.component ?? 'ListRow'}：${oneLine(row.title) || '（未命名）'}${
            row.note ? ` — 备注：${oneLine(row.note)}` : ''
          }`,
        )
      })
    }
  }
  if (change.behavior && !(change.kind === 'insert' && after?.note === change.behavior)) {
    lines.push(`   - 行为备注：${oneLine(change.behavior)}`)
  }
  return lines
}

export function adjustMarkdown(snapshot: Omit<AdjustSnapshot, 'markdown'>): string {
  const nonStandard = snapshot.changes.filter((change) => change.standard === false).length
  const tokens = new Set<string>()
  for (const change of snapshot.changes) {
    if (change.tokens?.width) tokens.add(change.tokens.width)
    if (change.tokens?.height) tokens.add(change.tokens.height)
  }
  const lines: string[] = [
    `# 调整 · ${oneLine(snapshot.title) || 'UI 调整'}`,
    '',
    `- 路由：\`${snapshot.route}\``,
    `- 主题：${snapshot.theme === 'dark' ? '深色' : '浅色'} · 视口 ${snapshot.viewport.width}×${snapshot.viewport.height} @${snapshot.viewport.dpr}x`,
    `- 冻结：克隆 ${snapshot.freeze.clonedNodes.toLocaleString('zh-CN')} 个节点，耗时 ${snapshot.freeze.durationMs}ms（源 ${snapshot.freeze.sourceNodes.toLocaleString('zh-CN')} 个元素）`,
    `- 改动：${snapshot.changes.length} 项${nonStandard ? `（${nonStandard} 项非标准值）` : ''}`,
    '',
    '## 按顺序实现',
    '',
  ]
  snapshot.changes.forEach((change, index) => {
    lines.push(...changeBlock(change, index), '')
  })
  if (snapshot.changes.length === 0) lines.push('（没有改动）', '')
  lines.push(
    '实现注意：只用 `packages/web/src/components/ui/*` 现有组件与变体；图标只从项目在用的 lucide 集中选；尺寸优先取组件既有档位；不要直接复制「调整.json」或截图里的 HTML。',
    '',
  )
  return lines.join('\n')
}

export function adjustTitle(changes: AdjustChange[]): string {
  if (changes.length === 0) return 'UI 调整（未改动）'
  const first = changes[0]
  const name = first.target.component ?? first.target.ariaLabel ?? first.target.tag
  return `${name} 等 ${changes.length} 处 UI 调整`
}

export function buildAdjustSnapshot(input: {
  id: string
  title?: string
  route: string
  theme: 'light' | 'dark'
  viewport: { width: number; height: number; dpr: number }
  freeze: AdjustFreezeStats
  changes: AdjustChange[]
  structure: AdjustSnapshot['structure']
  copy?: AdjustSnapshot['copy']
}): AdjustSnapshot {
  const title = input.title ?? adjustTitle(input.changes)
  const base = {
    version: 1 as const,
    kind: 'adjust' as const,
    id: input.id,
    title,
    route: input.route,
    theme: input.theme,
    viewport: input.viewport,
    createdAt: Date.now(),
    freeze: input.freeze,
    changes: input.changes,
    structure: input.structure,
    ...(input.copy ? { copy: input.copy } : {}),
  }
  return { ...base, markdown: adjustMarkdown(base) }
}

export function summarizeAdjust(snapshot: AdjustSnapshot): AdjustSummary {
  const tokens = new Set<string>()
  for (const change of snapshot.changes) {
    if (change.tokens?.width) tokens.add(change.tokens.width)
    if (change.tokens?.height) tokens.add(change.tokens.height)
  }
  return {
    changeCount: snapshot.changes.length,
    freezeMs: snapshot.freeze.durationMs,
    tokens: [...tokens],
    nonStandard: snapshot.changes.filter((change) => change.standard === false).length,
    sourceAvailable: snapshot.changes.some((change) => !!change.target.source),
  }
}
