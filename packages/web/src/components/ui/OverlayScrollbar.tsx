import { useEffect, useLayoutEffect, useRef } from 'react'

const MIN_THUMB = 26
const EDGE_ZONE = 22
const IDLE_MS = 800

function verticalOverflow(el: HTMLElement): boolean {
  if (el === document.body || el === document.documentElement) return false
  const style = getComputedStyle(el)
  if (!/(auto|scroll|overlay)/.test(style.overflowY)) return false
  return el.scrollHeight > el.clientHeight + 1
}

function scrollableAncestor(node: Element | null): HTMLElement | null {
  let el: Element | null = node
  while (el && el !== document.body && el !== document.documentElement) {
    if (el instanceof HTMLElement && verticalOverflow(el)) return el
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
 * 全局 overlay 滚动条：原生滚动条由 index.css 隐藏，这里只画一根 6px 的圆角指示条。
 * 平时不可见，滚动、鼠标靠近容器右缘时淡入，停止 800ms 后淡出；可拖动。
 * 只存在一个实例（App 根部），自动跟随鼠标/滚动所在的滚动容器。
 */
export function OverlayScrollbar() {
  const barRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    let target: HTMLElement | null = null
    let visible = false
    let hideTimer = 0
    let raf = 0
    let dragging = false
    let pointer: { x: number; y: number } | null = null

    const trackOf = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect()
      return {
        left: Math.max(2, rect.right - 9),
        top: rect.top + 4,
        height: Math.max(0, rect.height - 8),
        width: 6,
      }
    }

    const update = () => {
      if (!target) return
      if (!target.isConnected || !verticalOverflow(target)) {
        hide()
        return
      }
      const track = trackOf(target)
      const max = target.scrollHeight - target.clientHeight
      if (max <= 0 || track.height <= 0) return
      const thumb = Math.max(
        MIN_THUMB,
        Math.round(track.height * (target.clientHeight / target.scrollHeight)),
      )
      const top = track.top + (target.scrollTop / max) * (track.height - thumb)
      bar.style.width = `${track.width}px`
      bar.style.height = `${thumb}px`
      bar.style.transform = `translate3d(${Math.round(track.left)}px, ${Math.round(top)}px, 0)`
    }

    const tick = () => {
      raf = 0
      if (!visible) return
      update()
      raf = requestAnimationFrame(tick)
    }

    const show = (el: HTMLElement) => {
      target = el
      window.clearTimeout(hideTimer)
      hideTimer = 0
      update()
      if (!visible) {
        visible = true
        bar.dataset.visible = 'true'
      }
      if (!raf) raf = requestAnimationFrame(tick)
    }

    const hide = () => {
      if (dragging) return
      window.clearTimeout(hideTimer)
      hideTimer = 0
      visible = false
      bar.dataset.visible = 'false'
      if (raf) cancelAnimationFrame(raf)
      raf = 0
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
        // 指针还停在右缘附近时保持可见，移开后再由 pointermove 安排淡出。
        const rect = target.getBoundingClientRect()
        const near =
          pointer.x >= rect.right - EDGE_ZONE &&
          pointer.x <= rect.right &&
          pointer.y >= rect.top &&
          pointer.y <= rect.bottom
        if (!near) hide()
      }, IDLE_MS)
    }

    const onScroll = (event: Event) => {
      const el = event.target
      if (!(el instanceof HTMLElement) || !verticalOverflow(el)) return
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
      const rect = el.getBoundingClientRect()
      if (
        event.clientX >= rect.right - EDGE_ZONE &&
        event.x >= rect.left &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        show(el)
        return
      }
      if (target === el) scheduleHide()
    }

    const onPointerLeave = () => {
      pointer = null
      scheduleHide()
    }

    const onBarDown = (event: PointerEvent) => {
      if (!target || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const track = trackOf(target)
      const thumb = bar.getBoundingClientRect().height
      const max = target.scrollHeight - target.clientHeight
      const startY = event.clientY
      const startScroll = target.scrollTop
      const scroller = target
      dragging = true
      bar.dataset.dragging = 'true'
      window.clearTimeout(hideTimer)
      hideTimer = 0
      document.body.style.userSelect = 'none'
      const onMove = (ev: PointerEvent) => {
        const ratio = max / Math.max(1, track.height - thumb)
        scroller.scrollTop = startScroll + (ev.clientY - startY) * ratio
        update()
      }
      const onUp = () => {
        dragging = false
        bar.dataset.dragging = 'false'
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
    bar.addEventListener('pointerdown', onBarDown)
    bar.addEventListener('pointerenter', onBarEnter)
    bar.addEventListener('pointerleave', onBarLeave)

    return () => {
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeave)
      bar.removeEventListener('pointerdown', onBarDown)
      bar.removeEventListener('pointerenter', onBarEnter)
      bar.removeEventListener('pointerleave', onBarLeave)
      window.clearTimeout(hideTimer)
      if (raf) cancelAnimationFrame(raf)
      document.body.style.userSelect = ''
    }
  }, [])

  useEffect(() => {
    const bar = barRef.current
    return () => {
      if (bar) bar.dataset.visible = 'false'
    }
  }, [])

  return <div ref={barRef} className="overlay-scrollbar" aria-hidden />
}
