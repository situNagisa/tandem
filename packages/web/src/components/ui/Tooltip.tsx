import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

const SHOW_DELAY = 500
const SKIP_DELAY = 300
const GAP = 6
const EDGE = 8
const TIP_ID = 'tandem-tooltip'

let showTimer: number | null = null
let currentHost: HTMLElement | null = null
let lastHideAt = 0
let tipEl: HTMLDivElement | null = null

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
  if (!currentHost) return
  currentHost = null
  lastHideAt = performance.now()
  tipEl?.removeAttribute('data-open')
}

function showTip(host: HTMLElement, label: string): void {
  if (!host.isConnected || !label) return
  const el = layer()
  currentHost = host
  el.textContent = label
  el.removeAttribute('data-open')
  el.style.left = '-9999px'
  el.style.top = '-9999px'

  const box = host.getBoundingClientRect()
  const width = el.offsetWidth
  const height = el.offsetHeight
  let top = box.bottom + GAP
  if (top + height > window.innerHeight - EDGE && box.top - height - GAP >= EDGE) {
    top = box.top - height - GAP
  }
  top = Math.min(Math.max(top, EDGE), Math.max(EDGE, window.innerHeight - height - EDGE))
  let left = box.left + box.width / 2 - width / 2
  left = Math.min(Math.max(left, EDGE), Math.max(EDGE, window.innerWidth - width - EDGE))
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`

  requestAnimationFrame(() => {
    if (currentHost === host) el.setAttribute('data-open', '')
  })
}

function scheduleTip(host: HTMLElement, label: string): void {
  if (!canHover() || !label) return
  if (currentHost === host) return
  if (showTimer !== null) {
    window.clearTimeout(showTimer)
    showTimer = null
  }
  // 相邻 tooltip 之间快速移动时跳过等待。
  if (currentHost !== null || performance.now() - lastHideAt < SKIP_DELAY) {
    showTip(host, label)
    return
  }
  showTimer = window.setTimeout(() => {
    showTimer = null
    showTip(host, label)
  }, SHOW_DELAY)
}

// 鼠标移开、点击、滚动、按键立即隐藏。
if (typeof window !== 'undefined') {
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
      const target = e.target instanceof Element ? e.target : null
      const host = target?.closest<HTMLElement>('[title]') ?? null
      if (host === titleHost) return
      if (titleHost && (!host || !titleHost.contains(host))) restoreTitle()
      if (!host || tipHosts.has(host)) return
      const title = host.getAttribute('title')?.trim()
      if (!title) return
      titleHost = host
      titleCache.set(host, title)
      host.removeAttribute('title')
      scheduleTip(host, title)
    },
    true,
  )
  document.addEventListener(
    'pointerout',
    (e) => {
      if (!titleHost) return
      const related = e.relatedTarget instanceof Node ? e.relatedTarget : null
      if (related && titleHost.contains(related)) return
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
      const host = target.closest<HTMLElement>('[title]')
      if (!host || tipHosts.has(host)) return
      const title = host.getAttribute('title')?.trim()
      if (title) scheduleTip(host, title)
    },
    true,
  )
  document.addEventListener('focusout', hideTip, true)
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
      scheduleTip(host, label)
    }
    const onLeave = () => hideTip()
    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target instanceof Element) || !e.target.matches(':focus-visible')) return
      scheduleTip(host, label)
    }
    const onFocusOut = (e: FocusEvent) => {
      const related = e.relatedTarget instanceof Node ? e.relatedTarget : null
      if (related && host.contains(related)) return
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
