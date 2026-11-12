/**
 * 把改动清单重新挂到冻结副本上：重新冻结真实界面、或从快照恢复副本后，
 * 都要按选择器把已有改动逐条重放，挂不上的标 stale（清单里标红）。
 * 撤销/重做也从改动数据重建，不再持有第一次冻结时的元素引用。
 */
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { BADGE_TONE_CLASS } from '../ui/Badge'
import { BUTTON_VARIANT_CLASS } from '../ui/Button'
import type { AdjustChange } from '../../lib/feedback'
import { ADJUST_ICONS } from './adjustIcons.generated'
import { iconSvgFor, type AdjustOp } from './feedbackAdjust'

export interface BoxStyle {
  width: string
  height: string
  maxWidth: string
  maxHeight: string
  translate: string
  visibility: string
}

export function captureBoxStyle(element: Element): BoxStyle {
  const html = element as HTMLElement
  return {
    width: html.style.width,
    height: html.style.height,
    maxWidth: html.style.maxWidth,
    maxHeight: html.style.maxHeight,
    translate: html.style.translate,
    visibility: html.style.visibility,
  }
}

export function restoreBoxStyle(element: Element, style: Partial<BoxStyle> | undefined): void {
  const html = element as HTMLElement
  if (!style) return
  for (const key of ['width', 'height', 'maxWidth', 'maxHeight', 'translate', 'visibility'] as const) {
    const value = style[key]
    if (value === undefined) continue
    if (value) html.style[key] = value
    else html.style.removeProperty(key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`))
  }
  if (!style.visibility) element.removeAttribute('data-adjust-hidden')
}

/** 目标选择器只认副本内部：兼容 `#root > …`、`body > …` 前缀。 */
export function findStageTarget(stage: Element, selector: string): Element | null {
  if (!selector) return null
  try {
    const direct = stage.querySelector(selector)
    if (direct) return direct
    const stripped = selector.replace(/^(?:body\s*>\s*)?(?:#root\s*>\s*)?/, '')
    if (stripped && stripped !== selector) {
      const relative = stage.querySelector(stripped)
      if (relative) return relative
    }
    const tail = selector.split('>').slice(-1)[0]?.trim()
    if (tail && /^[a-z][\w-]*/i.test(tail) && tail.length < 180) {
      return stage.querySelector(tail)
    }
  } catch {
    /* 选择器失效 */
  }
  return null
}

export function directTextNodes(element: Element): Text[] {
  return Array.from(element.childNodes).filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
}

export function elementOwnText(element: Element): string {
  return directTextNodes(element)
    .map((node) => node.nodeValue ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function setElementText(element: Element, text: string): void {
  const nodes = directTextNodes(element)
  nodes.forEach((node, index) => {
    node.nodeValue = index === 0 ? text : ''
  })
  if (nodes.length > 1) for (const node of nodes.slice(1)) node.remove()
  if (nodes.length === 0) element.appendChild(document.createTextNode(text))
}

function renderIconSvg(name: string, size: number): SVGSVGElement | null {
  const entry = ADJUST_ICONS.find((item) => item.name === name)
  if (!entry) return null
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-9999px;top:0;pointer-events:none'
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(createElement(entry.Icon, { size })))
    const svg = host.querySelector('svg')
    return svg ? (svg.cloneNode(true) as SVGSVGElement) : null
  } catch {
    return null
  } finally {
    root.unmount()
    host.remove()
  }
}

/** 把元素里的图标换成指定 lucide；保留原来的尺寸属性与非 lucide class。 */
export function replaceIconWithName(element: Element, name: string | undefined): boolean {
  if (!name) return false
  const oldSvg = iconSvgFor(element)
  if (!oldSvg) return false
  const size = Math.max(
    12,
    Math.round(oldSvg.getBoundingClientRect().width || oldSvg.width.baseVal.value || 16),
  )
  const fresh = renderIconSvg(name, size)
  if (!fresh) return false
  const extraClasses = Array.from(oldSvg.classList).filter((item) => !item.startsWith('lucide'))
  fresh.setAttribute('class', [...Array.from(fresh.classList), ...extraClasses].join(' '))
  for (const attr of ['width', 'height', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill', 'aria-hidden']) {
    const value = oldSvg.getAttribute(attr)
    if (value) fresh.setAttribute(attr, value)
  }
  if (!oldSvg.getAttribute('width')) fresh.removeAttribute('width')
  if (!oldSvg.getAttribute('height')) fresh.removeAttribute('height')
  oldSvg.replaceWith(fresh)
  return true
}

/** 换 Button / IconButton / Badge 的样式变体：只换本文件导出的 class 集合，样式来源仍是 ui/*。 */
export function applyVariant(element: Element, variant: string | undefined): boolean {
  if (!variant) return false
  const tone = element.getAttribute('data-tone')
  const map = tone ? BADGE_TONE_CLASS : BUTTON_VARIANT_CLASS
  const next = (map as Record<string, string | undefined>)[variant]
  if (!next) return false
  const remove = new Set<string>()
  for (const value of Object.values(map) as string[]) {
    for (const token of value.split(/\s+/)) remove.add(token)
  }
  for (const token of next.split(/\s+/)) remove.delete(token)
  for (const token of remove) if (token) element.classList.remove(token)
  for (const token of next.split(/\s+/)) if (token) element.classList.add(token)
  if (tone) element.setAttribute('data-tone', variant)
  else element.setAttribute('data-variant', variant)
  return true
}

const RESIZE_KEYS = ['width', 'height'] as const

function applyResize(element: Element, after: Record<string, unknown> | undefined): void {
  if (!after) return
  const html = element as HTMLElement
  const width = Number(after.width)
  const height = Number(after.height)
  if (Number.isFinite(width)) html.style.width = `${Math.max(8, Math.round(width))}px`
  if (Number.isFinite(height)) html.style.height = `${Math.max(8, Math.round(height))}px`
  html.style.maxWidth = 'none'
  html.style.maxHeight = 'none'
  const offsetX = Number(after.offsetX ?? 0)
  const offsetY = Number(after.offsetY ?? 0)
  if (offsetX || offsetY) html.style.translate = `${offsetX}px ${offsetY}px`
}

function applyMove(element: Element, after: Record<string, unknown> | undefined): void {
  if (!after) return
  const offsetX = Number(after.offsetX ?? 0)
  const offsetY = Number(after.offsetY ?? 0)
  ;(element as HTMLElement).style.translate = `${offsetX}px ${offsetY}px`
}

export function reorderElement(element: Element, index: number): void {
  const parent = element.parentElement
  if (!parent) return
  const siblings = Array.from(parent.children).filter((child) => child !== element)
  const next = siblings[Math.max(0, Math.min(index, siblings.length))] ?? null
  parent.insertBefore(element, next)
}

function reinsertDeleted(stage: Element, change: AdjustChange): boolean {
  const before = (change.before ?? {}) as {
    html?: string
    htmlFull?: string
    parentSelector?: string
    index?: number
  }
  const html = before.htmlFull ?? before.html
  if (!html) return false
  const holder = document.createElement('template')
  holder.innerHTML = html
  const node = holder.content.firstElementChild
  if (!node) return false
  const parent =
    (before.parentSelector ? findStageTarget(stage, before.parentSelector) : null) ?? stage
  const children = Array.from(parent.children)
  const reference = children[Math.max(0, Math.min(before.index ?? children.length, children.length))] ?? null
  parent.insertBefore(node, reference)
  return true
}

/** 改动是否作用在插入的示意控件上（这些改动写在插入条目里，不在副本上重放）。 */
export function isInsertedTarget(change: AdjustChange): boolean {
  return (
    change.kind === 'insert' ||
    change.target.selector.startsWith('[data-adjust-inserted')
  )
}

export function applyChangeToStage(change: AdjustChange, stage: Element): boolean {
  if (change.kind === 'insert' || change.kind === 'note') return true
  if (isInsertedTarget(change)) return true
  const element = findStageTarget(stage, change.target.selector)
  if (!element) return false
  const after = change.after ?? {}
  if (change.kind === 'resize') applyResize(element, after)
  else if (change.kind === 'move') applyMove(element, after)
  else if (change.kind === 'hide') {
    const html = element as HTMLElement
    html.style.visibility = 'hidden'
    element.setAttribute('data-adjust-hidden', '')
  } else if (change.kind === 'text') setElementText(element, String(after.text ?? ''))
  else if (change.kind === 'icon') return replaceIconWithName(element, after.icon as string | undefined)
  else if (change.kind === 'variant') {
    if (!applyVariant(element, after.variant as string | undefined)) return false
  } else if (change.kind === 'delete') element.remove()
  else if (change.kind === 'reorder') reorderElement(element, Number(after.index ?? 0))
  return true
}

export function revertChangeInStage(change: AdjustChange, stage: Element): boolean {
  if (change.kind === 'insert' || change.kind === 'note') return true
  if (isInsertedTarget(change)) return true
  const before = change.before ?? {}
  if (change.kind === 'delete') return reinsertDeleted(stage, change)
  const element = findStageTarget(stage, change.target.selector)
  if (!element) return false
  if (change.kind === 'resize' || change.kind === 'move') {
    const style = (before.style ?? undefined) as Partial<BoxStyle> | undefined
    if (style) restoreBoxStyle(element, style)
    else {
      const html = element as HTMLElement
      for (const key of RESIZE_KEYS) html.style.removeProperty(key)
      html.style.removeProperty('max-width')
      html.style.removeProperty('max-height')
      html.style.removeProperty('translate')
    }
  } else if (change.kind === 'hide') {
    restoreBoxStyle(element, before.style as Partial<BoxStyle> | undefined)
    element.removeAttribute('data-adjust-hidden')
  } else if (change.kind === 'text') setElementText(element, String(before.text ?? ''))
  else if (change.kind === 'icon') return replaceIconWithName(element, before.icon as string | undefined)
  else if (change.kind === 'variant') {
    if (!applyVariant(element, before.variant as string | undefined)) return false
  } else if (change.kind === 'reorder') reorderElement(element, Number(before.index ?? 0))
  return true
}

/** 改动数据 → 撤销/重做操作；重新冻结或恢复快照后替换掉旧的元素闭包。 */
export function opFromChange(change: AdjustChange, stage: Element): AdjustOp {
  return {
    change,
    undo: () => {
      revertChangeInStage(change, stage)
    },
    redo: () => {
      applyChangeToStage(change, stage)
    },
  }
}

/** 把现有改动按顺序挂到新副本；返回没能挂上的改动 id（清单标红）。 */
export function reattachChanges(changes: AdjustChange[], stage: Element): string[] {
  const failed: string[] = []
  for (const change of changes) {
    if (change.kind === 'insert' || change.kind === 'note' || isInsertedTarget(change)) {
      change.stale = false
      continue
    }
    const ok = applyChangeToStage(change, stage)
    change.stale = !ok
    if (!ok) failed.push(change.id)
  }
  return failed
}
