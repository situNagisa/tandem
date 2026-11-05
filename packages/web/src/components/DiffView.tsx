import { useMemo } from 'react'
import { diffLines } from 'diff'
import { cn } from '../lib/cn'

interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}

const MAX_ROWS = 1600
const MAX_INPUT = 200_000

export function DiffView({
  oldText,
  newText,
  fileName,
  oldLabel,
  newLabel,
}: {
  oldText: string
  newText: string
  fileName?: string
  oldLabel?: string
  newLabel?: string
}) {
  const { rows, truncated, added, removed } = useMemo(() => {
    const oldSafe = oldText.length > MAX_INPUT ? oldText.slice(0, MAX_INPUT) : oldText
    const newSafe = newText.length > MAX_INPUT ? newText.slice(0, MAX_INPUT) : newText
    const changes = diffLines(oldSafe, newSafe)
    const all: DiffLine[] = []
    let oldNo = 1
    let newNo = 1
    let added = 0
    let removed = 0
    for (const change of changes) {
      const lines = change.value.split('\n')
      if (lines.length && lines[lines.length - 1] === '') lines.pop()
      for (const line of lines) {
        if (change.added) {
          all.push({ type: 'add', text: line, newNo })
          newNo++
          added++
        } else if (change.removed) {
          all.push({ type: 'del', text: line, oldNo })
          oldNo++
          removed++
        } else {
          all.push({ type: 'ctx', text: line, oldNo, newNo })
          oldNo++
          newNo++
        }
      }
    }
    return {
      rows: all.slice(0, MAX_ROWS),
      truncated: all.length > MAX_ROWS,
      added,
      removed,
    }
  }, [oldText, newText])

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex h-8 items-center gap-2 border-b border-border/80 bg-surface-2/40 px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-soft">
          {fileName || '改动'}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-success">+{added}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-danger">−{removed}</span>
      </div>
      <div className="max-h-[440px] overflow-auto bg-surface-2/20 font-mono text-[11.5px] leading-[1.6]">
        <div className="min-w-full w-max">
          {rows.length === 0 && (
            <div className="px-3 py-3 italic text-muted">没有差异</div>
          )}
          {rows.map((row, i) => (
            <div
              key={i}
              className={cn(
                'flex whitespace-pre',
                row.type === 'add' && 'bg-[var(--t-add-bg)] text-[var(--t-add-fg)]',
                row.type === 'del' && 'bg-[var(--t-del-bg)] text-[var(--t-del-fg)]',
                row.type === 'ctx' && 'text-text-soft',
              )}
            >
              <span className="w-10 shrink-0 select-none border-r border-border/40 px-1.5 text-right text-[10px] leading-[1.6] text-muted/70">
                {row.oldNo ?? ''}
              </span>
              <span className="w-10 shrink-0 select-none border-r border-border/40 px-1.5 text-right text-[10px] leading-[1.6] text-muted/70">
                {row.newNo ?? ''}
              </span>
              <span className="w-5 shrink-0 select-none text-center opacity-70">
                {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}
              </span>
              <span className="pr-3">{row.text || ' '}</span>
            </div>
          ))}
        </div>
        {truncated && (
          <div className="border-t border-border/60 px-3 py-1.5 text-[11px] text-muted">
            差异过长，仅显示前 {MAX_ROWS} 行
          </div>
        )}
      </div>
      {(oldLabel || newLabel) && (
        <div className="flex gap-3 border-t border-border/60 px-3 py-1 text-[10px] text-muted">
          {oldLabel && <span>旧：{oldLabel}</span>}
          {newLabel && <span>新：{newLabel}</span>}
        </div>
      )}
    </div>
  )
}
