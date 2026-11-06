import { useEffect, useMemo, useState, type RefObject } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import type { UiMessage } from '../../lib/types'

export interface TurnMark {
  id: string
  /** 1-based 轮次序号 */
  turn: number
  /** 用户消息在完整消息数组里的位置比例，用于刻度定位（不依赖实测高度）。 */
  ratio: number
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
  const total = Math.max(1, messages.length - 1)
  messages.forEach((message, index) => {
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
      ratio: index / total,
      preview: text.length > 40 ? `${text.slice(0, 40)}…` : text,
    })
  })
  const same =
    next.length === cachedTurns.length &&
    next.every(
      (mark, i) =>
        mark.id === cachedTurns[i].id &&
        mark.ratio === cachedTurns[i].ratio &&
        mark.preview === cachedTurns[i].preview,
    )
  cachedMessages = messages
  if (same) return cachedTurns
  cachedTurns = next
  return next
}

function useTurnMarks(): TurnMark[] {
  return useAppStore(selectTurns)
}

interface Bucket {
  key: string
  from: number
  to: number
  ratio: number
  preview: string
  id: string
}

const MAX_TICKS = 64

function makeBuckets(turns: TurnMark[]): Bucket[] {
  if (turns.length <= MAX_TICKS) {
    return turns.map((mark) => ({
      key: mark.id,
      from: mark.turn,
      to: mark.turn,
      ratio: mark.ratio,
      preview: mark.preview,
      id: mark.id,
    }))
  }
  const size = Math.ceil(turns.length / MAX_TICKS)
  const buckets: Bucket[] = []
  for (let i = 0; i < turns.length; i += size) {
    const group = turns.slice(i, i + size)
    const last = group[group.length - 1]
    buckets.push({
      key: group[0].id,
      from: group[0].turn,
      to: last.turn,
      ratio: (group[0].ratio + last.ratio) / 2,
      preview: group[0].preview,
      id: group[0].id,
    })
  }
  return buckets
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
  const buckets = useMemo(() => makeBuckets(turns), [turns])
  const [activeTurn, setActiveTurn] = useState(1)

  useEffect(() => {
    setActiveTurn(turns.length || 1)
  }, [sessionId, turns.length])

  useEffect(() => {
    const root = scrollRef.current
    if (!root || turns.length === 0) return
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
              if (shown.length) setActiveTurn(Math.min(...shown) + 1)
            },
            { root, rootMargin: '0px 0px -85% 0px', threshold: 0 },
          )
        : null
    if (io) for (const node of nodes) io.observe(node)

    const onScroll = () => {
      const distance = root.scrollHeight - root.scrollTop - root.clientHeight
      if (distance < 40) setActiveTurn(turns.length)
      else if (root.scrollTop < 40) setActiveTurn(1)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      io?.disconnect()
      root.removeEventListener('scroll', onScroll)
    }
  }, [scrollRef, turns, sessionId])

  const jump = (mark: Bucket) => {
    const root = scrollRef.current
    if (!root) return
    setActiveTurn(mark.from)
    onBeforeJump?.()
    const el = root.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(mark.id)}"]`)
    if (!el) return
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 16
    root.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const target = e.target as HTMLElement | null
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
      if (turns.length === 0) return
      e.preventDefault()
      const current = Math.min(turns.length, Math.max(1, activeTurn))
      const next = Math.min(turns.length, Math.max(1, current + (e.key === 'ArrowDown' ? 1 : -1)))
      const mark = turns[next - 1]
      const bucket = buckets.find((b) => mark.turn >= b.from && mark.turn <= b.to) ?? buckets[0]
      if (bucket) jump(bucket)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  if (turns.length < 2) return null

  const activeBucket = buckets.findIndex(
    (bucket) => activeTurn >= bucket.from && activeTurn <= bucket.to,
  )

  return (
    <nav className="turn-rail" aria-label="轮次导航">
      <div className="turn-rail-track">
        {buckets.map((bucket, i) => {
          const active = i === activeBucket
          const label =
            bucket.from === bucket.to
              ? `第 ${bucket.from} 轮 · ${bucket.preview}`
              : `第 ${bucket.from}–${bucket.to} 轮 · ${bucket.preview}`
          return (
            <button
              key={bucket.key}
              type="button"
              onClick={() => jump(bucket)}
              data-active={active ? 'true' : undefined}
              aria-label={`跳转到${label}`}
              aria-current={active ? 'true' : undefined}
              className="turn-tick"
              style={{ top: `${bucket.ratio * 100}%` }}
            >
              <span className="turn-tick-line" />
              <span className="turn-tip" role="tooltip">
                {label}
              </span>
            </button>
          )
        })}
      </div>
      <span className="turn-rail-count" aria-hidden>
        {activeTurn}/{turns.length}
      </span>
    </nav>
  )
}
