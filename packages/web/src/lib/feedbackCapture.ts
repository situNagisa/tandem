/** 反馈模式的圈选辅助：CSS 选择器、React 组件名、文本与截图。 */
import { domToCanvas } from 'modern-screenshot'
import type { FeedbackRect } from './feedback'
import { elementsAtPoint } from './overlay'
import { feedbackShotPerf, shotPerfAdd, shotPerfEnd, shotPerfStart, type FeedbackShotPerf } from './feedbackPerf'

const UI_ATTR = 'data-feedback-ui'
const MAX_IMAGE_WIDTH = 1600
/** 截图四周留白（CSS px）。 */
const SHOT_PADDING = 16
/** 视口外的行前后多留一点，避免把「差几像素就要露出」的内容剪掉。 */
const PRUNE_MARGIN = 24

/**
 * 只内联这些视觉样式。modern-screenshot 默认会把每个元素约 350 个计算样式全部写进克隆，
 * 长会话里就是 300 万次 setProperty + 几十 MB 的 SVG（实测单次整页截图 10s+）。
 * 白名单外的属性（光标、动画、无障碍等）对截图没有视觉影响。
 */
const STYLE_PROPERTIES = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'float',
  'clear',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'overflow',
  'overflow-x',
  'overflow-y',
  'flex',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'flex-direction',
  'flex-wrap',
  'align-items',
  'align-self',
  'align-content',
  'justify-content',
  'justify-items',
  'justify-self',
  'place-items',
  'place-content',
  'gap',
  'row-gap',
  'column-gap',
  'order',
  'grid-template-columns',
  'grid-template-rows',
  'grid-auto-flow',
  'grid-column',
  'grid-row',
  'grid-column-start',
  'grid-column-end',
  'grid-row-start',
  'grid-row-end',
  'aspect-ratio',
  'object-fit',
  'object-position',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-feature-settings',
  'font-stretch',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-transform',
  'text-decoration-line',
  'text-decoration-color',
  'text-decoration-style',
  'text-decoration-thickness',
  'text-underline-offset',
  'text-indent',
  'text-overflow',
  'text-shadow',
  'text-wrap',
  'white-space',
  'word-break',
  'overflow-wrap',
  'hyphens',
  'line-break',
  'text-align-last',
  'text-rendering',
  'font-kerning',
  'font-optical-sizing',
  'font-synthesis',
  '-webkit-font-smoothing',
  '-webkit-text-size-adjust',
  'tab-size',
  'vertical-align',
  'direction',
  'unicode-bidi',
  'color',
  'background',
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-position-x',
  'background-position-y',
  'background-repeat',
  'background-clip',
  'background-origin',
  'background-attachment',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-right-width',
  'border-right-style',
  'border-right-color',
  'border-bottom-width',
  'border-bottom-style',
  'border-bottom-color',
  'border-left-width',
  'border-left-style',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'outline-color',
  'outline-style',
  'outline-width',
  'outline-offset',
  'box-shadow',
  'opacity',
  'visibility',
  'mix-blend-mode',
  'filter',
  'backdrop-filter',
  'clip-path',
  'transform',
  'transform-origin',
  'mask-image',
  'mask-size',
  'mask-position',
  'mask-repeat',
  '-webkit-mask-image',
  '-webkit-mask-size',
  '-webkit-mask-position',
  '-webkit-mask-repeat',
  'list-style-type',
  'list-style-position',
  'list-style-image',
  'border-collapse',
  'border-spacing',
  'table-layout',
  'caption-side',
  'empty-cells',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'paint-order',
  'scrollbar-width',
  'scrollbar-color',
  'content',
  'quotes',
  'counter-reset',
  'counter-increment',
  'contain-intrinsic-size',
]

function isUiNode(node: Node): boolean {
  return node instanceof Element && node.closest(`[${UI_ATTR}]`) !== null
}

export function cssSelectorFor(element: Element): string {
  if (element === document.documentElement) return 'html'
  if (element === document.body) return 'body'
  const uniqueId = element.id
  if (uniqueId) {
    const idSelector = `#${CSS.escape(uniqueId)}`
    try {
      if (document.querySelectorAll(idSelector).length === 1) return idSelector
    } catch {
      /* 继续走路径 */
    }
  }

  const parts: string[] = []
  let node: Element | null = element
  while (node && node !== document.documentElement && parts.length < 8) {
    let part = node.tagName.toLowerCase()
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`)
      break
    }
    const classes = Array.from(node.classList)
      .filter((name) => !name.startsWith('data-') && !/^css-/.test(name))
      .slice(0, 2)
    if (classes.length) part += `.${classes.map((name) => CSS.escape(name)).join('.')}`
    const parent: Element | null = node.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === node!.tagName)
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
    }
    parts.unshift(part)
    if (node === document.body) break
    node = parent
  }
  return parts.join(' > ')
}

/** 从元素上的 __reactFiber$ 键向上找最近的有名字组件。 */
export function reactComponentName(element: Element): string | undefined {
  const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))
  if (!key) return undefined
  let fiber = (element as unknown as Record<string, unknown>)[key] as
    | { type?: unknown; return?: unknown }
    | undefined
  for (let depth = 0; fiber && depth < 40; depth++) {
    const type = fiber.type as
      | (Function & { displayName?: string })
      | { displayName?: string; render?: Function; type?: Function }
      | string
      | undefined
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
    if (name && name !== 'Anonymous' && name !== '_default') return name
    fiber = fiber.return as typeof fiber
  }
  return undefined
}

export function visibleTextSnippet(element: Element): string {
  const tag = element.tagName.toLowerCase()
  if (tag === 'script' || tag === 'style') return ''
  const raw =
    (element as HTMLElement).innerText ||
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    element.textContent ||
    ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function rectFor(element: Element): FeedbackRect {
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

interface PrunePlan {
  skip: Set<Element>
  nodes: number
  pruned: number
}

/** 矩形的交集（viewport 坐标）。 */
function intersect(a: { left: number; top: number; right: number; bottom: number }, b: DOMRect): {
  left: number
  top: number
  right: number
  bottom: number
} {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
}

function viewportBox(): { left: number; top: number; right: number; bottom: number } {
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
}

function isScrollContainer(element: Element): boolean {
  if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) {
    return false
  }
  const style = getComputedStyle(element)
  const vertical = /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
  const horizontal = /(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1
  return vertical || horizontal
}

/**
 * 长会话里 DOM 大部分是滚动容器视口外的行（`content-visibility:auto` 本来就不绘制）。
 * 克隆时跳过这些子树：它们对最终图片没有任何像素贡献，却要逐个计算样式、内联、序列化。
 * 去掉上方行后滚动容器从可见内容开始渲染，截图也更贴近用户当前看到的画面。
 */
function planShotPrune(root: Element, clip: { left: number; top: number; right: number; bottom: number }): PrunePlan {
  const plan: PrunePlan = { skip: new Set(), nodes: 0, pruned: 0 }
  const scrollers: Element[] = []
  const all = root.querySelectorAll('*')
  plan.nodes = all.length
  if (isScrollContainer(root)) scrollers.push(root)
  for (const element of all) {
    if (element.closest(`[${UI_ATTR}]`)) continue
    if (isScrollContainer(element)) scrollers.push(element)
  }
  if (scrollers.length === 0) return plan

  for (const scroller of scrollers) {
    const box = intersect(clip, scroller.getBoundingClientRect())
    if (box.right - box.left <= 1 || box.bottom - box.top <= 1) continue
    const visit = (parent: Element) => {
      for (const child of Array.from(parent.children)) {
        if (plan.skip.has(child)) continue
        if (child.closest(`[${UI_ATTR}]`)) continue
        const rect = child.getBoundingClientRect()
        const outside =
          rect.bottom <= box.top - PRUNE_MARGIN ||
          rect.top >= box.bottom + PRUNE_MARGIN ||
          rect.right <= box.left - PRUNE_MARGIN ||
          rect.left >= box.right + PRUNE_MARGIN
        if (outside) {
          // fixed/absolute 可能画到滚动容器裁剪区之外，保守起见不跳过。
          const position = getComputedStyle(child).position
          if (position === 'fixed' || position === 'absolute' || position === 'sticky') continue
          plan.skip.add(child)
          plan.pruned += 1 + child.querySelectorAll('*').length
          continue
        }
        visit(child)
      }
    }
    visit(scroller)
  }
  return plan
}

interface CaptureProbe {
  record: FeedbackShotPerf | null
  startedAt: number
  cloneEndedAt: number
}

/** 让 modern-screenshot 只做视觉相关的样式内联，并告诉我们各阶段耗时。 */
function shotOptions(
  probe: CaptureProbe,
  prune: PrunePlan,
  options: { scale: number; background: string | null },
) {
  return {
    scale: options.scale,
    backgroundColor: options.background,
    includeStyleProperties: STYLE_PROPERTIES,
    timeout: 12_000,
    filter: (node: Node) => !isUiNode(node) && !(node instanceof Element && prune.skip.has(node)),
    onCloneNode: (cloned: Node) => {
      // 克隆 + 计算样式 + 样式内联已结束。
      probe.cloneEndedAt = performance.now()
      shotPerfAdd('cloneMs', probe.cloneEndedAt - probe.startedAt)
      if (cloned instanceof Element && probe.record) {
        probe.record.nodes = countCloned(cloned)
      }
    },
    onEmbedNode: () => {
      shotPerfAdd('embedMs', performance.now() - (probe.cloneEndedAt || probe.startedAt))
    },
  }
}

function countCloned(node: Element): number {
  return node.querySelectorAll('*').length
}

/** 桌面调试版：主进程原生截图，绕过 DOM 克隆。 */
function nativeCapture(): ((rect: { x: number; y: number; width: number; height: number }) => Promise<string | null>) | null {
  const api = window.tandemDesktop?.feedback
  if (!api?.capturePage) return null
  return async (rect) => {
    try {
      const result = await api.capturePage(rect)
      return result?.ok && result.dataURL ? result.dataURL : null
    } catch {
      return null
    }
  }
}

/** 原生截图按设备像素返回，按最长边缩到上限，存储与标注都更轻。 */
async function shrinkShot(dataURL: string, maxEdge: number): Promise<string | null> {
  const img = await loadImage(dataURL)
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight, 1))
  if (scale >= 1) return dataURL
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataURL
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
}

async function canvasToShot(canvas: HTMLCanvasElement, probe: CaptureProbe): Promise<string> {
  const startedAt = performance.now()
  const dataURL = canvas.toDataURL('image/png')
  shotPerfAdd('encodeMs', performance.now() - startedAt)
  if (probe.record) probe.record.bytes = Math.round((dataURL.length * 3) / 4)
  return dataURL
}

function backgroundFor(element: Element | null): string {
  const parentBg = element?.parentElement
    ? getComputedStyle(element.parentElement).backgroundColor
    : ''
  const pageBg = getComputedStyle(document.body).backgroundColor
  const themeBg = getComputedStyle(document.documentElement).getPropertyValue('--t-bg').trim()
  return parentBg && parentBg !== 'rgba(0, 0, 0, 0)'
    ? parentBg
    : pageBg && pageBg !== 'rgba(0, 0, 0, 0)'
      ? pageBg
      : themeBg || '#ffffff'
}

/** 最大边长限制：宽图缩到 MAX_IMAGE_WIDTH，避免 PNG 过大。 */
function limitWidth(canvas: HTMLCanvasElement): HTMLCanvasElement {
  if (canvas.width <= MAX_IMAGE_WIDTH) return canvas
  const scale = MAX_IMAGE_WIDTH / canvas.width
  const out = document.createElement('canvas')
  out.width = MAX_IMAGE_WIDTH
  out.height = Math.max(1, Math.round(canvas.height * scale))
  const ctx = out.getContext('2d')
  if (!ctx) return canvas
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, out.width, out.height)
  return out
}

/** 用元素自身截图并在四周补 16px 背景，接近“元素及周围一圈”的效果。 */
export async function captureElementShot(element: Element): Promise<string | null> {
  const startedAt = performance.now()
  const probe: CaptureProbe = { record: null, startedAt, cloneEndedAt: 0 }
  try {
    const box = element.getBoundingClientRect()
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const clip = intersect(viewportBox(), box)
    const background = backgroundFor(element)

    const native = nativeCapture()
    if (native) {
      const pad = SHOT_PADDING
      const rect = {
        x: Math.max(0, Math.floor(box.left - pad)),
        y: Math.max(0, Math.floor(box.top - pad)),
        width: Math.max(1, Math.ceil(Math.min(box.width + pad * 2, window.innerWidth))),
        height: Math.max(1, Math.ceil(Math.min(box.height + pad * 2, window.innerHeight))),
      }
      const shot = await native(rect)
      if (shot) {
        const record = shotPerfStart('element', { native: true })
        const final = (await shrinkShot(shot, MAX_IMAGE_WIDTH)) ?? shot
        shotPerfEnd(record, performance.now() - startedAt, await imageSize(final))
        return final
      }
    }

    const record = shotPerfStart('element')
    probe.record = record
    const prune = planShotPrune(element, clip)
    if (record) record.pruned = prune.pruned
    // 剪枝规划本身不算进克隆/内联样式阶段。
    probe.startedAt = performance.now()

    // 根节点自身的 translate（如右侧 -translate-y-1/2）会让离屏克隆错位裁切，截图期间去掉。
    const html = element as HTMLElement
    const inlineTransform = html.style.transform
    const inlineTranslate = html.style.translate
    if (getComputedStyle(html).transform !== 'none') html.style.transform = 'none'
    if (getComputedStyle(html).translate !== 'none') html.style.translate = 'none'
    let canvas: HTMLCanvasElement
    try {
      canvas = await domToCanvas(html, shotOptions(probe, prune, { scale, background: null }))
    } finally {
      html.style.transform = inlineTransform
      html.style.translate = inlineTranslate
    }
    if (probe.record) {
      const canvasAt = performance.now()
      shotPerfAdd('drawMs', Math.max(0, canvasAt - probe.cloneEndedAt - probe.record.embedMs))
    }

    // 原图四周补 16px 背景（保持原来的视觉留白）。
    const pad = Math.round(SHOT_PADDING * scale)
    const width = Math.max(1, canvas.width + pad * 2)
    const height = Math.max(1, canvas.height + pad * 2)
    const padded = document.createElement('canvas')
    padded.width = width
    padded.height = height
    const ctx = padded.getContext('2d')
    if (!ctx) {
      const dataURL = await canvasToShot(canvas, probe)
      shotPerfEnd(record, performance.now() - startedAt, { width: canvas.width, height: canvas.height })
      return dataURL
    }
    ctx.fillStyle = background
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(canvas, pad, pad)
    const final = limitWidth(padded)
    const dataURL = await canvasToShot(final, probe)
    shotPerfEnd(record, performance.now() - startedAt, { width: final.width, height: final.height })
    return dataURL
  } catch {
    shotPerfEnd(probe.record, performance.now() - startedAt)
    return null
  }
}

/** 找出完全包含区域的最深元素，克隆它而不是整个 body。 */
function regionRoot(rect: FeedbackRect): Element {
  const points: Array<[number, number]> = [
    [rect.x + rect.width / 2, rect.y + rect.height / 2],
    [rect.x + 2, rect.y + 2],
    [rect.x + rect.width - 2, rect.y + 2],
    [rect.x + 2, rect.y + rect.height - 2],
    [rect.x + rect.width - 2, rect.y + rect.height - 2],
  ]
  const hits = points
    .map(([x, y]) => {
      try {
        return elementsAtPoint(x, y).find((element) => !isUiNode(element) && element !== document.documentElement) ?? null
      } catch {
        return null
      }
    })
    .filter((element): element is Element => !!element)
  if (hits.length === 0) return document.body
  let root: Element | null = hits[0]
  while (root && root !== document.body) {
    const box = root.getBoundingClientRect()
    const containsAll = hits.every((hit) => root!.contains(hit))
    const coversRect =
      box.left <= rect.x + 1 &&
      box.top <= rect.y + 1 &&
      box.right >= rect.x + rect.width - 1 &&
      box.bottom >= rect.y + rect.height - 1
    if (containsAll && coversRect) break
    root = root.parentElement
  }
  if (!root || root === document.documentElement) return document.body
  // 区域被滚动容器裁剪：克隆滚动容器本身，否则视口外的行会一起渲染（慢且内容错位）。
  let scroller: Element | null = root
  while (scroller && scroller !== document.body) {
    if (isScrollContainer(scroller)) return scroller
    scroller = scroller.parentElement
  }
  return root
}

/** 框选区域截图：只克隆与区域相交的最深容器，视口外的行跳过。 */
export async function captureRegionShot(rect: FeedbackRect): Promise<string | null> {
  const startedAt = performance.now()
  const probe: CaptureProbe = { record: null, startedAt, cloneEndedAt: 0 }
  try {
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const background = getComputedStyle(document.body).backgroundColor || '#ffffff'
    const native = nativeCapture()
    if (native) {
      const shot = await native({
        x: Math.max(0, Math.floor(rect.x)),
        y: Math.max(0, Math.floor(rect.y)),
        width: Math.max(1, Math.ceil(Math.min(rect.width, window.innerWidth - rect.x))),
        height: Math.max(1, Math.ceil(Math.min(rect.height, window.innerHeight - rect.y))),
      })
      if (shot) {
        const record = shotPerfStart('region', { native: true })
        const final = (await shrinkShot(shot, MAX_IMAGE_WIDTH)) ?? shot
        shotPerfEnd(record, performance.now() - startedAt, await imageSize(final))
        return final
      }
    }

    const record = shotPerfStart('region')
    probe.record = record
    const root = regionRoot(rect)
    const rootBox = root.getBoundingClientRect()
    const clip = intersect(viewportBox(), rootBox)
    const prune = planShotPrune(root, clip)
    if (record) record.pruned = prune.pruned
    probe.startedAt = performance.now()
    const scaleX = scale
    const canvas = await domToCanvas(root, shotOptions(probe, prune, { scale, background }))
    if (record) {
      const canvasAt = performance.now()
      shotPerfAdd('drawMs', Math.max(0, canvasAt - probe.cloneEndedAt - record.embedMs))
    }

    // 克隆以 root 的 border-box 左上角为原点；区域坐标换成 root 内的偏移。
    const sx = Math.max(0, (rect.x - rootBox.left) * scaleX)
    const sy = Math.max(0, (rect.y - rootBox.top) * scaleX)
    const sw = Math.max(1, Math.min(canvas.width - sx, rect.width * scaleX))
    const sh = Math.max(1, Math.min(canvas.height - sy, rect.height * scaleX))
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(sw))
    out.height = Math.max(1, Math.round(sh))
    const ctx = out.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height)
    const final = limitWidth(out)
    const dataURL = await canvasToShot(final, probe)
    shotPerfEnd(record, performance.now() - startedAt, { width: final.width, height: final.height })
    return dataURL
  } catch {
    shotPerfEnd(probe.record, performance.now() - startedAt)
    return null
  }
}

/** 整页缩略图：每页只截一次，控制体积（最长边 ≤ 900）。 */
export async function capturePageShot(): Promise<{ dataURL: string; width: number; height: number } | null> {
  const startedAt = performance.now()
  const probe: CaptureProbe = { record: null, startedAt, cloneEndedAt: 0 }
  try {
    const background = getComputedStyle(document.body).backgroundColor || '#ffffff'
    const native = nativeCapture()
    const record = shotPerfStart('page', { native: !!native })
    if (native) {
      const shot = await native({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })
      if (shot) {
        const final = (await shrinkShot(shot, 900)) ?? shot
        const size = await imageSize(final)
        shotPerfEnd(record, performance.now() - startedAt, size)
        return { dataURL: final, width: size.width ?? window.innerWidth, height: size.height ?? window.innerHeight }
      }
    }
    probe.record = record
    if (record) record.native = false
    const scale = 0.4
    const prune = planShotPrune(document.body, intersect(viewportBox(), document.body.getBoundingClientRect()))
    if (record) record.pruned = prune.pruned
    probe.startedAt = performance.now()
    const canvas = await domToCanvas(document.body, shotOptions(probe, prune, { scale, background }))
    if (record) {
      const canvasAt = performance.now()
      shotPerfAdd('drawMs', Math.max(0, canvasAt - probe.cloneEndedAt - record.embedMs))
    }
    const shrink = Math.min(1, 900 / Math.max(canvas.width, canvas.height, 1))
    const final = shrink >= 1 ? canvas : limitWidth(
      (() => {
        const out = document.createElement('canvas')
        out.width = Math.max(1, Math.round(canvas.width * shrink))
        out.height = Math.max(1, Math.round(canvas.height * shrink))
        const ctx = out.getContext('2d')
        if (ctx) ctx.drawImage(canvas, 0, 0, out.width, out.height)
        return out
      })(),
    )
    const dataURL = await canvasToShot(final, probe)
    shotPerfEnd(record, performance.now() - startedAt, { width: final.width, height: final.height })
    return { dataURL, width: final.width, height: final.height }
  } catch {
    shotPerfEnd(probe.record, performance.now() - startedAt)
    return null
  }
}

/**
 * 调整模式的前后截图：按元素边框盒截当前视口。
 * - 传 `document.body`：进入调整前（反馈 UI 由 filter 跳过）；
 * - 传冻结 stage：导出时（插入的示意控件会临时克隆进 stage）。
 * 与整页缩略图不同，这里不缩到 900px，保留 1600px 上限内的清晰度。
 */
export async function captureSnapshotShot(root: Element): Promise<string | null> {
  const startedAt = performance.now()
  const probe: CaptureProbe = { record: null, startedAt, cloneEndedAt: 0 }
  try {
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const native = nativeCapture()
    if (native) {
      const box = root.getBoundingClientRect()
      const shot = await native({
        x: Math.max(0, Math.floor(box.left)),
        y: Math.max(0, Math.floor(box.top)),
        width: Math.max(1, Math.ceil(Math.min(box.width, window.innerWidth))),
        height: Math.max(1, Math.ceil(Math.min(box.height, window.innerHeight))),
      })
      if (shot) {
        const record = shotPerfStart('element', { native: true })
        const final = (await shrinkShot(shot, MAX_IMAGE_WIDTH)) ?? shot
        shotPerfEnd(record, performance.now() - startedAt, await imageSize(final))
        return final
      }
    }
    const record = shotPerfStart('element')
    probe.record = record
    const clip = intersect(viewportBox(), root.getBoundingClientRect())
    const prune = planShotPrune(root, clip)
    if (record) record.pruned = prune.pruned
    probe.startedAt = performance.now()
    const canvas = await domToCanvas(root, shotOptions(probe, prune, { scale, background: backgroundFor(root) }))
    const final = limitWidth(canvas)
    const dataURL = await canvasToShot(final, probe)
    shotPerfEnd(record, performance.now() - startedAt, { width: final.width, height: final.height })
    return dataURL
  } catch {
    shotPerfEnd(probe.record, performance.now() - startedAt)
    return null
  }
}

function imageSize(dataURL: string): Promise<{ width?: number; height?: number }> {  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({})
    img.src = dataURL
  })
}

// 调试版给回归用例留一个入口：不用点 UI 也能单独给元素/区域/整页截图计时。
if (__TANDEM_DEBUG__ && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__feedbackPerfCapture = {
    element: (selector: string) => captureElementShot(document.querySelector(selector) ?? document.body),
    region: (rect: FeedbackRect) => captureRegionShot(rect),
    page: () => capturePageShot(),
    records: feedbackShotPerf,
  }
}
