import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { visibleTurnRange } from '../../lib/turnWindow'
import type { TurnMark } from './TurnRail'

const ROW_H = 52
const OVERSCAN = 6

/** 手机端轮次大纲：底部抽屉 + 定高行虚拟化，打开时以当前轮居中。 */
export function TurnOutlineSheet({
  open,
  turns,
  active,
  onClose,
  onPick,
}: {
  open: boolean
  turns: TurnMark[]
  active: number
  onClose: () => void
  onPick: (turn: number) => void
}) {
  const [mounted, setMounted] = useState(open)
  const [leaving, setLeaving] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 16 })
  const frame = useRef(0)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setLeaving(false)
      return
    }
    if (!mounted) return
    setLeaving(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setLeaving(false)
    }, 170)
    return () => window.clearTimeout(timer)
  }, [open, mounted])

  const measure = useCallback(() => {
    const el = listRef.current
    if (!el) return
    const next = visibleTurnRange(el.scrollTop, el.clientHeight, turns.length, ROW_H, OVERSCAN)
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [turns.length])

  useLayoutEffect(() => {
    if (!mounted || !open) return
    const el = listRef.current
    if (!el) return
    el.scrollTop = Math.max(0, (active - 1) * ROW_H - el.clientHeight / 2 + ROW_H / 2)
    measure()
    // 只在打开时居中；之后用户自己滚
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  if (!mounted) return null

  const rows = turns.slice(range.start, range.end)
  const realTotal = turns.filter((turn) => !turn.summary).length
  const activeMark = turns[active - 1]
  return createPortal(
    <div className="turn-sheet-root md:hidden" data-leaving={leaving ? 'true' : undefined}>
      <div className="turn-sheet-backdrop" onClick={onClose} />
      <div className="turn-sheet" role="dialog" aria-modal="true" aria-label="轮次大纲">
        <div className="turn-sheet-head">
          <span className="tabular-nums">
            {activeMark?.summary
              ? '轮次大纲 · 摘要'
              : `轮次大纲 · 第 ${activeMark?.no ?? active} / ${realTotal} 轮`}
          </span>
          <button data-raw-button type="button" className="turn-sheet-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div
          ref={listRef}
          className="turn-sheet-list"
          onScroll={() => {
            cancelAnimationFrame(frame.current)
            frame.current = requestAnimationFrame(measure)
          }}
        >
          <div style={{ height: turns.length * ROW_H, position: 'relative' }}>
            {rows.map((mark) => (
              <button data-raw-button
                key={mark.id}
                type="button"
                className="turn-sheet-row"
                data-active={mark.turn === active ? 'true' : undefined}
                data-heat={mark.heat ?? 1}
                data-summary={mark.summary ? 'true' : undefined}
                data-compressed={mark.compressed ? 'true' : undefined}
                style={{ transform: `translateY(${(mark.turn - 1) * ROW_H}px)`, height: ROW_H }}
                onClick={() => onPick(mark.turn)}
              >
                <span className="turn-sheet-num">{mark.summary ? '摘' : (mark.no ?? mark.turn)}</span>
                <span className="turn-sheet-text" data-tip={mark.full}>
                  {mark.summary ? '摘要' : mark.full}
                  {mark.compressed ? ' · 已压缩' : ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
