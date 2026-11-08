import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 767px)')
}

/** 元素宽度（分屏窗格紧凑排版用）；用回调 ref，元素切换后重新观察。 */
export function useElementWidth<T extends HTMLElement>(): [
  (node: T | null) => void,
  number,
] {
  const [el, setEl] = useState<T | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0)
      setWidth((prev) => (prev === next ? prev : next))
    })
    ro.observe(el)
    setWidth(Math.round(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [el])
  return [setEl, width]
}

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onOutside: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return
    const handler = (ev: PointerEvent) => {
      const el = ref.current
      if (el && ev.target instanceof Node && !el.contains(ev.target)) onOutside()
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [ref, onOutside, active])
}

/** 用 visualViewport 修正移动端软键盘弹出时的可视高度。 */
export function useViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport
    const apply = () => {
      const h = vv ? vv.height : window.innerHeight
      document.documentElement.style.setProperty('--app-height', `${Math.round(h)}px`)
    }
    apply()
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
    }
  }, [])
}

/** 本地保存的“最近使用”值，避免因组件重挂载丢失。 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/** 每秒刷新的当前时间，用于运行中计时；不活跃时不启动定时器。 */
export function useNow(active = true, interval = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(timer)
  }, [active, interval])
  return now
}

/** 监听横向滚动容器，返回左右是否还有被内容遮住的部分。 */
export function useHorizontalOverflow<T extends HTMLElement>(deps: unknown[] = []) {
  const ref = useRef<T>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const update = () => {
    const el = ref.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    const left = el.scrollLeft > 2
    const right = max > 2 && el.scrollLeft < max - 2
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
  }
  useLayoutEffect(() => {
    update()
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    update()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { ref, canLeft: edges.left, canRight: edges.right, update }
}


/**
 * 文本被单行省略时给出全文入口（R15）：只有实际溢出才挂 title，
 * 避免短标签满屏原生提示。`deps` 变化后重新测量（内容更新）。
 */
export function useOverflowTitle<T extends HTMLElement>(deps: unknown[] = []) {
  const [el, setEl] = useState<T | null>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    if (!el) return
    const update = () => setOverflow(el.scrollWidth > el.clientWidth + 1)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  useEffect(() => {
    if (!el) return
    setOverflow(el.scrollWidth > el.clientWidth + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return [setEl, overflow] as const
}
