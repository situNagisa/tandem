import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { PORTAL_ATTR, nodeContains } from '../../lib/overlay'

/** 标准 tooltip 的悬停延迟；悬停浮层（HoverCard）复用同一组延迟，保证手感一致。 */
export const TIP_SHOW_DELAY = 500
export const TIP_SKIP_DELAY = 300
const GAP = 6
const POINTER_GAP = 14
const EDGE = 8
const TIP_MAX_WIDTH = 280
const TIP_ID = 'tandem-tooltip'

let showTimer: number | null = null
let currentHost: HTMLElement | null = null
let pendingHost: HTMLElement | null = null
let lastHideAt = 0
let tipEl: HTMLDivElement | null = null
let lastPointer: { x: number; y: number } | null = null

/** 细长目标（SVG 连线等）的包围盒中心离指针很远，tooltip 用它定位会跑偏；这类宿主用指针位置锚定。 */
function pointerAnchored(host: HTMLElement): boolean {
  return host.closest('[data-tip-anchor="pointer"]') !== null
}

function canHover(): boolean {
  return typeof window !== 'undefined' && !window.matchMedia('(hover: none)').matches
}

function layer(): HTMLDivElement {
  if (tipEl?.isConnected) return tipEl
  const existing = document.getElementById(TIP_ID)
  if (existing instanceof HTMLDivElement) {
    tipEl = existing
    return tipEl
  }
  tipEl = document.createElement('div')
  tipEl.id = TIP_ID
  tipEl.className = 'ui-tip'
  tipEl.setAttribute(PORTAL_ATTR, 'tooltip')
  tipEl.setAttribute('role', 'tooltip')
  tipEl.setAttribute('aria-hidden', 'true')
  document.body.appendChild(tipEl)
  return tipEl
}

function hideTip(): void {
  if (showTimer !== null) {
    window.clearTimeout(showTimer)
    showTimer = null
  }
  pendingHost = null
  if (!currentHost) return
  currentHost = null
  lastHideAt = performance.now()
  tipEl?.removeAttribute('data-open')
}

/**
 * 焦点/滚动变化引起的收起：如果指针还停在该宿主上就不收起。
 * Radix 菜单在悬停行时会移动焦点，旧实现会因此把刚排队的 tooltip 取消，
 * 导致菜单项里的长文本看不到全文（反馈 #10/#15）。
 */
function hideTipUnlessHovered(): void {
  const host = pendingHost ?? currentHost
  if (host?.isConnected && host.matches(':hover')) return
  hideTip()
}

function showTip(host: HTMLElement, label: string): void {
  if (!host.isConnected || !label) return
  pendingHost = null
  const el = layer()
  currentHost = host
  el.textContent = label
  el.removeAttribute('data-open')
  el.style.left = '-9999px'
  el.style.top = '-9999px'

  const box = host.getBoundingClientRect()
  // 视口很窄时 280px 的提示框自身会超出可视区，按当前视口收窄，保证左右边距都成立。
  el.style.maxWidth = `${Math.max(72, Math.min(TIP_MAX_WIDTH, window.innerWidth - EDGE * 2))}px`
  const width = el.offsetWidth
  const height = el.offsetHeight
  const point = pointerAnchored(host) && host.matches(':hover') ? lastPointer : null
  let top: number
  let left: number
  if (point) {
    top = point.y + POINTER_GAP
    if (top + height > window.innerHeight - EDGE && point.y - height - POINTER_GAP >= EDGE) {
      top = point.y - height - POINTER_GAP
    }
    left = point.x - width / 2
  } else {
    top = box.bottom + GAP
    if (top + height > window.innerHeight - EDGE && box.top - height - GAP >= EDGE) {
      top = box.top - height - GAP
    }
    left = box.left + box.width / 2 - width / 2
  }
  top = Math.min(Math.max(top, EDGE), Math.max(EDGE, window.innerHeight - height - EDGE))
  left = Math.min(Math.max(left, EDGE), Math.max(EDGE, window.innerWidth - width - EDGE))
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`

  requestAnimationFrame(() => {
    if (currentHost === host) el.setAttribute('data-open', '')
  })
}

/**
 * 程序化触发标准 tooltip：给动画池（轮次大纲等）这类无法挂 React 触发器的宿主使用。
 * 与 title/Tip 共用同一个 .ui-tip 浮层、延迟与避让逻辑。
 */
export function scheduleTooltip(host: HTMLElement, label: string): void {
  scheduleTip(host, label)
}

export function hideTooltip(): void {
  hideTip()
}

function scheduleTip(host: HTMLElement, label: string): void {
  if (!canHover() || !label) return
  if (currentHost === host) return
  if (showTimer !== null) {
    window.clearTimeout(showTimer)
    showTimer = null
  }
  pendingHost = host
  // 相邻 tooltip 之间快速移动时跳过等待。
  if (currentHost !== null || performance.now() - lastHideAt < TIP_SKIP_DELAY) {
    showTip(host, label)
    return
  }
  showTimer = window.setTimeout(() => {
    showTimer = null
    showTip(host, label)
  }, TIP_SHOW_DELAY)
}

// 鼠标移开、点击、滚动、按键立即隐藏。
if (typeof window !== 'undefined') {
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') return
      lastPointer = { x: e.clientX, y: e.clientY }
    },
    { capture: true, passive: true },
  )
  document.addEventListener('pointerdown', hideTip, true)
  document.addEventListener('keydown', hideTip, true)
  document.addEventListener('wheel', hideTip, true)
  document.addEventListener('scroll', hideTip, true)
  window.addEventListener('resize', hideTip)
}

// 原生 title 也统一走标准 tooltip：悬停时暂存并移除 title，避免浏览器原生浮层。
const tipHosts = new WeakSet<Element>()
const titleCache = new WeakMap<HTMLElement, string>()
let titleHost: HTMLElement | null = null

function restoreTitle(): void {
  if (!titleHost) return
  const host = titleHost
  titleHost = null
  const title = titleCache.get(host)
  if (title && !host.hasAttribute('title')) host.setAttribute('title', title)
}

if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerover',
    (e) => {
      if (!canHover()) return
      if (e.pointerType !== 'touch') lastPointer = { x: e.clientX, y: e.clientY }
      const target = e.target instanceof Element ? e.target : null
      const host = target?.closest<HTMLElement>('[title], [data-tip]') ?? null
      if (host === titleHost) return
      if (titleHost && (!host || !nodeContains(titleHost, host))) restoreTitle()
      if (!host || tipHosts.has(host)) return
      // 反馈9：DOM 上的原生 title 统一转成 data-tip（由 ui/Tooltip 展示）；
      // 仍兼容第三方/动态内容直接写 title 的情况，悬停时先摘掉再展示。
      const native = host.getAttribute('title')?.trim()
      const label = native || host.getAttribute('data-tip')?.trim()
      if (!label) return
      if (native) {
        titleHost = host
        titleCache.set(host, native)
        host.removeAttribute('title')
      }
      scheduleTip(host, label)
    },
    true,
  )
  document.addEventListener(
    'pointerout',
    (e) => {
      if (!titleHost && !currentHost) return
      if (titleHost && nodeContains(titleHost, e.relatedTarget)) return
      if (currentHost && nodeContains(currentHost, e.relatedTarget)) return
      restoreTitle()
      hideTip()
    },
    true,
  )
  document.addEventListener(
    'focusin',
    (e) => {
      const target = e.target instanceof Element ? e.target : null
      if (!target?.matches(':focus-visible')) return
      const host = target.closest<HTMLElement>('[title], [data-tip]')
      if (!host || tipHosts.has(host)) return
      const label =
        host.getAttribute('title')?.trim() || host.getAttribute('data-tip')?.trim()
      if (label) scheduleTip(host, label)
    },
    true,
  )
  document.addEventListener('focusout', hideTipUnlessHovered, true)
}

const FOCUSABLE =
  'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'

/** tooltip 文案同时作为无障碍描述：焦点落在宿主（或其内部第一个可聚焦控件）时由读屏播报。 */
function useTipAnchor(
  getHost: () => HTMLElement | null,
  label: string,
  describedBy?: string,
): void {
  useEffect(() => {
    const host = getHost()
    if (!host) return
    tipHosts.add(host)

    const descHost = host.matches(FOCUSABLE) ? host : host.querySelector<HTMLElement>(FOCUSABLE)
    const previousDesc = descHost?.getAttribute('aria-describedby') ?? null
    if (descHost && describedBy && !previousDesc?.split(/\s+/).includes(describedBy)) {
      descHost.setAttribute(
        'aria-describedby',
        previousDesc ? `${previousDesc} ${describedBy}` : describedBy,
      )
    }

    const onEnter = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      lastPointer = { x: e.clientX, y: e.clientY }
      scheduleTip(host, label)
    }
    const onLeave = () => hideTip()
    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target instanceof Element) || !e.target.matches(':focus-visible')) return
      scheduleTip(host, label)
    }
    const onFocusOut = (e: FocusEvent) => {
      if (nodeContains(host, e.relatedTarget)) return
      hideTip()
    }

    host.addEventListener('pointerenter', onEnter)
    host.addEventListener('pointerleave', onLeave)
    host.addEventListener('focusin', onFocusIn)
    host.addEventListener('focusout', onFocusOut)
    return () => {
      tipHosts.delete(host)
      host.removeEventListener('pointerenter', onEnter)
      host.removeEventListener('pointerleave', onLeave)
      host.removeEventListener('focusin', onFocusIn)
      host.removeEventListener('focusout', onFocusOut)
      if (currentHost === host) hideTip()
      if (descHost && describedBy) {
        const ids = (descHost.getAttribute('aria-describedby') ?? '')
          .split(/\s+/)
          .filter((id) => id && id !== describedBy)
        if (ids.length > 0) descHost.setAttribute('aria-describedby', ids.join(' '))
        else if (previousDesc) descHost.setAttribute('aria-describedby', previousDesc)
        else descHost.removeAttribute('aria-describedby')
      }
    }
  }, [getHost, label, describedBy])
}

/**
 * 挂在宿主元素内部的 tooltip 标记：借用父元素作为定位锚点。
 * side 仅为兼容旧调用保留，标准行为固定显示在下方，空间不足时翻到上方。
 */
export function Tip({ label }: { label: string; side?: 'top' | 'bottom' }) {
  const markerRef = useRef<HTMLSpanElement>(null)
  const host = useCallback(() => markerRef.current?.parentElement ?? null, [])
  const id = useId()
  useTipAnchor(host, label, id)
  // hidden 元素仍可被 aria-describedby 引用，且不参与可见文本 / 名称计算。
  return (
    <span ref={markerRef} id={id} hidden aria-hidden>
      {label}
    </span>
  )
}

/** 用包裹元素作为锚点的 tooltip；children 可以是整行条目。 */
export function Tooltip({
  label,
  className,
  children,
}: {
  label: string
  /** 兼容旧调用；标准 tooltip 固定下方，空间不足时翻转。 */
  side?: 'top' | 'bottom'
  className?: string
  children: ReactNode
}) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const host = useCallback(() => wrapRef.current, [])
  const id = useId()
  useTipAnchor(host, label, id)
  return (
    <span ref={wrapRef} className={cn('min-w-0 max-w-full', className)}>
      {children}
      <span id={id} hidden aria-hidden>
        {label}
      </span>
    </span>
  )
}
