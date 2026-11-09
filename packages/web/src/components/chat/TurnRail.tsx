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
import { isMacPlatform } from '../../lib/format'
import {
  heatLabel,
  heatLevels,
  summaryUsage,
  turnUsageLabel,
  turnWeight,
  usageByTurn,
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
export function useTurnMarks(
  messagesOverride?: UiMessage[],
  sessionIdOverride?: string | null,
): TurnMark[] {
  const storeMessages = useSessionView((view) => view?.messages ?? EMPTY_MESSAGES)
  const messages = messagesOverride ?? storeMessages
  const external = messagesOverride !== undefined
  const serverTurns = useSessionView((view) => view?.turns)
  const subagents = useSessionView((view) => view?.subagents)
  const storeSessionId = useSessionView((view) => view?.sessionId)
  const sessionId = sessionIdOverride !== undefined ? sessionIdOverride : storeSessionId
  const hostId = useSessionView((view) => view?.hostId ?? null)
  const notice = external ? undefined : messages.find((message) => message.compaction?.canUndo)
  const noticeId = notice?.id ?? null
  const [backup, setBackup] = useState<{ noticeId: string; turns: TurnMark[] } | null>(null)

  // 压缩原文里保留着被压掉的轮次：取回来作为最浅的「已压缩」刻度，摘要另起一行。
  useEffect(() => {
    if (external || !hostId || !sessionId || !noticeId) {
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
  }, [external, hostId, sessionId, noticeId])

  return useMemo(() => {
    const usage = usageByTurn(messages, external ? undefined : subagents, sessionId ?? undefined)
    const local = withUsage(marksFromMessages(messages), messages, usage, {
      ...(noticeId ? { jumpId: noticeId } : {}),
    })
    const compressed = backup?.noticeId === noticeId ? backup.turns : []
    let base: TurnMark[]
    if (external || !serverTurns?.length) {
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
  }, [messages, external, serverTurns, subagents, sessionId, backup, noticeId])
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
  messages,
  readOnly = false,
  alwaysActive = false,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  sessionId: string | null
  onBeforeJump?: () => void
  /** 传入时用这份消息（外部会话只读预览），不读当前活动会话。 */
  messages?: UiMessage[]
  /** 只读：不提供固定/取消固定（外部会话原文件不能改）。 */
  readOnly?: boolean
  /** 当前页面不是活动会话（如外部会话页）时也让 Alt+↑/↓ 生效。 */
  alwaysActive?: boolean
}) {
  const external = messages !== undefined
  const turns = useTurnMarks(external ? messages : undefined, external ? sessionId : undefined)
  // 反馈8#07：着色固定表示上下文占用，不再提供「花费 / 上下文」切换。
  const weights = useMemo(() => turns.map((turn) => turnWeight(turn.usage)), [turns])
  const totalWeight = useMemo(() => weights.reduce((sum, value) => sum + value, 0), [weights])
  const shareOf = (mark: TurnMark | undefined): number => {
    if (!mark || totalWeight <= 0) return 0
    return Math.round((turnWeight(mark.usage) / totalWeight) * 100)
  }
  const scopeTarget = useSessionTarget()
  const storeHostId = useSessionView((s) => s?.hostId ?? null)
  const hostId = external ? null : storeHostId
  const hasEarlier = useSessionView((s) => s?.hasEarlier ?? false)
  const serverTurns = useSessionView((s) => s?.turns)
  const loadingTurns = useSessionView((s) => s?.loadingTurns ?? false)
  const pinnedTurns = useSessionView((s) => (readOnly ? undefined : s?.summary?.pinnedTurns))
  const feedbackActive = useFeedbackStore((s) => s.active)

  // 大会话首屏只带尾部消息：轮次大纲单独拉轻量索引，不为了刻度拉全量历史。
  useEffect(() => {
    if (external || !hostId || !sessionId || !hasEarlier || serverTurns || loadingTurns) return
    void useAppStore.getState().loadSessionTurns(hostId, sessionId)
  }, [external, hostId, sessionId, hasEarlier, serverTurns, loadingTurns])
  // 反馈8#04：不再有独立的「已固定」浮层；固定的轮按轮号排序列出，供 Alt/点击切换的仅固定视图使用。
  const pinnedMarks = useMemo(() => {
    const pinned = new Set(pinnedTurns ?? [])
    return turns
      .filter((turn) => pinned.has(turn.id) && !turn.summary && !turn.compressed)
      .sort((a, b) => (a.no ?? 0) - (b.no ?? 0))
  }, [turns, pinnedTurns])
  const sceneTurns = useMemo(() => {
    const levels = heatLevels(weights)
    const pinned = new Set(pinnedTurns ?? [])
    return turns.map((turn, index) => ({
      ...turn,
      heat: levels[index] ?? 1,
      share: totalWeight > 0 ? Math.round((turnWeight(turn.usage) / totalWeight) * 100) : 0,
      ...(pinned.has(turn.id) && !turn.summary && !turn.compressed ? { pinned: true } : {}),
      ...(external || readOnly ? { readOnly: true, hideUnknownCost: true } : {}),
    }))
  }, [turns, weights, pinnedTurns, totalWeight, external, readOnly])
  const total = turns.length
  const realTotal = useMemo(() => turns.filter((turn) => !turn.summary).length, [turns])
  const isMobile = useIsMobile()
  const railOn = total >= 2 && !isMobile
  const [activeTurn, setActiveTurn] = useState(1)
  const [open, setOpen] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [pinnedVia, setPinnedVia] = useState<'alt' | 'click'>('alt')
  const pinnedView = pinnedOnly && pinnedMarks.length > 0
  const viewTurns = useMemo(() => {
    if (!pinnedView) return sceneTurns
    const pinned = new Set(pinnedMarks.map((mark) => mark.id))
    return sceneTurns.filter((turn) => pinned.has(turn.id))
  }, [sceneTurns, pinnedView, pinnedMarks])

  const navRef = useRef<HTMLElement>(null)
  const bgRef = useRef<HTMLDivElement>(null)
  const indRef = useRef<HTMLDivElement>(null)
  const curRef = useRef<HTMLDivElement>(null)
  const hitRef = useRef<HTMLDivElement>(null)
  const hoverTipRef = useRef<number | null>(null)
  const hoverSyncRef = useRef<(turn: number | null) => void>(() => {})
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const sceneRef = useRef<RailScene | null>(null)
  const followerRef = useRef<ScrollFollower | null>(null)

  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const viewTurnsRef = useRef(viewTurns)
  viewTurnsRef.current = viewTurns
  const sceneTurnsRef = useRef(viewTurns)
  sceneTurnsRef.current = viewTurns
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
  // 「只看已固定」切换会改变面板高度，指针没动也会收到 pointerleave；
  // 用短暂守卫区分布局变化与真正移出，避免面板跟着收起。
  const shiftGuard = useRef(0)
  const shiftTimer = useRef(0)

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

  // 视图位置（仅固定视图时是 1..pinned.length）与真实轮次位置（1..total）互转。
  const viewPosOf = (original: number): number => {
    const index = viewTurnsRef.current.findIndex((turn) => turn.turn === original)
    return index >= 0 ? index + 1 : 0
  }
  const originalOf = (pos: number): number => viewTurnsRef.current[pos - 1]?.turn ?? pos

  const jumpSeq = useRef(0)

  /** 目标轮已经在 DOM 里：滚动到它并高亮 2.8s。 */
  const revealTurn = (rootEl: HTMLElement, id: string): boolean => {
    const el = rootEl.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`)
    if (!el) return false
    const top = Math.max(
      0,
      el.getBoundingClientRect().top - rootEl.getBoundingClientRect().top + rootEl.scrollTop - 16,
    )
    rootEl.scrollTop = top
    const row = el.closest<HTMLElement>('.msg-row') ?? el
    row.classList.remove('msg-jump-hit')
    void row.offsetWidth
    row.classList.add('msg-jump-hit')
    window.setTimeout(() => row.classList.remove('msg-jump-hit'), 2800)
    return true
  }

  const go = useCallback(
    (turn: number, opts?: { recenter?: boolean; instant?: boolean }) => {
      const count = totalRef.current
      if (count < 1) return
      const target = clamp(Math.round(turn), 1, count)
      const seq = ++jumpSeq.current
      activeRef.current = target
      setActiveTurn(target)
      sticky.current = true
      beforeJumpRef.current?.()
      const root = scrollRef.current
      const mark = turnsRef.current[target - 1]
      const targetId = mark?.jumpId ?? mark?.id
      if (root && mark && targetId && !external && hostId && sessionId) {
        const state = useAppStore.getState()
        const view = state.sessionViews[`${hostId}:${sessionId}`]
        const loaded = view?.messages.some((message) => message.id === targetId) ?? true
        const rendered = root.querySelector<HTMLElement>(
          `[data-turn-id="${CSS.escape(targetId)}"]`,
        )
        if (!loaded || (!rendered && target !== totalRef.current)) {
          // 目标轮还没加载（长会话懒加载）或被渲染窗口裁掉：先让消息列表取该段并扩大窗口，
          // 等节点真正挂载后再滚动 + 高亮，不能出现「点了没反应」（反馈10#01）。
          window.dispatchEvent(
            new CustomEvent('tandem-jump-message', { detail: { messageId: targetId } }),
          )
          void (async () => {
            if (!loaded) {
              for (let attempt = 0; attempt < 50; attempt++) {
                if (seq !== jumpSeq.current) return
                if (await state.ensureMessageLoaded(hostId, sessionId, targetId)) break
                await new Promise((resolve) => window.setTimeout(resolve, 200))
              }
              if (seq !== jumpSeq.current) return
              // 消息到达后让 MessageList 再扩一次渲染窗口。
              window.dispatchEvent(
                new CustomEvent('tandem-jump-message', { detail: { messageId: targetId } }),
              )
            }
            for (let attempt = 0; attempt < 100; attempt++) {
              if (seq !== jumpSeq.current) return
              const rootEl = scrollRef.current
              if (rootEl && revealTurn(rootEl, targetId)) {
                const scene = sceneRef.current
                const viewPos = viewPosOf(target)
                if (viewPos > 0) {
                  scene?.setActive(viewPos)
                  scene?.setCenter(viewPos)
                }
                return
              }
              await new Promise((resolve) => window.setTimeout(resolve, 80))
            }
            if (seq !== jumpSeq.current) return
            // 定位到首尾两轮之外仍失败时至少给出反馈，而不是静默。
            useUiStore.getState().toast('这一轮的消息暂时加载失败，请稍后重试', 'error')
          })()
          const scene = sceneRef.current
          const earlyPos = viewPosOf(target)
          if (earlyPos > 0) scene?.setActive(earlyPos)
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
      const viewPos = viewPosOf(target)
      if (viewPos > 0) {
        scene?.setActive(viewPos)
        if (opts?.recenter !== false) scene?.setCenter(viewPos)
      }
    },
    [scrollRef, external, hostId, sessionId],
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
    })
    sceneRef.current = scene
    scene.onDragRow = (turn) => goRef.current(originalOf(turn), { recenter: false })
    scene.onHoverTurn = (turn) => hoverSyncRef.current(turn)
    scene.setData(viewTurnsRef.current, viewTurnsRef.current.length)
    const viewPos = viewTurnsRef.current.findIndex((turn) => turn.turn === activeRef.current) + 1
    scene.setActive(viewPos || 1, true)
    scene.setCenter(viewPos || 1, true)
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
    sceneRef.current?.setData(viewTurns, pinnedView ? viewTurns.length : total)
  }, [viewTurns, total, pinnedView])

  useLayoutEffect(() => {
    shiftGuard.current = 1
    window.clearTimeout(shiftTimer.current)
    shiftTimer.current = window.setTimeout(() => {
      shiftGuard.current = 0
    }, 280)
    return () => window.clearTimeout(shiftTimer.current)
  }, [pinnedView])

  useEffect(() => {
    activeRef.current = activeTurn
    const scene = sceneRef.current
    if (scene) {
      const viewPos = viewTurnsRef.current.findIndex((turn) => turn.turn === activeTurn) + 1
      // 当前轮不在「仅看已固定」里时不画当前轮指示，避免指到不存在的行。
      if (viewPos > 0) {
        scene.setActive(viewPos, snapNext.current)
        if (!dragRef.current) scene.setCenter(viewPos, snapNext.current)
      }
    }
    snapNext.current = false
    if (external) return
    if (isTargetFocused(scopeTarget)) {
      useTurnNavStore.getState().setProgress(activeTurn, total)
    }
  }, [activeTurn, total, railOn, sessionId, scopeTarget, pinnedView, external])

  useEffect(
    () => () => {
      if (!external && isTargetFocused(scopeTarget)) {
        useTurnNavStore.setState({ total: 0, active: 1, sheetOpen: false })
      }
    },
    [scopeTarget, external],
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
      if (!alwaysActive && !isTargetFocused(scopeTarget)) return
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      // 输入框获得焦点时也允许用 Alt+↑/↓ 翻轮；只排除消息编辑等其他输入区域。
      if (typing && !target?.closest('.composer-card')) return
      const ui = useUiStore.getState()
      if (ui.settingsOpen || ui.newSessionOpen || ui.searchOpen || ui.mobileSidebar) return
      const list = viewTurnsRef.current
      if (list.length === 0) return
      event.preventDefault()
      const down = event.key === 'ArrowDown'
      const currentPos = viewPosOf(activeRef.current) || (down ? 0 : list.length + 1)
      const nextPos = clamp(currentPos + (down ? 1 : -1), 1, list.length)
      if (nextPos !== currentPos) go(originalOf(nextPos))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [go, scopeTarget, alwaysActive])

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

  // 守卫期内指针真的移出大纲（有 pointermove 事件才算），立即收起。
  useEffect(() => {
    if (!open) return
    const onMove = (event: PointerEvent) => {
      if (!shiftGuard.current) return
      const target = document.elementFromPoint(event.clientX, event.clientY)
      const nav = navRef.current
      if (nav && target && nav.contains(target)) return
      shiftGuard.current = 0
      closePanel()
    }
    document.addEventListener('pointermove', onMove, { passive: true })
    return () => document.removeEventListener('pointermove', onMove)
  }, [open, closePanel])

  // 退出反馈模式后，如果指针早已不在大纲上，补一次收起（反馈模式的捕获层不会触发 pointerleave）。
  useEffect(() => {
    if (feedbackActive || !open) return
    const timer = window.setTimeout(() => {
      if (!dragRef.current && !navRef.current?.matches(':hover')) closePanel()
    }, 300)
    return () => window.clearTimeout(timer)
  }, [feedbackActive, open, closePanel])

  // 滚轮 = 预览式滚动大纲列表：不改变当前选中轮、不滚动对话区（反馈10#01）。
  // 点某一行才跳转；滚轮看完早期轮次不会被自动带离当前阅读位置。
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
      const scene = sceneRef.current
      if (!scene) return
      if (!scene.open) openPanel()
      scene.scrollBy(clamp(steps, -4, 4))
      // 列表移动后指针下的行变了：让悬停用量 tooltip 跟上（不触发跳转）。
      hoverSyncRef.current(scene.hoverTurn)
    }
    hit.addEventListener('wheel', onWheel, { passive: false })
    return () => hit.removeEventListener('wheel', onWheel)
  }, [railOn, go, openPanel])

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
    const mark = viewTurnsRef.current[turn - 1]
    const label = turnUsageLabel(mark?.usage, {
      share: shareOf(mark),
      ...(mark?.compressed ? { compressed: true } : {}),
      ...(mark?.summary ? { summary: true } : {}),
      ...(external || readOnly ? { hideUnknownCost: true } : {}),
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
    // 面板刚因「只看已固定」收缩/展开：这时的 pointerleave 是布局变化造成的，等真实的指针移动再判断。
    if (shiftGuard.current) return
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
    go(originalOf(scene.rowAt(y)), { recenter: false })
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
    const count = viewTurnsRef.current.length
    const current = viewPosOf(activeRef.current) || 1
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
    if (next == null || event.altKey || count === 0) return
    event.preventDefault()
    event.stopPropagation()
    sceneRef.current?.setHoverEnabled(false)
    go(originalOf(clamp(next, 1, count)))
  }

  const sheetOpen = useTurnNavStore((s) => s.sheetOpen)
  const setSheetOpen = useTurnNavStore((s) => s.setSheetOpen)
  useEffect(() => {
    if (!isMobile && useTurnNavStore.getState().sheetOpen) setSheetOpen(false)
  }, [isMobile, setSheetOpen])

  const togglePinnedTurn = (messageId: string) => {
    if (!messageId || external || readOnly) return
    const state = useAppStore.getState()
    const active = state.active
    if (!active?.summary) return
    const current = active.summary.pinnedTurns ?? []
    const next = current.includes(messageId)
      ? current.filter((id) => id !== messageId)
      : [...current, messageId]
    void state.updateSession(active.hostId, active.sessionId, { pinnedTurns: next })
  }

  // 反馈8#04：按住 Alt / 点下方提示，同一个大纲切换为「只看已固定」，松开 / 再点恢复全部。
  const altHeldRef = useRef(false)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Alt' ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.repeat ||
        event.isComposing
      ) {
        return
      }
      // 输入框聚焦时也响应：单独按 Alt/Option 不会输入字符（Option+字符的 key 不是 Alt）。
      event.preventDefault()
      altHeldRef.current = true
      setPinnedVia('alt')
      setPinnedOnly(true)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') return
      altHeldRef.current = false
      setPinnedOnly(false)
    }
    const onBlur = () => {
      if (!altHeldRef.current) return
      altHeldRef.current = false
      setPinnedOnly(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // 切换视图后旧行号可能失效，先收起用量 tooltip。
  useEffect(() => {
    hideTooltip()
    hoverTipRef.current = null
  }, [pinnedView])

  const togglePinnedView = () => {
    if (pinnedMarks.length === 0) return
    altHeldRef.current = false
    setPinnedVia('click')
    setPinnedOnly((value) => !value)
  }

  const currentPos = viewPosOf(activeTurn) || 1
  const current = viewTurns[currentPos - 1] ?? turns[activeTurn - 1]
  const currentHeat = current?.heat ?? 1
  const altName = isMacPlatform ? 'Option' : 'Alt'
  const pinnedHint = pinnedView
    ? pinnedVia === 'alt'
      ? `已固定 ${pinnedMarks.length} 轮 · 松开 ${altName} 恢复全部`
      : `已固定 ${pinnedMarks.length} 轮 · 点此恢复全部`
    : `按住 ${altName} 只看已固定${pinnedMarks.length > 0 ? `（${pinnedMarks.length}）` : '（暂无）'}`

  return (
    <>
      {railOn && (
        <nav
          ref={navRef}
          className="turn-rail"
          aria-label="轮次导航"
          data-open={open ? 'true' : undefined}
          data-pressed={pressed ? 'true' : undefined}
          data-pinned-only={pinnedView ? 'true' : undefined}
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
          <div
            ref={hitRef}
            className="turn-hit"
            role="slider"
            tabIndex={0}
            aria-label="切换轮次"
            aria-orientation="vertical"
            aria-valuemin={1}
            aria-valuemax={viewTurns.length}
            aria-valuenow={currentPos}
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
          <span className="turn-count" aria-hidden>
            {pinnedView
              ? `仅看已固定 · ${pinnedMarks.length} 轮`
              : current?.summary
                ? `摘要 · ${heatLabel(currentHeat)}`
                : `第 ${current?.no ?? activeTurn} / ${realTotal} 轮`}
          </span>
          {open && (
            <button
              type="button"
              className="turn-hint"
              data-testid="turn-pinned-hint"
              data-on={pinnedView ? 'true' : undefined}
              aria-pressed={pinnedView}
              onClick={togglePinnedView}
              onPointerEnter={() => {
                window.clearTimeout(closeTimer.current)
                closeTimer.current = 0
              }}
              onPointerLeave={onPointerLeave}
            >
              {pinnedHint}
            </button>
          )}
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
