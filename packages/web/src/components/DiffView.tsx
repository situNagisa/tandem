import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { diffLines } from 'diff'
import * as RPopover from '@radix-ui/react-popover'
import {
  ArrowLeftRight,
  Bot,
  ChevronsUpDown,
  MessageSquare,
  WrapText,
} from 'lucide-react'
import type { AiReviewSeverity } from '@tandem/protocol'
import { cn } from '../lib/cn'
import { useHorizontalOverflow } from '../lib/hooks'
import { useFeedbackStore } from '../store/useFeedbackStore'
import { Button } from './ui/Button'
import { popoverSurfaceClass } from './ui/Popover'

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

export interface DiffCommentDraft {
  side: 'old' | 'new'
  startLine: number
  endLine: number
  text: string
}

export interface DiffComment extends DiffCommentDraft {
  id: number
}

/** AI 评审意见：与人工评论共用行尾标记，但用中性灰 + 机器人图标区分。 */
export interface AiDiffComment {
  id: string
  side: 'old' | 'new'
  startLine: number
  endLine: number
  severity: AiReviewSeverity
  title: string
  detail: string
  suggestion?: string
}

const SEVERITY_META: Record<AiReviewSeverity, { label: string; className: string }> = {
  blocker: { label: '阻塞', className: 'text-danger' },
  warn: { label: '警告', className: 'text-warning' },
  nit: { label: '细节', className: 'text-muted' },
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

function lineLabel(start: number, end: number) {
  return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`
}

/** 行评论标记：行尾图标 + 条数，悬停预览，点击后固定浮层，可编辑或删除。 */
function CommentMarker({
  comments,
  onEdit,
  onDelete,
}: {
  comments: DiffComment[]
  onEdit: (id: number, text: string) => void
  onDelete: (id: number) => void
}) {
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const leaveTimer = useRef<number | null>(null)

  useEffect(() => {
    if (editingId !== null) inputRef.current?.focus()
  }, [editingId])

  useEffect(
    () => () => {
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    },
    [],
  )

  // 鼠标从图标移到浮层之间会短暂离开标记，延迟关闭让浮层可操作。
  const holdOpen = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    leaveTimer.current = null
    setHover(true)
  }

  const scheduleLeave = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null
      if (!pinned) setHover(false)
    }, 180)
  }

  const close = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    leaveTimer.current = null
    setPinned(false)
    setHover(false)
    setEditingId(null)
  }

  const save = () => {
    const next = text.trim()
    if (editingId !== null && next) onEdit(editingId, next)
    setEditingId(null)
  }

  return (
    <RPopover.Root
      open={hover || pinned}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <RPopover.Anchor asChild>
        <button
          type="button"
          className="diff-comment-btn"
          data-open={pinned || undefined}
          aria-label={`${lineLabel(comments[0].startLine, comments[0].endLine)}的评论，共 ${comments.length} 条`}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={holdOpen}
          onMouseLeave={scheduleLeave}
          onClick={(e) => {
            e.stopPropagation()
            setPinned(true)
            setHover(true)
          }}
        >
          <MessageSquare size={12} aria-hidden />
        </button>
      </RPopover.Anchor>
      <RPopover.Portal>
        <RPopover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          avoidCollisions
          sticky="always"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => {
            if (useFeedbackStore.getState().active) e.preventDefault()
          }}
          onFocusOutside={(e) => {
            if (useFeedbackStore.getState().active) e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (useFeedbackStore.getState().active) e.preventDefault()
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={(e) => {
            e.stopPropagation()
            holdOpen()
          }}
          onPointerLeave={scheduleLeave}
          onClick={(e) => e.stopPropagation()}
          className={cn(popoverSurfaceClass, 'z-[85] w-[270px] p-2.5')}
        >
          <div className="space-y-2">
            {comments.map((comment) => (
              <div key={comment.id}>
                <p className="mb-1 font-mono text-[10px] text-muted">
                  {lineLabel(comment.startLine, comment.endLine)}
                </p>
                {editingId === comment.id ? (
                  <>
                    <textarea
                      ref={inputRef}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          save()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          setEditingId(null)
                        }
                      }}
                      rows={2}
                      aria-label="编辑行评论"
                      className="w-full resize-none rounded-md border border-border bg-bg px-2 py-1.5 text-[12px] leading-5 text-text outline-none focus:border-[var(--t-border-strong)]"
                    />
                    <div className="mt-1.5 flex justify-end gap-1">
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-[12px] text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text"
                        onClick={() => setEditingId(null)}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="rounded-md bg-[var(--t-primary-bg)] px-2.5 py-1 text-[12px] font-medium text-[var(--t-primary-fg)] transition-opacity disabled:opacity-40"
                        disabled={!text.trim()}
                        onClick={save}
                      >
                        保存
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap break-words text-[12px] leading-5 text-text-soft">
                      {comment.text}
                    </p>
                    <div className="mt-1 flex justify-end gap-1">
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-[12px] text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text"
                        onClick={() => {
                          setPinned(true)
                          setText(comment.text)
                          setEditingId(comment.id)
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-[12px] text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-danger"
                        onClick={() => {
                          onDelete(comment.id)
                          close()
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}

/** AI 评审标记：点击展开问题详情，可采纳为人工评论、忽略或标记为误报。 */
function AiMarker({
  comment,
  onAction,
}: {
  comment: AiDiffComment
  onAction: (id: string, action: 'accept' | 'ignore' | 'false_positive') => void
}) {
  const [open, setOpen] = useState(false)
  const leaveTimer = useRef<number | null>(null)
  const meta = SEVERITY_META[comment.severity]

  useEffect(
    () => () => {
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    },
    [],
  )

  const holdOpen = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    leaveTimer.current = null
    setOpen(true)
  }
  const scheduleLeave = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => setOpen(false), 180)
  }
  const close = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    leaveTimer.current = null
    setOpen(false)
  }

  return (
    <RPopover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <RPopover.Anchor asChild>
        <button
          type="button"
          className="diff-comment-btn diff-ai-btn"
          data-ai="true"
          data-open={open || undefined}
          aria-label={`AI 评审：${meta.label} · ${comment.title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseEnter={holdOpen}
          onMouseLeave={scheduleLeave}
          onClick={(e) => {
            e.stopPropagation()
            setOpen(true)
          }}
        >
          <Bot size={12} aria-hidden />
        </button>
      </RPopover.Anchor>
      <RPopover.Portal>
        <RPopover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          avoidCollisions
          sticky="always"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => {
            if (useFeedbackStore.getState().active) e.preventDefault()
          }}
          onFocusOutside={(e) => {
            if (useFeedbackStore.getState().active) e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (useFeedbackStore.getState().active) e.preventDefault()
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={(e) => {
            e.stopPropagation()
            holdOpen()
          }}
          onPointerLeave={scheduleLeave}
          onClick={(e) => e.stopPropagation()}
          className={cn(popoverSurfaceClass, 'z-[85] w-[320px] p-2.5')}
        >
          <div className="flex items-center gap-1.5">
            <Bot size={12} className="shrink-0 text-muted" />
            <span className={cn('shrink-0 text-[11px] font-medium', meta.className)}>{meta.label}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text" data-tip={comment.title}>
              {comment.title}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted">
              {lineLabel(comment.startLine, comment.endLine)}
            </span>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-5 text-text-soft">
            {comment.detail}
          </p>
          {comment.suggestion && (
            <p className="mt-1.5 whitespace-pre-wrap break-words rounded-md bg-[var(--t-bg-hover)] px-2 py-1.5 text-[12px] leading-5 text-text-soft">
              <span className="text-muted">建议：</span>
              {comment.suggestion}
            </p>
          )}
          <div className="mt-2 flex items-center justify-end gap-1">
            <button
              type="button"
              className="rounded px-2 py-1 text-[12px] text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text"
              onClick={() => {
                onAction(comment.id, 'false_positive')
                close()
              }}
            >
              标记误报
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-[12px] text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text"
              onClick={() => {
                onAction(comment.id, 'ignore')
                close()
              }}
            >
              忽略
            </button>
            <button
              type="button"
              className="rounded-md bg-[var(--t-primary-bg)] px-2.5 py-1 text-[12px] font-medium text-[var(--t-primary-fg)]"
              onClick={() => {
                onAction(comment.id, 'accept')
                close()
              }}
            >
              采纳
            </button>
          </div>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}

function Composer({
  label,
  onSave,
  onCancel,
}: {
  label: string
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const save = () => {
    const next = text.trim()
    if (next) onSave(next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="flex w-[min(340px,calc(100vw-16px))] items-end gap-1.5">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const el = e.currentTarget
          el.style.height = 'auto'
          el.style.height = `${Math.min(el.scrollHeight, 96)}px`
        }}
        onKeyDown={onKeyDown}
        placeholder={`对${label}写审阅意见…`}
        aria-label="行内评论"
        data-tip="Enter 保存 · Shift+Enter 换行 · Esc 取消"
        className="block max-h-24 min-h-7 min-w-0 flex-1 resize-none rounded-md border-0 bg-[var(--t-bg)] px-2 py-1.5 text-[12px] leading-5 text-text outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--t-focus-ring)]"
      />
      <Button size="sm" variant="primary" disabled={!text.trim()} onClick={save}>
        评论
      </Button>
    </div>
  )
}

export const DiffView = memo(function DiffView({
  oldText = '',
  newText = '',
  unified,
  fileName,
  oldLabel,
  newLabel,
  maxHeight = 460,
  emptyLabel,
  comments = [],
  onAddComment,
  onEditComment,
  onDeleteComment,
  aiComments = [],
  onAiAction,
  wrapToggle = false,
}: {
  oldText?: string
  newText?: string
  /** 直接渲染统一 diff 文本；给出时忽略 oldText/newText。 */
  unified?: string
  fileName?: string
  oldLabel?: string
  newLabel?: string
  maxHeight?: number
  /** diff 为空或只有元信息时显示的文案。 */
  emptyLabel?: string
  comments?: DiffComment[]
  onAddComment?: (draft: DiffCommentDraft) => void
  onEditComment?: (id: number, text: string) => void
  onDeleteComment?: (id: number) => void
  aiComments?: AiDiffComment[]
  onAiAction?: (id: string, action: 'accept' | 'ignore' | 'false_positive') => void
  /** 顶部提供「自动换行」开关（长行走软换行，不依赖横向滚动）。 */
  wrapToggle?: boolean
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selection, setSelection] = useState<{ startIdx: number; endIdx: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [wrap, setWrap] = useState(false)
  const dragRef = useRef(false)

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

  const maxLineDigits = useMemo(
    () => Math.max(1, ...rows.map((row) => String(lineInfo(row).line).length)),
    [rows],
  )
  const display = useMemo(() => buildRows(rows, expanded), [rows, expanded])
  const { ref: bodyRef, canLeft, canRight, update: updateOverflow } = useHorizontalOverflow<HTMLDivElement>([
    display.length,
  ])

  const selectable = !!onAddComment

  // 同一行起的多条评论合并成一个行尾标记，浮层里逐条展示。
  const anchored = useMemo(() => {
    const map = new Map<string, DiffComment[]>()
    for (const comment of comments) {
      const key = `${comment.side}:${comment.endLine}`
      const list = map.get(key)
      if (list) list.push(comment)
      else map.set(key, [comment])
    }
    return map
  }, [comments])

  const aiAnchored = useMemo(() => {
    const map = new Map<string, AiDiffComment[]>()
    for (const comment of aiComments) {
      const key = `${comment.side}:${comment.endLine}`
      const list = map.get(key)
      if (list) list.push(comment)
      else map.set(key, [comment])
    }
    return map
  }, [aiComments])

  useEffect(() => {
    setSelection(null)
    dragRef.current = false
    setDragging(false)
  }, [unified, fileName])

  const selectionInfo = useMemo(() => {
    if (!selection) return null
    const startIdx = Math.min(selection.startIdx, selection.endIdx)
    const endIdx = Math.max(selection.startIdx, selection.endIdx)
    const startRow = display[startIdx]
    const endRow = display[endIdx]
    if (!startRow || !endRow || startRow.type === 'gap' || endRow.type === 'gap') return null
    const start = lineInfo(startRow)
    const end = lineInfo(endRow)
    if (!start.line || !end.line) return null
    return {
      startIdx,
      endIdx,
      side: start.side,
      startLine: start.line,
      endLine: end.line,
      label: lineLabel(start.line, end.line),
    }
  }, [selection, display])

  const selectRow = (idx: number, shift: boolean) => {
    if (!selectable) return
    setSelection((prev) =>
      shift && prev ? { startIdx: prev.startIdx, endIdx: idx } : { startIdx: idx, endIdx: idx },
    )
  }

  const expand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }

  return (
    <div className="chat-diff" data-wrap={wrap ? 'true' : undefined}>
      <div className="chat-diff-head">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-soft" data-tip={fileName}>
          {fileName || '改动'}
        </span>
        <span className="shrink-0 font-mono text-[12px] text-[var(--t-git-plus)]">+{added}</span>
        <span className="shrink-0 font-mono text-[12px] text-[var(--t-git-minus)]">−{removed}</span>
        {wrapToggle ? (
          <button
            type="button"
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
            data-tip={wrap ? '关闭自动换行' : '自动换行（长行不横向滚动）'}
            data-testid="diff-wrap-toggle"
            className={cn(
              'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12px] transition-colors',
              wrap
                ? 'bg-[var(--t-bg-active)] text-text'
                : 'text-muted hover:bg-[var(--t-bg-hover)] hover:text-text-soft',
            )}
          >
            <WrapText size={12} />
            自动换行
          </button>
        ) : null}
      </div>
      <div className="x-scroll-wrap">
        <div
          ref={bodyRef}
          onScroll={updateOverflow}
          className="chat-diff-body"
          style={{ maxHeight }}
        >
          {display.length === 0 && (
            <div className="px-3 py-4 text-[12px] italic text-muted">{emptyLabel ?? '没有差异'}</div>
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
            const rowComments = comments.filter(
              (c) => c.side === info.side && info.line >= c.startLine && info.line <= c.endLine,
            )
            const anchorComments = anchored.get(`${info.side}:${info.line}`)
            const aiAnchor = aiAnchored.get(`${info.side}:${info.line}`)
            const selectedRow =
              selectionInfo !== null && i >= selectionInfo.startIdx && i <= selectionInfo.endIdx
            const isAnchor = selectionInfo !== null && i === selectionInfo.endIdx
            return (
              <Fragment key={`${info.side}-${info.line}-${i}`}>
                <div
                  className={cn(
                    'chat-diff-row',
                    selectable &&
                      'cursor-pointer outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--t-focus-ring)]',
                  )}
                  role={selectable ? 'group' : undefined}
                  tabIndex={selectable ? 0 : undefined}
                  aria-label={
                    selectable
                      ? `${info.side === 'old' ? '旧' : '新'}文件第 ${info.line} 行：${row.text || '空行'}。按 Enter 添加评论`
                      : undefined
                  }
                  onKeyDown={
                    selectable
                      ? (e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          e.preventDefault()
                          selectRow(i, e.shiftKey)
                        }
                      : undefined
                  }
                  data-kind={row.type}
                  data-commented={rowComments.length > 0 || undefined}
                  data-selected={selectedRow || undefined}
                  onPointerDown={
                    selectable
                      ? (e) => {
                          if (e.button !== 0) return
                          e.preventDefault()
                          selectRow(i, e.shiftKey)
                          dragRef.current = true
                          setDragging(true)
                          const up = () => {
                            dragRef.current = false
                            setDragging(false)
                            window.removeEventListener('pointerup', up)
                          }
                          window.addEventListener('pointerup', up)
                        }
                      : undefined
                  }
                  onPointerEnter={
                    selectable
                      ? () => {
                          if (dragRef.current) {
                            setSelection((prev) =>
                              prev ? { startIdx: prev.startIdx, endIdx: i } : { startIdx: i, endIdx: i },
                            )
                          }
                        }
                      : undefined
                  }
                  data-tip={selectable ? '点击或拖选行添加评论' : undefined}
                >
                  <span className="ln" style={{ width: `${maxLineDigits + 0.75}ch` }}>
                    {row.type === 'del' ? row.oldNo : row.newNo}
                  </span>
                  <span className={cn('sign', row.type === 'add' && 'text-[var(--t-add-bar)]', row.type === 'del' && 'text-[var(--t-del-bar)]')}>
                    {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}
                  </span>
                  <span className="text">{row.text || ' '}</span>
                  {rowComments.length > 0 && <span className="diff-comment-line" aria-hidden />}
                  {anchorComments && anchorComments.length > 0 && onEditComment && onDeleteComment ? (
                    <CommentMarker
                      comments={anchorComments}
                      onEdit={onEditComment}
                      onDelete={onDeleteComment}
                    />
                  ) : null}
                  {aiAnchor && aiAnchor.length > 0 && onAiAction ? (
                    <>
                      <span className="diff-ai-line" aria-hidden />
                      {aiAnchor.map((comment) => (
                        <AiMarker key={comment.id} comment={comment} onAction={onAiAction} />
                      ))}
                    </>
                  ) : null}
                  {isAnchor && selectionInfo && (
                    <RPopover.Root
                      open={!dragging}
                      onOpenChange={(open) => {
                        if (!open) {
                          setSelection(null)
                          dragRef.current = false
                          setDragging(false)
                        }
                      }}
                    >
                      <RPopover.Anchor asChild>
                        <span
                          className="diff-composer-anchor"
                          style={{ left: `${maxLineDigits + 2.5}ch` }}
                        />
                      </RPopover.Anchor>
                      <RPopover.Portal>
                        <RPopover.Content
                          side="bottom"
                          align="start"
                          sideOffset={4}
                          collisionPadding={8}
                          avoidCollisions
                          sticky="always"
                          onOpenAutoFocus={(e) => e.preventDefault()}
                          onPointerDown={(e) => e.stopPropagation()}
                          onPointerEnter={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDownOutside={(e) => {
                            if ((e.target as HTMLElement).closest?.('.chat-diff-row')) {
                              e.preventDefault()
                            }
                          }}
                          className={cn(popoverSurfaceClass, 'z-[85] p-2')}
                        >
                          <Composer
                            label={selectionInfo.label}
                            onSave={(text) => {
                              onAddComment?.({
                                side: selectionInfo.side,
                                startLine: selectionInfo.startLine,
                                endLine: selectionInfo.endLine,
                                text,
                              })
                              setSelection(null)
                            }}
                            onCancel={() => setSelection(null)}
                          />
                        </RPopover.Content>
                      </RPopover.Portal>
                    </RPopover.Root>
                  )}
                </div>
              </Fragment>
            )
          })}
          {truncated && (
            <div className="border-t border-border px-3 py-1.5 text-[12px] text-muted">
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
