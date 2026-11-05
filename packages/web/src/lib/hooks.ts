import { useEffect, useRef, useState, type RefObject } from 'react'

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
