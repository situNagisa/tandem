import { useEffect, useLayoutEffect, useRef } from 'react'

const MIN_THUMB = 26
const EDGE_ZONE = 22
const IDLE_MS = 800
const BASE_Z = 30

/** 滚动区域所在的浮层层级：祖先里 position: fixed 的最大 z-index；不在浮层里时为基础层。 */
function layerOf(el: HTMLElement): number {
  let layer = 0
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.position !== 'fixed') continue
    const z = Number.parseInt(style.zIndex, 10)
    if (Number.isFinite(z)) layer = Math.max(layer, z)
  }
  return Math.max(BASE_Z, layer + 1)
}

function overflow(el: HTMLElement, axis: 'x' | 'y'): boolean {
  if (el === document.body || el === document.documentElement) return false
  const style = getComputedStyle(el)
  const value = axis === 'y' ? style.overflowY : style.overflowX
  if (!/(auto|scroll|overlay)/.test(value)) return false
  return axis === 'y'
    ? el.scrollHeight > el.clientHeight + 1
    : el.scrollWidth > el.clientWidth + 1
}

function scrollableAncestor(node: Element | null): HTMLElement | null {
  let el: Element | null = node
  while (el && el !== document.body && el !== document.documentElement) {
    if (el instanceof HTMLElement && (overflow(el, 'y') || overflow(el, 'x'))) return el
    el = el.parentElement
  }
  return null
}

function scrollableAt(x: number, y: number, target: EventTarget | null): HTMLElement | null {
  const direct = scrollableAncestor(target instanceof Element ? target : null)
  if (direct) return direct
  for (const node of document.elementsFromPoint(x, y)) {
    const found = scrollableAncestor(node)
    if (found) return found
  }
  return null
}

/**
 * 全局 overlay 滚动条：原生滚动条由 index.css 全局隐藏，这里只画 6px 圆角指示条。
 * 平时不可见，滚动、鼠标靠近容器右缘/下缘时淡入，停止 800ms 后淡出；可拖动。
 * 只有 App 根部一个实例，自动跟随鼠标/滚动所在的滚动容器，同时支持横竖两个方向。
 */
export function OverlayScrollbar() {
  const barYRef = useRef<HTMLDivElement>(null)
  const barXRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const barY = barYRef.current
    const barX = barXRef.current
    if (!barY || !barX) return
    let target: HTMLElement | null = null
    let visibleY = false
    let visibleX = false
    let hideTimer = 0
    let raf = 0
    let dragging: 'x' | 'y' | null = null
    let pointer: { x: number; y: number } | null = null

    /**
     * 指示条贴在容器右缘 3px 内。若滚动容器自身没有右侧留白，再往上看最多五层：
     * 取最外层有 ≥12px 右侧 padding、且与本容器右缘相距 ≤48px 的祖先 gutter
     * （如卡片外的面板留白、设置导航），不压住卡片头部的折叠/拖动/展开控件。
     * 反馈1926#07：会话图这类嵌在卡片里的滚动容器也要让位到卡片外的留白。
     */
    const gutterRight = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect()
      const inset = 3
      const pad = parseFloat(getComputedStyle(el).paddingRight) || 0
      if (pad >= 10) return rect.right - inset
      let gutter: number | null = null
      let node = el.parentElement
      for (let i = 0; i < 5 && node && node !== document.body; i++) {
        const nr = node.getBoundingClientRect()
        const npad = parseFloat(getComputedStyle(node).paddingRight) || 0
        if (npad >= 12 && nr.right - inset >= rect.right + 4 && nr.right - rect.right <= 48) {
          gutter = nr.right - inset
        }
        node = node.parentElement
      }
      return gutter ?? rect.right - inset
    }

    const gutterBottom = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect()
      const inset = 3
      const pad = parseFloat(getComputedStyle(el).paddingBottom) || 0
      if (pad >= 10) return rect.bottom - inset
      let gutter: number | null = null
      let node = el.parentElement
      for (let i = 0; i < 5 && node && node !== document.body; i++) {
        const nr = node.getBoundingClientRect()
        const npad = parseFloat(getComputedStyle(node).paddingBottom) || 0
        if (npad >= 12 && nr.bottom - inset >= rect.bottom + 4 && nr.bottom - rect.bottom <= 48) {
          gutter = nr.bottom - inset
        }
        node = node.parentElement
      }
      return gutter ?? rect.bottom - inset
    }

    const trackY = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect()
      return {
        left: Math.max(2, gutterRight(el) - 6),
        top: rect.top + 4,
        height: Math.max(0, rect.height - 8),
        width: 6,
      }
    }

    const trackX = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect()
      return {
        left: rect.left + 4,
        top: Math.max(2, gutterBottom(el) - 6),
        width: Math.max(0, rect.width - 8),
        height: 6,
      }
    }

    const update = () => {
      if (!target) return
      if (!target.isConnected) {
        hide()
        return
      }
      const canY = overflow(target, 'y')
      const canX = overflow(target, 'x')
      if (!canY && !canX) {
        hide()
        return
      }
      if (canY) {
        const track = trackY(target)
        const max = target.scrollHeight - target.clientHeight
        const thumb = Math.max(
          MIN_THUMB,
          Math.round(track.height * (target.clientHeight / target.scrollHeight)),
        )
        const top = track.top + (target.scrollTop / Math.max(1, max)) * (track.height - thumb)
        barY.style.width = `${track.width}px`
        barY.style.height = `${thumb}px`
        barY.style.transform = `translate3d(${Math.round(track.left)}px, ${Math.round(top)}px, 0)`
      }
      if (canX) {
        const track = trackX(target)
        const max = target.scrollWidth - target.clientWidth
        const thumb = Math.max(
          MIN_THUMB,
          Math.round(track.width * (target.clientWidth / target.scrollWidth)),
        )
        const left = track.left + (target.scrollLeft / Math.max(1, max)) * (track.width - thumb)
        barX.style.height = `${track.height}px`
        barX.style.width = `${thumb}px`
        barX.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(track.top)}px, 0)`
      }
      barY.dataset.visible = String(visibleY && canY)
      barX.dataset.visible = String(visibleX && canX)
    }

    const tick = () => {
      raf = 0
      if (!visibleY && !visibleX) return
      update()
      raf = requestAnimationFrame(tick)
    }

    const show = (el: HTMLElement) => {
      target = el
      window.clearTimeout(hideTimer)
      hideTimer = 0
      const z = String(layerOf(el))
      barY.style.zIndex = z
      barX.style.zIndex = z
      visibleY = overflow(el, 'y')
      visibleX = overflow(el, 'x')
      update()
      if (!raf) raf = requestAnimationFrame(tick)
    }

    const hide = () => {
      if (dragging) return
      window.clearTimeout(hideTimer)
      hideTimer = 0
      visibleY = false
      visibleX = false
      barY.dataset.visible = 'false'
      barX.dataset.visible = 'false'
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }

    const near = (el: HTMLElement, x: number, y: number) => {
      const rect = el.getBoundingClientRect()
      const right = x >= rect.right - EDGE_ZONE && x <= rect.right
      const bottom = y >= rect.bottom - EDGE_ZONE && y <= rect.bottom
      return (right && overflow(el, 'y')) || (bottom && overflow(el, 'x'))
    }

    const scheduleHide = () => {
      if (dragging) return
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => {
        hideTimer = 0
        if (!target || !pointer) {
          hide()
          return
        }
        // 指针还停在右缘/下缘附近时保持可见，移开后再由 pointermove 安排淡出。
        if (!near(target, pointer.x, pointer.y)) hide()
      }, IDLE_MS)
    }

    const onScroll = (event: Event) => {
      const el = event.target
      if (!(el instanceof HTMLElement)) return
      if (!overflow(el, 'y') && !overflow(el, 'x')) return
      show(el)
      scheduleHide()
    }

    const onPointerMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY }
      if (dragging) return
      if (event.pointerType === 'touch') return
      const el = scrollableAt(event.clientX, event.clientY, event.target)
      if (!el) {
        scheduleHide()
        return
      }
      if (near(el, event.clientX, event.clientY)) {
        show(el)
        return
      }
      if (target === el) scheduleHide()
    }

    const onPointerLeave = () => {
      pointer = null
      scheduleHide()
    }

    const startDrag = (axis: 'x' | 'y', event: PointerEvent) => {
      if (!target || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      update()
      const scroller = target
      const isY = axis === 'y'
      const track = isY ? trackY(scroller) : trackX(scroller)
      const thumb = isY ? barY.getBoundingClientRect().height : barX.getBoundingClientRect().width
      const max = isY
        ? scroller.scrollHeight - scroller.clientHeight
        : scroller.scrollWidth - scroller.clientWidth
      const start = isY ? event.clientY : event.clientX
      const startScroll = isY ? scroller.scrollTop : scroller.scrollLeft
      dragging = axis
      if (isY) barY.dataset.dragging = 'true'
      else barX.dataset.dragging = 'true'
      window.clearTimeout(hideTimer)
      hideTimer = 0
      document.body.style.userSelect = 'none'
      const onMove = (ev: PointerEvent) => {
        const ratio = max / Math.max(1, (isY ? track.height : track.width) - thumb)
        const value = startScroll + ((isY ? ev.clientY : ev.clientX) - start) * ratio
        if (isY) scroller.scrollTop = value
        else scroller.scrollLeft = value
        update()
      }
      const onUp = () => {
        dragging = null
        barY.dataset.dragging = 'false'
        barX.dataset.dragging = 'false'
        document.body.style.userSelect = ''
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        scheduleHide()
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    }

    const onBarYDown = (event: PointerEvent) => startDrag('y', event)
    const onBarXDown = (event: PointerEvent) => startDrag('x', event)

    const onBarEnter = () => {
      if (!target) return
      window.clearTimeout(hideTimer)
      hideTimer = 0
      show(target)
    }

    const onBarLeave = () => {
      if (!dragging) scheduleHide()
    }

    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerleave', onPointerLeave)
    barY.addEventListener('pointerdown', onBarYDown)
    barX.addEventListener('pointerdown', onBarXDown)
    barY.addEventListener('pointerenter', onBarEnter)
    barX.addEventListener('pointerenter', onBarEnter)
    barY.addEventListener('pointerleave', onBarLeave)
    barX.addEventListener('pointerleave', onBarLeave)

    return () => {
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeave)
      barY.removeEventListener('pointerdown', onBarYDown)
      barX.removeEventListener('pointerdown', onBarXDown)
      barY.removeEventListener('pointerenter', onBarEnter)
      barX.removeEventListener('pointerenter', onBarEnter)
      barY.removeEventListener('pointerleave', onBarLeave)
      barX.removeEventListener('pointerleave', onBarLeave)
      window.clearTimeout(hideTimer)
      if (raf) cancelAnimationFrame(raf)
      document.body.style.userSelect = ''
    }
  }, [])

  useEffect(() => {
    const barY = barYRef.current
    const barX = barXRef.current
    return () => {
      if (barY) barY.dataset.visible = 'false'
      if (barX) barX.dataset.visible = 'false'
    }
  }, [])

  return (
    <>
      <div ref={barYRef} className="overlay-scrollbar" data-axis="y" aria-hidden />
      <div ref={barXRef} className="overlay-scrollbar" data-axis="x" aria-hidden />
    </>
  )
}
