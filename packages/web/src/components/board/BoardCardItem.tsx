import { Check, CornerUpLeft, GitBranch, Loader2, TriangleAlert } from 'lucide-react'
import type { Board, BoardCard } from '@tandem/protocol'
import { cn } from '../../lib/cn'
import { depTitles, formatUsd, queuedText } from '../../lib/board'

export function CardStatusIcon({ status }: { status: BoardCard['status'] }) {
  if (status === 'running') return <Loader2 size={14} aria-hidden className="mt-[3px] shrink-0 animate-spin text-text-secondary" />
  if (status === 'approval') return <span aria-hidden className="mt-[7px] inline-block size-2 shrink-0 rounded-full bg-accent" />
  if (status === 'done') return <Check size={14} aria-hidden className="mt-[3px] shrink-0 text-text-tertiary" />
  if (status === 'failed') return <TriangleAlert size={14} aria-hidden className="mt-[3px] shrink-0 text-danger" />
  if (status === 'review') return <span aria-hidden className="mt-[7px] inline-block size-2 shrink-0 rounded-full border border-text-secondary" />
  return <span aria-hidden className="mt-[7px] inline-block size-2 shrink-0 rounded-full border border-border-strong" />
}

/** 卡片上的一行状态文案；文字色遵循设计：错误用 danger，待审批用橙，其余中性。 */
export function CardStatusLine({ card, board }: { card: BoardCard; board: Board }) {
  if (card.status === 'running') {
    return card.activity ? <p className="truncate text-[12px] text-text-secondary">{card.activity}</p> : null
  }
  if (card.status === 'approval') {
    return <p className="truncate text-[12px] text-[var(--t-accent-text)]">{card.activity ?? '等待审批'}</p>
  }
  if (card.status === 'queued') {
    const text = queuedText(card, board.cards)
    return text ? (
      <p className={cn('truncate text-[12px]', card.blocked === 'upstream_failed' ? 'text-danger' : 'text-text-tertiary')}>{text}</p>
    ) : null
  }
  if (card.status === 'failed') {
    return <p className="line-clamp-2 text-[12px] text-danger">{card.error ?? '失败'}</p>
  }
  if (card.status === 'review' || card.status === 'done') {
    const result = card.result
    const blockers = card.review?.findings.filter((finding) => finding.severity === 'blocker').length ?? 0
    return (
      <>
        {card.review?.status === 'running' ? <p className="text-[12px] text-text-tertiary">AI 评审中…</p> : null}
        {card.review?.status === 'done' && blockers > 0 ? (
          <p className="text-[12px] text-danger">AI 评审：{blockers} 个阻塞问题</p>
        ) : null}
        {result?.summary ? (
          <p className={cn('text-[12px] text-text-secondary', card.status === 'review' ? 'line-clamp-2' : 'truncate')}>{result.summary}</p>
        ) : null}
        {result?.mergeError ? (
          <p className="mt-0.5 line-clamp-2 text-[12px] text-danger">合并冲突：{result.mergeError}</p>
        ) : null}
      </>
    )
  }
  return <p className="line-clamp-2 text-[12px] text-text-tertiary">{card.prompt.split('\n')[0]}</p>
}

export function BoardCardItem({
  card,
  board,
  selected,
  dragging,
  onOpen,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  card: BoardCard
  board: Board
  selected?: boolean
  dragging?: boolean
  onOpen: () => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
}) {
  const deps = depTitles(card, board.cards)
  const result = card.result
  const meta: string[] = []
  if (card.exec.preset) meta.push(card.exec.preset)
  if (card.exec.gate) meta.push('需确认')
  if (card.exec.aiReview) meta.push('AI 评审')
  const cost = result?.costUsd
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      data-card-id={card.id}
      data-status={card.status}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'board-card cursor-pointer rounded-lg border bg-surface px-2.5 py-2 text-left transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)]',
        selected ? 'border-border-strong bg-[var(--t-surface-2)]' : 'border-border',
        dragging && 'opacity-40',
      )}
    >
      <div className="flex items-start gap-2">
        <CardStatusIcon status={card.status} />
        <span className="line-clamp-2 min-w-0 flex-1 text-[14px] font-medium leading-snug text-text">{card.title}</span>
      </div>
      <div className="mt-1 min-w-0 space-y-0.5 pl-[22px]">
        {deps.length > 0 && !(card.status === 'queued' && card.blocked === 'waiting') ? (
          <p className="flex min-w-0 items-center gap-1 text-[12px] text-text-tertiary">
            <CornerUpLeft size={11} aria-hidden className="shrink-0" />
            <span className="truncate">{deps.join('、')}</span>
          </p>
        ) : null}
        {card.proposedBy ? (
          <p className="truncate text-[12px] text-text-tertiary">由 {card.proposedBy} 提议</p>
        ) : null}
        <CardStatusLine card={card} board={board} />
        {(meta.length > 0 || result) && (
          <p className="flex min-w-0 items-center gap-1.5 text-[12px] text-text-tertiary">
            {result?.branch ? <GitBranch size={11} aria-hidden className="shrink-0" /> : null}
            {result && (card.status === 'review' || card.status === 'done') && result.files > 0 ? (
              <span className="shrink-0 tabular-nums">
                {result.files} 个文件 +{result.additions} −{result.deletions}
              </span>
            ) : null}
            {meta.length > 0 ? <span className="truncate">{meta.join(' · ')}</span> : null}
            {cost ? <span className="ml-auto shrink-0 tabular-nums">{formatUsd(cost)}</span> : null}
          </p>
        )}
      </div>
    </div>
  )
}
