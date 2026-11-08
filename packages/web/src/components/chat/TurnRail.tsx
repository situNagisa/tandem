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
import { isUserTurnMessage } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { isTargetFocused, useSessionTarget, useSessionView } from '../session/SessionScope'
import { useUiStore } from '../../store/useUiStore'
import { useTurnNavStore } from '../../store/useTurnNavStore'
import { useFeedbackStore } from '../../store/useFeedbackStore'
import { useIsMobile } from '../../lib/hooks'
import { nodeContains } from '../../lib/overlay'
import type { UiMessage } from '../../lib/types'
import { api } from '../../lib/api'
import {
  heatLabel,
  heatLevels,
  summaryUsage,
  turnUsageLabel,
  turnWeight,
  usageByTurn,
  type TurnHeatMetric,
  type TurnUsage,
} from '../../lib/turnUsage'
import { hideTooltip, scheduleTooltip } from '../ui/Tooltip'
import { createScrollFollower, type ScrollFollower } from './turnRailMotion'
import { POOL, RailScene } from './turnRailScene'
import { TurnOutlineSheet } from './TurnOutlineSheet'

export interface TurnMark {
  id: string
  /** 1-based 位置（含摘要行），用于大纲导航。 */
  turn: number
  /** 真实轮次序号（摘要行没有）。 */
  no?: number
  /** 行内显示的前 120 字 */
  preview: string
  /** 首行全文，悬停/读屏用。 */
  full: string
  /** 该轮用量汇总；悬停时由标准 tooltip 显示。 */
  usage?: TurnUsage
  /** 压缩摘要行。 */
  summary?: boolean
  /** 已被压缩掉的轮次（占用按 0 计，仍显示花费）。 */
  compressed?: boolean
  /** 跳转目标：摘要/压缩行跳到压缩提示行。 */
  jumpId?: string
  /** 用量档位（由当前着色依据计算）。 */
  heat?: number
}

const EMPTY_MESSAGES: UiMessage[] = []
const turnCache = new WeakMap<UiMessage[], TurnMark[]>()

function messageTitle(message: UiMessage): { preview: string; full: string } | null {
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
  const full = firstLine || (hasImage ? '图片' : '')
  return full ? { preview: full.length > 120 ? `${full.slice(0, 120)}…` : full, full } : null
}

function marksFromMessages(
  messages: UiMessage[],
  opts?: { compressed?: boolean; jumpId?: string },
): TurnMark[] {
  const cached = !opts ? turnCache.get(messages) : undefined
  if (cached) return cached
  const next: TurnMark[] = []
  for (const message of messages) {
    if (message.role !== 'user' || message.gap) continue
    const summary = message.summary === true
    if (!summary && !isUserTurnMessage(message)) continue
    const title = messageTitle(message)
    if (!title) continue
    next.push({
      id: message.id,
      turn: next.length + 1,
      preview: summary ? '摘要' : title.preview,
      full: summary ? '摘要' : title.full,
      ...(summary ? { summary: true } : {}),
      ...(opts?.compressed ? { compressed: true } : {}),
      ...(opts?.jumpId ? { jumpId: opts.jumpId } : {}),
    })
  }
  if (!opts) turnCache.set(messages, next)
  return next
}

function withUsage(
  marks: TurnMark[],
  messages: UiMessage[],
  usage: Map<string, TurnUsage>,
  opts?: { compressed?: boolean; jumpId?: string },
): TurnMark[] {
  return marks.map((mark) => {
    const summaryMessage = mark.summary ? messages.find((m) => m.id === mark.id) : undefined
    const item = mark.summary
      ? summaryMessage
        ? summaryUsage(summaryMessage)
        : undefined
      : usage.get(mark.id)
    const normalized = opts?.compressed && item ? { ...item, contextTokens: 0 } : item
    return {
      ...mark,
      ...(normalized ? { usage: normalized } : {}),
      ...(opts?.jumpId ? { jumpId: opts.jumpId } : {}),
    }
  })
}

/** 当前窗格自己的轮次刻度（不读全局 active，分屏时各窗格互不串台）。 */
export function useTurnMarks(): TurnMark[] {
  const messages = useSessionView((view) => view?.messages ?? EMPTY_MESSAGES)
  const serverTurns = useSessionView((view) => view?.turns)
  const subagents = useSessionView((view) => view?.subagents)
  const sessionId = useSessionView((view) => view?.sessionId)
  const hostId = useSessionView((view) => view?.hostId ?? null)
  const notice = messages.find((message) => message.compaction?.canUndo)
  const noticeId = notice?.id ?? null
  const [backup, setBackup] = useState<{ noticeId: string; turns: TurnMark[] } | null>(null)

  // 压缩原文里保留着被压掉的轮次：取回来作为最浅的「已压缩」刻度，摘要另起一行。
  useEffect(() => {
    if (!hostId || !sessionId || !noticeId) {
      setBackup(null)
      return
    }
    let cancelled = false
    const host = useAppStore.getState().hosts.find((item) => item.id === hostId)
    if (!host) return
    api
      .compactionOriginal(host, sessionId, noticeId)
      .then((res) => {
        if (cancelled) return
        const raw = marksFromMessages(res.messages, { compressed: true, jumpId: noticeId })
        const usage = usageByTurn(res.messages, undefined, sessionId)
        setBackup({
          noticeId,
          turns: withUsage(raw, res.messages, usage, { compressed: true, jumpId: noticeId }),
        })
      })
      .catch(() => {
        if (!cancelled) setBackup(null)
      })
    return () => {
      cancelled = true
    }
  }, [hostId, sessionId, noticeId])

  return useMemo(() => {
    const usage = usageByTurn(messages, subagents, sessionId ?? undefined)
    const local = withUsage(marksFromMessages(messages), messages, usage, {
      ...(noticeId ? { jumpId: noticeId } : {}),
    })
    const compressed = backup?.noticeId === noticeId ? backup.turns : []
    let base: TurnMark[]
    if (!serverTurns?.length) {
      base = [...compressed, ...local]
    } else {
      // 会话被截断时以服务端大纲为准，再补上本地新增（尚未进大纲）的轮次。
      const known = new Set(serverTurns.map((turn) => turn.messageId))
      const extra = local.filter((turn) => !known.has(turn.id))
      base = [
        ...compressed,
        ...serverTurns.map((turn) => {
          const summary = turn.preview.startsWith('[此前对话摘要]')
          const usageItem = summary ? undefined : usage.get(turn.messageId)
          return {
            id: turn.messageId,
            turn: 0,
            preview: summary ? '摘要' : turn.preview,
            full: summary ? '摘要' : turn.preview,
            ...(summary ? { summary: true } : {}),
            ...(summary && noticeId ? { jumpId: noticeId } : {}),
            ...(usageItem ? { usage: usageItem } : {}),
          }
        }),
        ...extra,
      ]
    }
    let no = 0
    return base.map((mark, index) => ({
      ...mark,
      turn: index + 1,
      ...(mark.summary ? { no: undefined } : { no: ++no }),
    }))
  }, [messages, serverTurns, subagents, sessionId, backup, noticeId])
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
  const [metric, setMetric] = useState<TurnHeatMetric>(() => {
    try {
      return localStorage.getItem('tandem.turnHeatMetric.v1') === 'context' ? 'context' : 'cost'
    } catch {
      return 'cost'
    }
  })
  const weights = useMemo(() => turns.map((turn) => turnWeight(turn.usage, metric)), [turns, metric])
  const totalWeight = useMemo(() => weights.reduce((sum, value) => sum + value, 0), [weights])
  const shareOf = (mark: TurnMark | undefined): number => {
    if (!mark || totalWeight <= 0) return 0
    return Math.round((turnWeight(mark.usage, metric) / totalWeight) * 100)
  }
  const scopeTarget = useSessionTarget()
  const hostId = useSessionView((s) => s?.hostId ?? null)
  const hasEarlier = useSessionView((s) => s?.hasEarlier ?? false)
  const serverTurns = useSessionView((s) => s?.turns)
  const loadingTurns = useSessionView((s) => s?.loadingTurns ?? false)
  const pinnedTurns = useSessionView((s) => s?.summary?.pinnedTurns)
  const feedbackActive = useFeedbackStore((s) => s.active)

  // 大会话首屏只带尾部消息：轮次大纲单独拉轻量索引，不为了刻度拉全量历史。
  useEffect(() => {
    if (!hostId || !sessionId || !hasEarlier || serverTurns || loadingTurns) return
    void useAppStore.getState().loadSessionTurns(hostId, sessionId)
  }, [hostId, sessionId, hasEarlier, serverTurns, loadingTurns])
  const sceneTurns = useMemo(() => {
    const levels = heatLevels(weights)
    const pinned = new Set(pinnedTurns ?? [])
    return turns.map((turn, index) => ({
      ...turn,
      heat: levels[index] ?? 1,
      share: totalWeight > 0 ? Math.round((turnWeight(turn.usage, metric) / totalWeight) * 100) : 0,
      ...(pinned.has(turn.id) && !turn.summary && !turn.compressed ? { pinned: true } : {}),
    }))
  }, [turns, weights, pinnedTurns, totalWeight, metric])
  const total = turns.length
  const realTotal = useMemo(() => turns.filter((turn) => !turn.summary).length, [turns])
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
  const hoverTipRef = useRef<number | null>(null)
  const hoverSyncRef = useRef<(turn: number | null) => void>(() => {})
  const pinHeadRef = useRef<HTMLSpanElement>(null)
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
      const root = scrollRef.current
      const mark = turnsRef.current[target - 1]
      const targetId = mark?.jumpId ?? mark?.id
      if (root && mark && targetId && hostId && sessionId) {
        const state = useAppStore.getState()
        const view = state.sessionViews[`${hostId}:${sessionId}`]
        const loaded = view?.messages.some((message) => message.id === targetId) ?? true
        const rendered = root.querySelector<HTMLElement>(
          `[data-turn-id="${CSS.escape(targetId)}"]`,
        )
        if (!loaded) {
          // 目标轮不在首屏尾部：按需取该段，挂载后再重新定位。
          window.dispatchEvent(
            new CustomEvent('tandem-jump-message', { detail: { messageId: targetId } }),
          )
          void (async () => {
            for (let attempt = 0; attempt < 40; attempt++) {
              const ok = await state.ensureMessageLoaded(hostId, sessionId, targetId)
              if (ok) {
                window.dispatchEvent(
                  new CustomEvent('tandem-jump-message', { detail: { messageId: targetId } }),
                )
                window.setTimeout(() => goRef.current(target, { recenter: false, instant: true }), 140)
                return
              }
              await new Promise((resolve) => window.setTimeout(resolve, 220))
            }
          })()
          return
        }
        if (!rendered && target !== 1 && target !== totalRef.current) {
          // 已在消息数组里但被渲染窗口裁掉：让消息列表扩大窗口并滚过去。
          window.dispatchEvent(
            new CustomEvent('tandem-jump-message', { detail: { messageId: targetId } }),
          )
          return
        }
      }
      followerRef.current?.to(() => {
        const rootEl = scrollRef.current
        const turnMark = turnsRef.current[target - 1]
        const jumpId = turnMark?.jumpId ?? turnMark?.id
        if (!rootEl || !jumpId) return null
        if (target === 1) return 0
        if (target === totalRef.current) {
          return Math.max(0, rootEl.scrollHeight - rootEl.clientHeight)
        }
        const el = rootEl.querySelector<HTMLElement>(
          `[data-turn-id="${CSS.escape(jumpId)}"]`,
        )
        if (!el) return null
        return Math.max(
          0,
          el.getBoundingClientRect().top - rootEl.getBoundingClientRect().top + rootEl.scrollTop - 16,
        )
      }, opts?.instant)
      const scene = sceneRef.current
      scene?.setActive(target)
      if (opts?.recenter !== false) scene?.setCenter(target)
    },
    [scrollRef, hostId, sessionId],
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
    const scene = new RailScene({
      root,
      bg,
      ind,
      cur,
      items,
      pinHead: pinHeadRef.current,
    })
    sceneRef.current = scene
    scene.onDragRow = (turn) => goRef.current(turn, { recenter: false })
    scene.onHoverTurn = (turn) => hoverSyncRef.current(turn)
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
    if (isTargetFocused(scopeTarget)) {
      useTurnNavStore.getState().setProgress(activeTurn, total)
    }
  }, [activeTurn, total, railOn, sessionId, scopeTarget])

  useEffect(
    () => () => {
      if (isTargetFocused(scopeTarget)) {
        useTurnNavStore.setState({ total: 0, active: 1, sheetOpen: false })
      }
    },
    [scopeTarget],
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
      if (!isTargetFocused(scopeTarget)) return
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
  }, [go, scopeTarget])

  const closePanel = useCallback(() => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    openTimer.current = 0
    closeTimer.current = 0
    hideTooltip()
    hoverTipRef.current = null
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

  /** 反馈6#01：悬停大纲行时用标准 tooltip 显示该轮用量，不再重复文字。 */
  const syncHoverTip = (turn: number | null) => {
    if (turn === hoverTipRef.current) return
    hoverTipRef.current = turn
    if (turn == null) {
      hideTooltip()
      return
    }
    const mark = turnsRef.current[turn - 1]
    const label = turnUsageLabel(mark?.usage, {
      share: shareOf(mark),
      ...(mark?.compressed ? { compressed: true } : {}),
      ...(mark?.summary ? { summary: true } : {}),
    })
    if (!label) {
      hideTooltip()
      return
    }
    const row = itemRefs.current.find((el) => el?.dataset.turnPos === String(turn))
    if (row) scheduleTooltip(row, label)
    else hideTooltip()
  }
  hoverSyncRef.current = syncHoverTip

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
    const y = pointerY(event)
    scene.setPointer(y)
    if (event.pointerType !== 'touch') scene.setHoverEnabled(true)
    syncHoverTip(scene.hoverTurn)
  }

  const onPointerLeave = (event: ReactPointerEvent<HTMLElement>) => {
    window.clearTimeout(openTimer.current)
    openTimer.current = 0
    if (dragRef.current || useFeedbackStore.getState().active) return
    hideTooltip()
    hoverTipRef.current = null
    // 指针移到行尾图钉等面板内元素时，hit 也会收到 pointerleave，不应收起。
    // relatedTarget 可能是 Window（离开文档/浮层卸载），不能直接 contains。
    if (nodeContains(navRef.current, event.relatedTarget)) return
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
  const currentHeat = sceneTurns[activeTurn - 1]?.heat ?? 1
  const metricLabel = metric === 'cost' ? '花费' : '上下文'
  const chooseMetric = (next: TurnHeatMetric) => {
    setMetric(next)
    try {
      localStorage.setItem('tandem.turnHeatMetric.v1', next)
    } catch {
      // localStorage 不可用时仅本次会话有效
    }
  }

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
                <span className="turn-item-c" />
              </div>
            ))}
          </div>
          <span ref={pinHeadRef} className="turn-pin-head" aria-hidden>
            已固定
          </span>
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
            aria-valuetext={
              current?.summary
                ? `摘要 · ${heatLabel(currentHeat)}`
                : `第 ${current?.no ?? activeTurn} / ${realTotal} 轮${current ? ` · ${current.full}` : ''} · ${heatLabel(currentHeat)}`
            }
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
          <ol className="sr-only" data-testid="turn-readout" aria-label="轮次大纲全文">
            {turns.map((mark) => {
              const heat = sceneTurns[mark.turn - 1]?.heat ?? 1
              return (
                <li key={`${mark.turn}:${mark.id}`}>
                  {mark.summary
                    ? `摘要（${heatLabel(heat)}）`
                    : `第 ${mark.no ?? mark.turn} 轮：${mark.full}（${heatLabel(heat)}）`}
                </li>
              )
            })}
          </ol>
          <div className="turn-metric" role="group" aria-label="大纲着色依据">
            <button
              type="button"
              aria-pressed={metric === 'cost'}
              data-on={metric === 'cost' ? 'true' : undefined}
              onClick={() => chooseMetric('cost')}
            >
              花费
            </button>
            <button
              type="button"
              aria-pressed={metric === 'context'}
              data-on={metric === 'context' ? 'true' : undefined}
              onClick={() => chooseMetric('context')}
            >
              上下文
            </button>
          </div>
          <span className="turn-count" aria-hidden>
            {current?.summary
              ? `摘要 · ${metricLabel} ${heatLabel(currentHeat)}`
              : `第 ${current?.no ?? activeTurn} / ${realTotal} 轮`}
          </span>
        </nav>
      )}
      {isMobile && (
        <TurnOutlineSheet
          open={sheetOpen && total >= 2}
          turns={sceneTurns}
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
