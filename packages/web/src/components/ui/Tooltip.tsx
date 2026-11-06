import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'

type Side = 'top' | 'bottom'

const GAP = 6
const PADDING = 8

function TipBubble({
  label,
  side,
  anchor,
}: {
  label: string
  side: Side
  anchor: DOMRect | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchor || !ref.current) {
      setPos(null)
      return
    }
    const el = ref.current
    const { width, height } = el.getBoundingClientRect()
    let placement = side
    if (side === 'top' && anchor.top - height - GAP < PADDING) placement = 'bottom'
    else if (
      side === 'bottom' &&
      anchor.bottom + height + GAP > window.innerHeight - PADDING
    ) {
      placement = 'top'
    }
    const top = placement === 'top' ? anchor.top - height - GAP : anchor.bottom + GAP
    const left = anchor.left + anchor.width / 2 - width / 2
    setPos({
      left: Math.max(PADDING, Math.min(left, window.innerWidth - width - PADDING)),
      top: Math.max(PADDING, Math.min(top, window.innerHeight - height - PADDING)),
    })
  }, [anchor, side, label])

  if (!anchor) return null
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className={cn('ui-tip-portal', pos && 'ui-tip-portal--in')}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      {label}
    </div>,
    document.body,
  )
}

function useHoverAnchor(host: () => HTMLElement | null) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const update = useCallback(() => {
    const el = host()
    if (el) setAnchor(el.getBoundingClientRect())
  }, [host])
  const hide = useCallback(() => setAnchor(null), [])

  useEffect(() => {
    const el = host()
    if (!el) return
    const onScroll = () => setAnchor(null)
    const onFocusIn = () => {
      // 鼠标点击不弹出 tooltip，仅键盘聚焦时显示。
      if (el.matches(':focus-visible')) update()
    }
    el.addEventListener('mouseenter', update)
    el.addEventListener('mouseleave', hide)
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', hide)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      el.removeEventListener('mouseenter', update)
      el.removeEventListener('mouseleave', hide)
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', hide)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [host, update, hide])

  return anchor
}

/**
 * 挂在宿主元素内部的 tooltip 标记：借用父元素作为定位锚点，
 * 气泡通过 Portal 渲染到 body，避免被侧栏等 overflow 容器裁切。
 */
export function Tip({ label, side = 'bottom' }: { label: string; side?: Side }) {
  const markerRef = useRef<HTMLSpanElement>(null)
  const host = useCallback(() => markerRef.current?.parentElement ?? null, [])
  const anchor = useHoverAnchor(host)
  return (
    <>
      <span ref={markerRef} hidden aria-hidden />
      <TipBubble label={label} side={side} anchor={anchor} />
    </>
  )
}

/** 用包裹元素作为锚点的 tooltip；children 可以是整行条目。 */
export function Tooltip({
  label,
  side = 'top',
  className,
  children,
}: {
  label: string
  side?: Side
  className?: string
  children: ReactNode
}) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const host = useCallback(() => wrapRef.current, [])
  const anchor = useHoverAnchor(host)
  return (
    <>
      <span ref={wrapRef} className={cn('min-w-0 max-w-full', className)}>
        {children}
      </span>
      <TipBubble label={label} side={side} anchor={anchor} />
    </>
  )
}
