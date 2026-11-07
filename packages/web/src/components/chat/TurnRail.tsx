import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { useAppStore } from '../../store/useAppStore'
import { useSessionView } from '../session/SessionScope'
import { useUiStore } from '../../store/useUiStore'
import { useTurnNavStore } from '../../store/useTurnNavStore'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import { useIsMobile } from '../../lib/hooks'
import type { UiMessage } from '../../lib/types'
import { createScrollFollower, type ScrollFollower } from './turnRailMotion'
import { POOL, RailScene } from './turnRailScene'
import { TurnOutlineSheet } from './TurnOutlineSheet'

export interface TurnMark {
  id: string
  /** 1-based 轮次序号 */
  turn: number
  /** 用户消息首行 */
  preview: string
}

const EMPTY_TURNS: TurnMark[] = []

let cachedMessages: UiMessage[] | null = null
let cachedTurns: TurnMark[] = EMPTY_TURNS

function selectTurns(state: { active: { messages: UiMessage[] } | null }): TurnMark[] {
  const messages = state.active?.messages
  if (!messages) return EMPTY_TURNS
  if (messages === cachedMessages) return cachedTurns
  const next: TurnMark[] = []
  messages.forEach((message) => {
    if (message.role !== 'user') return
    let hasImage = false
    const texts: string[] = []
    for (const b of message.content) {
      if (b.type === 'text') texts.push(b.text)
      else if (b.type === 'image') hasImage = true
    }
    const firstLine =
      texts
        .join('\n')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .find(Boolean) ?? ''
    const text = firstLine || (hasImage ? '图片' : '')
    if (!text) return
    next.push({
      id: message.id,
      turn: next.length + 1,
      preview: text.length > 120 ? `${text.slice(0, 120)}…` : text,
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

export function useTurnMarks(): TurnMark[] {
  return useAppStore(selectTurns)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])

/**
 * 轮次导航：静止时是一列刻度；靠近后刻度"长"成半透明的轮次大纲面板（同一批元素做 FLIP 形变）。
 * 悬停高亮、按下拖动 = 对话区跟手预览，松手确定；滚轮逐轮；Alt+↑/↓；手机端走底部抽屉。
 */
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
  const pinnedTurns = useSessionView((s) => s?.summary?.pinnedTurns)
  const feedbackActive = useFeedbackStore((s) => s.active)
  const sceneTurns = useMemo(() => {
    if (!pinnedTurns || pinnedTurns.length === 0) return turns
    const pinned = new Set(pinnedTurns)
    return turns.map((turn) => (pinned.has(turn.id) ? { ...turn, pinned: true } : turn))
  }, [turns, pinnedTurns])
  const total = turns.length
  const isMobile = useIsMobile()
  const railOn = total >= 2 && !isMobile
  const [activeTurn, setActiveTurn] = useState(1)
  const [open, setOpen] = useState(false)
  const [pressed, setPressed] = useState(false)

  const navRef = useRef<HTMLElement>(null)
  const bgRef = useRef<HTMLDivElement>(null)
  const indRef = useRef<HTMLDivElement>(null)
  const curRef = useRef<HTMLDivElement>(null)
  const hitRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const sceneRef = useRef<RailScene | null>(null)
  const followerRef = useRef<ScrollFollower | null>(null)

  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const sceneTurnsRef = useRef(sceneTurns)
  sceneTurnsRef.current = sceneTurns
  const totalRef = useRef(total)
  totalRef.current = total
  const activeRef = useRef(activeTurn)
  const beforeJumpRef = useRef(onBeforeJump)
  beforeJumpRef.current = onBeforeJump
  // 跳转后以目标轮为准，直到用户自己再滚动（贴底/顶部取不到真实落点时不要被观察器改写）
  const sticky = useRef(false)
  const dragRef = useRef(false)
  const snapNext = useRef(true)
  const openTimer = useRef(0)
  const closeTimer = useRef(0)
  const wheelAcc = useRef({ sum: 0, at: 0 })

  useEffect(() => {
    followerRef.current = createScrollFollower(
      () => scrollRef.current,
      () => {
        sticky.current = false
      },
    )
    return () => {
      followerRef.current?.destroy()
      followerRef.current = null
      window.clearTimeout(openTimer.current)
      window.clearTimeout(closeTimer.current)
    }
  }, [scrollRef])

  useEffect(() => {
    snapNext.current = true
    sticky.current = false
    followerRef.current?.cancel()
  }, [sessionId])

  useEffect(() => {
    setActiveTurn(total || 1)
  }, [sessionId, total])

  const go = useCallback(
    (turn: number, opts?: { recenter?: boolean; instant?: boolean }) => {
      const count = totalRef.current
      if (count < 1) return
      const target = clamp(Math.round(turn), 1, count)
      activeRef.current = target
      setActiveTurn(target)
      sticky.current = true
      beforeJumpRef.current?.()
      followerRef.current?.to(() => {
        const root = scrollRef.current
        const mark = turnsRef.current[target - 1]
        if (!root || !mark) return null
        if (target === 1) return 0
        if (target === totalRef.current) return Math.max(0, root.scrollHeight - root.clientHeight)
        const el = root.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(mark.id)}"]`)
        if (!el) return null
        return Math.max(
          0,
          el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 16,
        )
      }, opts?.instant)
      const scene = sceneRef.current
      scene?.setActive(target)
      if (opts?.recenter !== false) scene?.setCenter(target)
    },
    [scrollRef],
  )
  const goRef = useRef(go)
  goRef.current = go

  // 场景生命周期：DOM 池 + 弹簧；可用高度变化时重算窗口。
  useLayoutEffect(() => {
    const root = navRef.current
    const bg = bgRef.current
    const ind = indRef.current
    const cur = curRef.current
    if (!railOn || !root || !bg || !ind || !cur) return
    const items = itemRefs.current.slice(0, POOL).filter((el): el is HTMLDivElement => !!el)
    const scene = new RailScene({ root, bg, ind, cur, items })
    sceneRef.current = scene
    scene.onDragRow = (turn) => goRef.current(turn, { recenter: false })
    scene.setData(sceneTurnsRef.current)
    scene.setActive(activeRef.current, true)
    scene.setCenter(activeRef.current, true)
    const parent = root.parentElement
    let ro: ResizeObserver | null = null
    if (parent) {
      scene.setAvail(parent.clientHeight)
      ro = new ResizeObserver(() => scene.setAvail(parent.clientHeight))
      ro.observe(parent)
    }
    return () => {
      ro?.disconnect()
      scene.destroy()
      sceneRef.current = null
    }
  }, [railOn])

  useLayoutEffect(() => {
    sceneRef.current?.setData(sceneTurns)
  }, [sceneTurns])

  useEffect(() => {
    activeRef.current = activeTurn
    const scene = sceneRef.current
    if (scene) {
      scene.setActive(activeTurn, snapNext.current)
      if (!dragRef.current) scene.setCenter(activeTurn, snapNext.current)
    }
    snapNext.current = false
    useTurnNavStore.getState().setProgress(activeTurn, total)
  }, [activeTurn, total, railOn, sessionId])

  useEffect(
    () => () => {
      useTurnNavStore.setState({ total: 0, active: 1, sheetOpen: false })
    },
    [],
  )

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
              const shown = [...visible.entries()].filter(([, on]) => on).map(([index]) => index)
              if (shown.length && !sticky.current && !dragRef.current) {
                setActiveTurn(Math.min(...shown) + 1)
              }
            },
            { root, rootMargin: '0px 0px -85% 0px', threshold: 0 },
          )
        : null
    if (io) for (const node of nodes) io.observe(node)

    const onScroll = () => {
      if (sticky.current || dragRef.current) return
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

  // Alt+↑/↓：逐轮移动；其他滚动类按键视为用户接管滚动。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (!event.altKey && !event.ctrlKey && !event.metaKey && SCROLL_KEYS.has(event.key) && !typing) {
        sticky.current = false
        return
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      // 输入框获得焦点时也允许用 Alt+↑/↓ 翻轮；只排除消息编辑等其他输入区域。
      if (typing && !target?.closest('.composer-card')) return
      const ui = useUiStore.getState()
      if (ui.settingsOpen || ui.newSessionOpen || ui.searchOpen || ui.mobileSidebar) return
      const count = totalRef.current
      if (count === 0) return
      event.preventDefault()
      const current = clamp(activeRef.current, 1, count)
      const next = clamp(current + (event.key === 'ArrowDown' ? 1 : -1), 1, count)
      if (next !== current) go(next)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [go])

  const closePanel = useCallback(() => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    openTimer.current = 0
    closeTimer.current = 0
    setOpen(false)
    sceneRef.current?.setOpen(false)
    sceneRef.current?.setCenter(activeRef.current)
  }, [])

  const openPanel = useCallback(() => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = 0
    setOpen(true)
    sceneRef.current?.setOpen(true)
  }, [])

  // 退出反馈模式后，如果指针早已不在大纲上，补一次收起（反馈模式的捕获层不会触发 pointerleave）。
  useEffect(() => {
    if (feedbackActive || !open) return
    const timer = window.setTimeout(() => {
      if (!dragRef.current && !navRef.current?.matches(':hover')) closePanel()
    }, 300)
    return () => window.clearTimeout(timer)
  }, [feedbackActive, open, closePanel])

  // 滚轮 = 逐轮移动：鼠标滚轮每格一轮，触控板累积到阈值再走一轮。
  useEffect(() => {
    const hit = hitRef.current
    if (!railOn || !hit) return
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      event.preventDefault()
      let dy = event.deltaY
      if (event.deltaMode === 1) dy *= 16
      else if (event.deltaMode === 2) dy *= 300
      if (Math.abs(dy) < 1) return
      const now = performance.now()
      const acc = wheelAcc.current
      if (now - acc.at > 250) acc.sum = 0
      acc.at = now
      let steps = 0
      if (Math.abs(dy) >= 50) {
        steps = Math.sign(dy)
        acc.sum = 0
      } else {
        acc.sum += dy
        if (Math.abs(acc.sum) >= 36) {
          steps = Math.trunc(acc.sum / 36)
          acc.sum -= steps * 36
        }
      }
      if (!steps) return
      sceneRef.current?.setHoverEnabled(false)
      go(activeRef.current + clamp(steps, -3, 3))
    }
    hit.addEventListener('wheel', onWheel, { passive: false })
    return () => hit.removeEventListener('wheel', onWheel)
  }, [railOn, go])

  const pointerY = (event: ReactPointerEvent<HTMLElement>): number =>
    event.clientY - (navRef.current?.getBoundingClientRect().top ?? 0)

  const onPointerEnter = (event: ReactPointerEvent<HTMLElement>) => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = 0
    if (event.pointerType === 'touch' || sceneRef.current?.open || openTimer.current) return
    // 路过滚动条/刻度时不要立刻展开
    openTimer.current = window.setTimeout(() => {
      openTimer.current = 0
      openPanel()
    }, 70)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const scene = sceneRef.current
    if (!scene) return
    scene.setPointer(pointerY(event))
    if (event.pointerType !== 'touch') scene.setHoverEnabled(true)
  }

  const onPointerLeave = (event: ReactPointerEvent<HTMLElement>) => {
    window.clearTimeout(openTimer.current)
    openTimer.current = 0
    if (dragRef.current || useFeedbackStore.getState().active) return
    // 指针移到行尾图钉等面板内元素时，hit 也会收到 pointerleave，不应收起。
    const related = event.relatedTarget as Element | null
    if (related && navRef.current?.contains(related)) return
    sceneRef.current?.setPointer(null)
    window.clearTimeout(closeTimer.current)
    if (document.activeElement === hitRef.current && hitRef.current?.matches(':focus-visible')) return
    closeTimer.current = window.setTimeout(closePanel, event.pointerType === 'touch' ? 900 : 110)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const scene = sceneRef.current
    if (!scene || (event.pointerType === 'mouse' && event.button !== 0)) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    window.clearTimeout(openTimer.current)
    openTimer.current = 0
    const y = pointerY(event)
    scene.setPointer(y)
    const wasExpanded = scene.expanded
    if (!scene.open) openPanel()
    dragRef.current = true
    setPressed(true)
    scene.setDragging(true)
    // 触摸时面板还没展开：这一下只负责展开，随后拖动再选行
    if (event.pointerType === 'touch' && !wasExpanded) return
    go(scene.rowAt(y), { recenter: false })
  }

  const endDrag = (event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    if (!dragRef.current) return
    dragRef.current = false
    setPressed(false)
    const scene = sceneRef.current
    scene?.setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!cancelled) go(activeRef.current)
    const rect = event.currentTarget.getBoundingClientRect()
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    if (!inside || event.pointerType === 'touch') {
      scene?.setPointer(null)
      window.clearTimeout(closeTimer.current)
      closeTimer.current = window.setTimeout(closePanel, event.pointerType === 'touch' ? 900 : 110)
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const count = totalRef.current
    const current = activeRef.current
    let next: number | null = null
    if (event.key === 'ArrowUp') next = current - 1
    else if (event.key === 'ArrowDown') next = current + 1
    else if (event.key === 'PageUp') next = current - 10
    else if (event.key === 'PageDown') next = current + 10
    else if (event.key === 'Home') next = 1
    else if (event.key === 'End') next = count
    else if (event.key === 'Escape') {
      closePanel()
      event.currentTarget.blur()
      return
    }
    if (next == null || event.altKey) return
    event.preventDefault()
    event.stopPropagation()
    sceneRef.current?.setHoverEnabled(false)
    go(next)
  }

  const sheetOpen = useTurnNavStore((s) => s.sheetOpen)
  const setSheetOpen = useTurnNavStore((s) => s.setSheetOpen)
  useEffect(() => {
    if (!isMobile && useTurnNavStore.getState().sheetOpen) setSheetOpen(false)
  }, [isMobile, setSheetOpen])

  const togglePinnedTurn = (messageId: string) => {
    if (!messageId) return
    const state = useAppStore.getState()
    const active = state.active
    if (!active?.summary) return
    const current = active.summary.pinnedTurns ?? []
    const next = current.includes(messageId)
      ? current.filter((id) => id !== messageId)
      : [...current, messageId]
    void state.updateSession(active.hostId, active.sessionId, { pinnedTurns: next })
  }

  const current = turns[activeTurn - 1]

  return (
    <>
      {railOn && (
        <nav
          ref={navRef}
          className="turn-rail"
          aria-label="轮次导航"
          data-open={open ? 'true' : undefined}
          data-pressed={pressed ? 'true' : undefined}
          data-feedback={feedbackActive ? 'true' : undefined}
        >
          <div ref={bgRef} className="turn-bg" aria-hidden />
          <div
            className="turn-clip"
            aria-hidden
            onClick={(event) => {
              const pin = (event.target as HTMLElement).closest<HTMLElement>('.turn-item-p[data-turn]')
              if (!pin) return
              event.preventDefault()
              event.stopPropagation()
              togglePinnedTurn(pin.dataset.turn ?? '')
            }}
          >
            <div ref={indRef} className="turn-ind" />
            <div ref={curRef} className="turn-cur" />
            {Array.from({ length: POOL }, (_, i) => (
              <div
                key={i}
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                className="turn-item"
              >
                <span className="turn-item-n" />
                <span className="turn-item-t" />
                <span className="turn-item-k" />
                <span className="turn-item-r" />
                <span className="turn-item-p">
                  <svg viewBox="0 0 16 16" aria-hidden>
                    <path d="M9.9 1.6a1 1 0 0 0-1.5 0L7 3l-3.4.8a.85.85 0 0 0-.4 1.4L5 7 2.3 10.6a.7.7 0 0 0 .9.9L7 9l1.8 1.8a.85.85 0 0 0 1.4-.4L11 7l1.4-1.4a1 1 0 0 0 0-1.5z" />
                  </svg>
                </span>
                <span className="turn-item-d" />
              </div>
            ))}
          </div>
          <div
            ref={hitRef}
            className="turn-hit"
            role="slider"
            tabIndex={0}
            aria-label="切换轮次"
            aria-orientation="vertical"
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={activeTurn}
            aria-valuetext={`第 ${activeTurn} 轮${current ? ` · ${current.preview}` : ''}`}
            onPointerEnter={onPointerEnter}
            onPointerMove={onPointerMove}
            onPointerLeave={onPointerLeave}
            onPointerDown={onPointerDown}
            onPointerUp={(e) => endDrag(e, false)}
            onPointerCancel={(e) => endDrag(e, true)}
            onKeyDown={onKeyDown}
            onFocus={(e) => {
              if (e.currentTarget.matches(':focus-visible')) openPanel()
            }}
            onBlur={() => {
              if (!dragRef.current) closePanel()
            }}
          />
          <span className="turn-count" aria-hidden>
            第 {activeTurn} / {total} 轮
          </span>
        </nav>
      )}
      {isMobile && (
        <TurnOutlineSheet
          open={sheetOpen && total >= 2}
          turns={turns}
          active={activeTurn}
          onClose={() => setSheetOpen(false)}
          onPick={(turn) => {
            setSheetOpen(false)
            go(turn)
          }}
        />
      )}
    </>
  )
}
