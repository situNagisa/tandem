import { Fragment, memo, useMemo, useState, type ReactNode } from 'react'
import { diffLines } from 'diff'
import { ArrowLeftRight, ChevronsUpDown } from 'lucide-react'
import { cn } from '../lib/cn'
import { useHorizontalOverflow } from '../lib/hooks'

interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffLineInfo {
  line: number
  side: 'old' | 'new'
  text: string
  type: DiffLine['type']
}

/** 解析统一 diff（git diff 输出）为按行结构。 */
function parseUnified(text: string): { rows: DiffLine[]; added: number; removed: number } {
  const rows: DiffLine[] = []
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
      }
      continue
    }
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity ') ||
      line.startsWith('rename ') ||
      line.startsWith('\\ No newline')
    ) {
      continue
    }
    const sign = line[0]
    const body = line.length > 0 ? line.slice(1) : ''
    if (sign === '+') {
      rows.push({ type: 'add', text: body, newNo })
      newNo++
      added++
    } else if (sign === '-') {
      rows.push({ type: 'del', text: body, oldNo })
      oldNo++
      removed++
    } else if (sign === ' ' || line === '') {
      rows.push({ type: 'ctx', text: body, oldNo, newNo })
      oldNo++
      newNo++
    }
  }
  return { rows, added, removed }
}

function lineInfo(row: DiffLine): DiffLineInfo {
  if (row.type === 'add') {
    return { line: row.newNo ?? 0, side: 'new', text: row.text, type: row.type }
  }
  if (row.type === 'del') {
    return { line: row.oldNo ?? 0, side: 'old', text: row.text, type: row.type }
  }
  return { line: row.newNo ?? row.oldNo ?? 0, side: 'new', text: row.text, type: row.type }
}

type Row =
  | DiffLine
  | { type: 'gap'; key: string; count: number }

const MAX_ROWS = 2000
const MAX_INPUT = 200_000
const CTX_HEAD = 3
const CTX_TAIL = 3
const CTX_COLLAPSE = CTX_HEAD + CTX_TAIL + 2

function buildRows(rows: DiffLine[], expanded: Set<string>): Row[] {
  const out: Row[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].type !== 'ctx') {
      out.push(rows[i])
      i++
      continue
    }
    let j = i
    while (j < rows.length && rows[j].type === 'ctx') j++
    const run = j - i
    const key = `${i}:${j}`
    if (run > CTX_COLLAPSE && !expanded.has(key)) {
      out.push(...rows.slice(i, i + CTX_HEAD))
      out.push({ type: 'gap', key, count: run - CTX_HEAD - CTX_TAIL })
      out.push(...rows.slice(j - CTX_TAIL, j))
    } else {
      out.push(...rows.slice(i, j))
    }
    i = j
  }
  return out
}

export const DiffView = memo(function DiffView({
  oldText = '',
  newText = '',
  unified,
  fileName,
  oldLabel,
  newLabel,
  maxHeight = 460,
  onLineClick,
  rowExtra,
}: {
  oldText?: string
  newText?: string
  /** 直接渲染统一 diff 文本；给出时忽略 oldText/newText。 */
  unified?: string
  fileName?: string
  oldLabel?: string
  newLabel?: string
  maxHeight?: number
  onLineClick?: (info: DiffLineInfo) => void
  rowExtra?: (info: DiffLineInfo) => ReactNode
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const { rows, truncated, added, removed } = useMemo(() => {
    if (unified !== undefined) {
      const parsed = parseUnified(unified)
      return {
        rows: parsed.rows.slice(0, MAX_ROWS),
        truncated: parsed.rows.length > MAX_ROWS,
        added: parsed.added,
        removed: parsed.removed,
      }
    }
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
  }, [oldText, newText, unified])

  const display = useMemo(() => buildRows(rows, expanded), [rows, expanded])
  const { ref: bodyRef, canLeft, canRight, update: updateOverflow } = useHorizontalOverflow<HTMLDivElement>([
    display.length,
  ])

  const expand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }

  return (
    <div className="chat-diff">
      <div className="chat-diff-head">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-soft" title={fileName}>
          {fileName || '改动'}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-success">+{added}</span>
        <span className="shrink-0 font-mono text-[11px] text-danger">−{removed}</span>
      </div>
      <div className="x-scroll-wrap">
        <div
          ref={bodyRef}
          onScroll={updateOverflow}
          className="chat-diff-body"
          style={{ maxHeight }}
        >
          {display.length === 0 && (
            <div className="px-3 py-4 text-[12px] italic text-muted">没有差异</div>
          )}
          {display.map((row, i) => {
            if (row.type === 'gap') {
              return (
                <button key={`gap-${row.key}`} onClick={() => expand(row.key)} className="chat-diff-more">
                  <ChevronsUpDown size={11} />
                  展开 {row.count} 行未改动内容
                </button>
              )
            }
            const info = lineInfo(row)
            return (
              <Fragment key={i}>
                <div
                  className={cn('chat-diff-row', onLineClick && 'cursor-pointer')}
                  data-kind={row.type}
                  onClick={onLineClick ? () => onLineClick(info) : undefined}
                  title={onLineClick ? '点击添加行内评论' : undefined}
                >
                  <span className="ln">{row.oldNo ?? ''}</span>
                  <span className="ln">{row.newNo ?? ''}</span>
                  <span className={cn('sign', row.type === 'add' && 'text-success', row.type === 'del' && 'text-danger')}>
                    {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}
                  </span>
                  <span className="text">{row.text || ' '}</span>
                </div>
                {rowExtra?.(info)}
              </Fragment>
            )
          })}
          {truncated && (
            <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted">
              差异过长，仅显示前 {MAX_ROWS} 行
            </div>
          )}
        </div>
        <div className="x-scroll-fade" data-visible={canRight} aria-hidden />
        {canLeft || canRight ? (
          <div className="x-scroll-foot">
            <ArrowLeftRight size={10} /> 左右滑动查看
          </div>
        ) : null}
      </div>
      {(oldLabel || newLabel) && (
        <div className="flex gap-3 border-t border-border px-3 py-1 text-[10px] text-muted">
          {oldLabel && <span>旧：{oldLabel}</span>}
          {newLabel && <span>新：{newLabel}</span>}
        </div>
      )}
    </div>
  )
})
