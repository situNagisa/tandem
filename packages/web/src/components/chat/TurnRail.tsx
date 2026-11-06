import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import type { UiMessage } from '../../lib/types'

export interface TurnMark {
  id: string
  /** 1-based 轮次序号 */
  turn: number
  preview: string
}

const EMPTY_TURNS: TurnMark[] = []
const ROW = 16
const EDGE_H = 14
const FADE_COUNT = 3
const MIN_WINDOW = 5

let cachedMessages: UiMessage[] | null = null
let cachedTurns: TurnMark[] = EMPTY_TURNS

function selectTurns(state: { active: { messages: UiMessage[] } | null }): TurnMark[] {
  const messages = state.active?.messages
  if (!messages) return EMPTY_TURNS
  if (messages === cachedMessages) return cachedTurns
  const next: TurnMark[] = []
  messages.forEach((message) => {
    if (message.role !== 'user') return
    const text = message.content
      .filter((b) => b.type !== 'tool_result')
      .map((b) => {
        if (b.type === 'text') return b.text
        if (b.type === 'image') return '图片'
        return ''
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return
    next.push({
      id: message.id,
      turn: next.length + 1,
      preview: text.length > 40 ? `${text.slice(0, 40)}…` : text,
    })
  })
  const same =
    next.length === cachedTurns.length &&
    next.every(
      (mark, i) => mark.id === cachedTurns[i].id && mark.preview === cachedTurns[i].preview,
    )
  cachedMessages = messages
  if (same) return cachedTurns
  cachedTurns = next
  return next
}

function useTurnMarks(): TurnMark[] {
  return useAppStore(selectTurns)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function TurnRail({
  scrollRef,
  sessionId,
  onBeforeJump,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  sessionId: string | null
  onBeforeJump?: () => void
}) {
  const turns = useTurnMarks()
  const total = turns.length
  const [activeTurn, setActiveTurn] = useState(1)
  const [available, setAvailable] = useState(480)
  const navRef = useRef<HTMLElement>(null)
  const activeRef = useRef(activeTurn)
  const wheelLock = useRef(0)
  const dragging = useRef(false)
  const lastDragTurn = useRef(0)
  const frozenStart = useRef(0)
  const [draggingView, setDraggingView] = useState(false)
  const suppressUntil = useRef(0)
  const correctTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (correctTimer.current) window.clearTimeout(correctTimer.current)
    },
    [],
  )

  useEffect(() => {
    activeRef.current = activeTurn
  }, [activeTurn])

  useEffect(() => {
    setActiveTurn(total || 1)
  }, [sessionId, total])

  useLayoutEffect(() => {
    const parent = navRef.current?.parentElement
    if (!parent) return
    const measure = () => setAvailable(Math.max(80, parent.clientHeight - 48))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [total])

  // 当前轮：取视口顶部最早出现的那一轮；贴底时取最后一轮。
  useEffect(() => {
    const root = scrollRef.current
    if (!root || total === 0) return
    const visible = new Map<number, boolean>()
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-turn-index]'))
    const io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const index = Number((entry.target as HTMLElement).dataset.turnIndex)
                if (Number.isFinite(index)) visible.set(index, entry.isIntersecting)
              }
              const shown = [...visible.entries()]
                .filter(([, on]) => on)
                .map(([index]) => index)
              if (shown.length && performance.now() >= suppressUntil.current) {
                setActiveTurn(Math.min(...shown) + 1)
              }
            },
            { root, rootMargin: '0px 0px -85% 0px', threshold: 0 },
          )
        : null
    if (io) for (const node of nodes) io.observe(node)

    const onScroll = () => {
      if (performance.now() < suppressUntil.current) return
      const distance = root.scrollHeight - root.scrollTop - root.clientHeight
      if (distance < 40) setActiveTurn(total)
      else if (root.scrollTop < 40) setActiveTurn(1)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      io?.disconnect()
      root.removeEventListener('scroll', onScroll)
    }
  }, [scrollRef, turns, sessionId, total])

  const jump = useCallback(
    (turn: number, smooth = true) => {
      const root = scrollRef.current
      if (!root || turn < 1 || turn > total) return
      setActiveTurn(turn)
      onBeforeJump?.()
      const mark = turns[turn - 1]
      const targetTop = () => {
        if (turn === 1) return 0
        if (turn === total) return Math.max(0, root.scrollHeight - root.clientHeight)
        const el = root.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(mark.id)}"]`)
        if (!el) return null
        return Math.max(
          0,
          el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 16,
        )
      }
      const top = targetTop()
      if (top == null) return
      // 长距离跳转用瞬移：content-visibility 的估算行高会让平滑动画在中途反复改落点。
      const animate = smooth && Math.abs(root.scrollTop - top) < 2400
      suppressUntil.current = performance.now() + (animate ? 900 : 300)
      root.scrollTo({ top, behavior: animate ? 'smooth' : 'auto' })
      // 行高在渲染后才会变成真实值，跳转后重新校准一次落点。
      if (correctTimer.current) window.clearTimeout(correctTimer.current)
      correctTimer.current = window.setTimeout(
        () => {
          suppressUntil.current = 0
          const corrected = targetTop()
          if (corrected != null && Math.abs(root.scrollTop - corrected) > 4) {
            root.scrollTop = corrected
          }
        },
        animate ? 620 : 120,
      )
    },
    [scrollRef, turns, total, onBeforeJump],
  )

  // 在条上滚轮 = 逐轮移动。
  useEffect(() => {
    const nav = navRef.current
    if (!nav || total < 2) return
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 3) return
      event.preventDefault()
      const now = performance.now()
      if (now - wheelLock.current < 70) return
      wheelLock.current = now
      const next = clamp(activeRef.current + (event.deltaY > 0 ? 1 : -1), 1, total)
      if (next !== activeRef.current) jump(next)
    }
    nav.addEventListener('wheel', onWheel, { passive: false })
    return () => nav.removeEventListener('wheel', onWheel)
  }, [jump, total])

  // 拖动 = 连续选择（逐轮吸附）。
  const turnAtPoint = (clientY: number): number | null => {
    const nodes = navRef.current?.querySelectorAll<HTMLElement>('[data-turn-nav]')
    if (!nodes) return null
    let best: number | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    nodes.forEach((node) => {
      const rect = node.getBoundingClientRect()
      const distance = Math.abs(clientY - (rect.top + rect.height / 2))
      if (distance < bestDistance) {
        bestDistance = distance
        best = Number(node.dataset.turnNav)
      }
    })
    return best
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (!target.closest('[data-turn-nav]')) return
    // 用指针 Y 计算最近刻度：相邻刻度的命中区在边缘可能重叠，以几何位置为准。
    const turn = turnAtPoint(event.clientY)
    if (turn == null) return
    dragging.current = true
    frozenStart.current = start
    setDraggingView(true)
    lastDragTurn.current = turn
    event.currentTarget.setPointerCapture(event.pointerId)
    jump(turn, false)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragging.current) return
    const turn = turnAtPoint(event.clientY)
    if (turn == null || turn === lastDragTurn.current) return
    lastDragTurn.current = turn
    jump(turn, false)
  }

  const endDrag = () => {
    if (!dragging.current) return
    dragging.current = false
    setDraggingView(false)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      const target = event.target as HTMLElement | null
      // 输入框获得焦点时也允许用 Alt+↑/↓ 翻轮；只排除消息编辑等其他输入区域。
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable) &&
        !target.closest('.composer-card')
      ) {
        return
      }
      const ui = useUiStore.getState()
      if (ui.settingsOpen || ui.newSessionOpen || ui.searchOpen || ui.mobileSidebar) return
      if (total === 0) return
      event.preventDefault()
      const current = clamp(activeRef.current, 1, total)
      const next = clamp(current + (event.key === 'ArrowDown' ? 1 : -1), 1, total)
      if (next !== current) jump(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [jump, total])

  const fullCapacity = Math.max(1, Math.floor(available / ROW))
  // 超过可容纳数量的一半就窗口化，避免刻度被压到 4px 间距难以分辨。
  const windowed = total > Math.max(1, Math.floor(fullCapacity / 2))
  const windowSize = windowed
    ? Math.max(
        MIN_WINDOW,
        Math.floor((available - EDGE_H * 2 - FADE_COUNT * 2 * ROW) / ROW),
      )
    : total
  const size = Math.min(total, windowSize)
  const activeIndex = clamp(activeTurn - 1, 0, Math.max(0, total - 1))
  const centeredStart = windowed
    ? clamp(activeIndex - Math.floor(size / 2), 0, Math.max(0, total - size))
    : 0
  // 拖动期间冻结窗口，避免刻度在指针下移动导致选择跳变；松手后再让窗口跟随当前轮。
  const start = draggingView
    ? clamp(frozenStart.current, 0, Math.max(0, total - size))
    : centeredStart
  const visible = useMemo(() => turns.slice(start, start + size), [turns, start, size])

  if (total < 2) return null

  return (
    <nav
      ref={navRef}
      className="turn-rail"
      aria-label="轮次导航"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="turn-rail-stack">
        {windowed && (
          <button
            type="button"
            className="turn-edge"
            data-active={start === 0 ? 'true' : undefined}
            onClick={() => jump(1)}
            aria-label="跳到第 1 轮"
          >
            1
          </button>
        )}
        {windowed &&
          Array.from({ length: FADE_COUNT }, (_, i) => (
            <span
              key={`fade-top-${i}`}
              aria-hidden
              className="turn-fade"
              style={{ opacity: start > 0 ? 0.1 + i * 0.1 : 0 }}
            />
          ))}
        {visible.map((mark) => {
          const active = mark.turn === activeTurn
          const label = `第 ${mark.turn} 轮 · ${mark.preview}`
          return (
            <button
              key={mark.id}
              type="button"
              onClick={(event) => {
                // 指针按下时已按坐标跳转；松手后窗口会重排，再走一次 click 会落到相邻刻度。
                if (event.detail === 0) jump(mark.turn)
              }}
              data-turn-nav={mark.turn}
              data-active={active ? 'true' : undefined}
              aria-label={`跳转到${label}`}
              aria-current={active ? 'true' : undefined}
              className="turn-tick"
            >
              <span className="turn-tick-line" />
              {active && mark.turn !== 1 && mark.turn !== total && (
                <span className="turn-tick-num" aria-hidden>
                  {mark.turn}
                </span>
              )}
              <span className="turn-tip" role="tooltip">
                {label}
              </span>
            </button>
          )
        })}
        {windowed &&
          Array.from({ length: FADE_COUNT }, (_, i) => (
            <span
              key={`fade-bottom-${i}`}
              aria-hidden
              className="turn-fade"
              style={{ opacity: start + size < total ? 0.3 - i * 0.1 : 0 }}
            />
          ))}
        {windowed && (
          <button
            type="button"
            className="turn-edge"
            data-active={start + size >= total ? 'true' : undefined}
            onClick={() => jump(total)}
            aria-label={`跳到第 ${total} 轮`}
          >
            {total}
          </button>
        )}
      </div>
      <span className="turn-rail-count" aria-hidden>
        第 {activeTurn} / {total} 轮
      </span>
    </nav>
  )
}
