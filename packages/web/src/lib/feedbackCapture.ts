/** 反馈模式的圈选辅助：CSS 选择器、React 组件名、文本与截图。 */
import { domToPng } from 'modern-screenshot'
import type { FeedbackRect } from './feedback'

const UI_ATTR = 'data-feedback-ui'
const MAX_IMAGE_WIDTH = 1600

function isUiNode(node: Node): boolean {
  return node instanceof Element && node.closest(`[${UI_ATTR}]`) !== null
}

const screenshotFilter = (node: Node): boolean => !isUiNode(node)

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

/** 用元素自身截图并在四周补 16px 背景，接近“元素及周围一圈”的效果。 */
export async function captureElementShot(element: Element): Promise<string | null> {
  try {
    const box = element.getBoundingClientRect()
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    // 根节点自身的 translate（如右侧 -translate-y-1/2）会让离屏克隆错位裁切，截图期间去掉。
    const html = element as HTMLElement
    const inlineTransform = html.style.transform
    const inlineTranslate = html.style.translate
    if (getComputedStyle(html).transform !== 'none') html.style.transform = 'none'
    if (getComputedStyle(html).translate !== 'none') html.style.translate = 'none'
    let raw: string
    try {
      raw = await domToPng(html, {
        scale,
        filter: screenshotFilter,
        timeout: 12_000,
        backgroundColor: null,
      })
    } finally {
      html.style.transform = inlineTransform
      html.style.translate = inlineTranslate
    }
    const img = await loadImage(raw)
    const maxScale = Math.min(1, MAX_IMAGE_WIDTH / Math.max(1, img.width + 32 * scale))
    const pad = Math.round(16 * scale)
    const finalScale = scale * maxScale
    const width = Math.max(1, Math.round((img.width + 32 * scale) * maxScale))
    const height = Math.max(1, Math.round((img.height + 32 * scale) * maxScale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return raw
    const parentBg = element.parentElement
      ? getComputedStyle(element.parentElement).backgroundColor
      : ''
    const pageBg = getComputedStyle(document.body).backgroundColor
    const themeBg = getComputedStyle(document.documentElement)
      .getPropertyValue('--t-bg')
      .trim()
    ctx.fillStyle =
      parentBg && parentBg !== 'rgba(0, 0, 0, 0)'
        ? parentBg
        : pageBg && pageBg !== 'rgba(0, 0, 0, 0)'
          ? pageBg
          : themeBg || '#ffffff'
    ctx.fillRect(0, 0, width, height)
    const padFinal = Math.round(pad * maxScale)
    ctx.drawImage(img, padFinal, padFinal, width - padFinal * 2, height - padFinal * 2)
    // 兜底：元素本身极小时仍保留原图
    if (box.width <= 0 || box.height <= 0) return raw
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** 框选区域截图：整页渲染后按页面坐标裁切，跨多个元素也能完整截到。 */
export async function captureRegionShot(rect: FeedbackRect): Promise<string | null> {
  try {
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    const raw = await domToPng(document.body, {
      scale,
      filter: screenshotFilter,
      timeout: 15_000,
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
    })
    const img = await loadImage(raw)
    const bodyBox = document.body.getBoundingClientRect()
    const sx = Math.max(0, (rect.pageX - bodyBox.left - window.scrollX) * scale)
    const sy = Math.max(0, (rect.pageY - bodyBox.top - window.scrollY) * scale)
    const sw = Math.max(1, Math.min(img.width - sx, rect.width * scale))
    const sh = Math.max(1, Math.min(img.height - sy, rect.height * scale))
    const maxScale = Math.min(1, MAX_IMAGE_WIDTH / Math.max(sw, 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sw * maxScale))
    canvas.height = Math.max(1, Math.round(sh * maxScale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
}

/** 整页缩略图：每页只截一次，控制体积（最长边 ≤ 900）。 */
export async function capturePageShot(): Promise<{ dataURL: string; width: number; height: number } | null> {
  try {
    const raw = await domToPng(document.body, {
      scale: 0.4,
      filter: screenshotFilter,
      timeout: 15_000,
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
    })
    const img = await loadImage(raw)
    const scale = Math.min(1, 900 / Math.max(img.width, img.height, 1))
    if (scale >= 1) return { dataURL: raw, width: img.width, height: img.height }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return { dataURL: raw, width: img.width, height: img.height }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return { dataURL: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
  } catch {
    return null
  }
}
