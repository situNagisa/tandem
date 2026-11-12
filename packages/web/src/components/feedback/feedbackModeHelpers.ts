import { reactComponentName, rectFor } from '../../lib/feedbackCapture'
import { elementsAtPoint } from '../../lib/overlay'
import type {
  FeedbackItem,
  FeedbackPageShot,
  FeedbackPriority,
  FeedbackReceipt,
  FeedbackRect,
  FeedbackReference,
  FeedbackSelectMode,
  FeedbackType,
} from '../../lib/feedback'

export const TYPE_OPTIONS: ReadonlyArray<{ value: FeedbackType; label: string }> = [
  { value: 'issue', label: '问题' },
  { value: 'suggestion', label: '建议' },
  { value: 'praise', label: '好评' },
]

export const PRIORITY_OPTIONS: ReadonlyArray<{ value: FeedbackPriority; label: string }> = [
  { value: 'P0', label: 'P0' },
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
]

/** 反馈工具：点选 / 框选 / 调整（调整只在调试版出现，见 FeedbackMode）。 */
export type FeedbackTool = FeedbackSelectMode | 'adjust'

export const SELECT_MODE_OPTIONS: ReadonlyArray<{ value: FeedbackTool; label: string }> = [
  { value: 'element', label: '点选' },
  { value: 'region', label: '框选' },
  { value: 'adjust', label: '调整' },
]

export const MAX_VIDEO_BYTES = 8 * 1024 * 1024

export const UI_ATTR = 'data-feedback-ui'
export const HOVER_ATTR = 'data-feedback-hover'

export interface EditorState {
  mode: 'new' | 'edit'
  itemId?: string
  kind: FeedbackSelectMode
  element: Element | null
  rect: FeedbackRect
  type: FeedbackType
  priority: FeedbackPriority
  text: string
  /** 选中瞬间、输入浮窗出现前完成的截图。 */
  elementShot?: string | null
  pageShot?: FeedbackPageShot | null
  references: FeedbackReference[]
  annotatedShot?: string | null
  textSnippet?: string
  featureId?: string
  featureName?: string
  causeId?: string
  causeTitle?: string
  /** 用户手动改过根因：保存时不再用文字规则覆盖。 */
  causeEdited?: boolean
}

export interface VerifyState {
  queue: Array<{ item: FeedbackItem; receipt: FeedbackReceipt['items'][number] }>
  index: number
  note: string
}

export function safeQuery(selector: string): Element | null {
  if (!selector) return null
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

/**
 * 冻结进入反馈模式前的 hover 链：给链上元素加标记，并把样式表里所有
 * `:hover` 规则复制成 `[data-feedback-hover]` 版本，group-hover 的
 * “悬停才出现的按钮”也不会因为指针移到捕获层而消失。
 */
export function freezeHoverState(): () => void {
  for (const element of Array.from(document.querySelectorAll(':hover'))) {
    element.setAttribute(HOVER_ATTR, '')
  }

  const hoverRules = (rules: CSSRuleList): string => {
    const chunks: string[] = []
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const selector = rule.selectorText
        if (!selector?.includes(':hover')) continue
        chunks.push(
          `${selector.replaceAll(':hover', `[${HOVER_ATTR}]`)}{${rule.style.cssText}}`,
        )
      } else if (rule instanceof CSSMediaRule) {
        const inner = hoverRules(rule.cssRules)
        if (inner) chunks.push(`@media ${rule.conditionText}{${inner}}`)
      } else if (typeof CSSSupportsRule !== 'undefined' && rule instanceof CSSSupportsRule) {
        const inner = hoverRules(rule.cssRules)
        if (inner) chunks.push(`@supports ${rule.conditionText}{${inner}}`)
      } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
        const inner = hoverRules(rule.cssRules)
        if (inner) chunks.push(inner)
      } else if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) {
        const inner = hoverRules(rule.cssRules)
        if (inner) chunks.push(`@container ${rule.conditionText}{${inner}}`)
      }
    }
    return chunks.join('\n')
  }

  let css = ''
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      css += hoverRules(sheet.cssRules)
    } catch {
      /* 跨域样式表无法读取，忽略 */
    }
  }
  const style = document.createElement('style')
  style.dataset.feedbackHover = ''
  style.textContent = css
  document.head.appendChild(style)

  return () => {
    style.remove()
    for (const element of Array.from(document.querySelectorAll(`[${HOVER_ATTR}]`))) {
      element.removeAttribute(HOVER_ATTR)
    }
  }
}

export function isUiTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${UI_ATTR}]`) !== null
}

/** 捕获层之下的真实目标：跳过捕获层、高亮层与反馈自身 UI。 */
export function elementAtPoint(x: number, y: number): Element | null {
  try {
    for (const element of elementsAtPoint(x, y)) {
      if (isUiTarget(element)) continue
      if (element === document.documentElement) continue
      // 点在图标的 path/文字上时落到最近的可交互控件，截图才是整个按钮。
      return (
        element.closest(
          'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
        ) ?? element
      )
    }
  } catch {
    // 命中测试在浮层卸载等瞬间可能拿到失效节点：当作没选中，捕获层继续可用。
  }
  return null
}

/** 目标自身或最近的显式可滚动祖先。 */
export function scrollableFrom(element: Element | null): Element | null {
  let node: Element | null = element
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node)
    const canY =
      /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1
    const canX =
      /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1
    if (canY || canX) return node
    node = node.parentElement
  }
  return null
}

export function elementLabel(element: Element | null, kind: FeedbackSelectMode = 'element'): string {
  if (kind === 'region' || !element) return '框选区域'
  const component = reactComponentName(element)
  const tag = element.tagName.toLowerCase()
  if (component) return `<${component}>`
  const id = element.id ? `#${element.id}` : ''
  const cls = element.classList[0] ? `.${element.classList[0]}` : ''
  return `${tag}${id}${cls}`.slice(0, 42)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function viewportRectFor(item: FeedbackItem): FeedbackRect {
  const element = safeQuery(item.selector)
  if (element) return rectFor(element)
  return {
    x: item.rect.pageX - window.scrollX,
    y: item.rect.pageY - window.scrollY,
    width: item.rect.width,
    height: item.rect.height,
    pageX: item.rect.pageX,
    pageY: item.rect.pageY,
  }
}

export function imageFiles(files: FileList | File[] | null | undefined): File[] {
  if (!files) return []
  return Array.from(files).filter((file) => file.type.startsWith('image/'))
}

