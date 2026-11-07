import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink, GitBranch, PanelRightOpen, Pencil, Trash2, X } from 'lucide-react'
import type { AiReviewFinding, Board, BoardCard } from '@tandem/protocol'
import { cn } from '../../lib/cn'
import { STATUS_LABEL, depTitles, formatDuration, formatUsd } from '../../lib/board'
import { Button, IconButton } from '../ui/Button'
import { CardStatusIcon } from './BoardCardItem'

export interface CardActions {
  start: (card: BoardCard) => void
  unqueue: (card: BoardCard) => void
  stop: (card: BoardCard) => void
  retry: (card: BoardCard) => void
  approve: (card: BoardCard) => void
  reject: (card: BoardCard) => void
  merge: (card: BoardCard) => Promise<void> | void
  resolveConflicts: (card: BoardCard) => void
  fixReview: (card: BoardCard, note: string) => void
  openSession: (card: BoardCard) => void
  openSplit: (card: BoardCard) => void
  edit: (card: BoardCard) => void
  remove: (card: BoardCard) => void
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-[13px]">
      <dt className="text-text-tertiary">{label}</dt>
      <dd className="min-w-0 break-words text-text-secondary">{children}</dd>
    </div>
  )
}

/** 按卡片状态给出主/次动作；桌面抽屉与手机详情共用。 */
export function CardActionBar({ card, board, actions, className }: { card: BoardCard; board: Board; actions: CardActions; className?: string }) {
  const [merging, setMerging] = useState(false)
  const canMerge = card.status === 'done' && !!card.result?.branch && !card.result.mergedAt
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {card.status === 'todo' && (
        <Button variant="primary" onClick={() => actions.start(card)}>
          {card.proposedBy ? '接受并排队' : '放行'}
        </Button>
      )}
      {card.status === 'queued' && <Button onClick={() => actions.unqueue(card)}>撤回到待办</Button>}
      {(card.status === 'running' || card.status === 'approval') && <Button onClick={() => actions.stop(card)}>停止</Button>}
      {card.status === 'approval' && (
        <Button variant="primary" onClick={() => actions.openSession(card)}>去处理审批</Button>
      )}
      {card.status === 'review' && (
        <>
          <Button variant="primary" onClick={() => actions.approve(card)}>通过</Button>
          <Button onClick={() => actions.reject(card)}>打回…</Button>
        </>
      )}
      {card.status === 'failed' && <Button variant="primary" onClick={() => actions.retry(card)}>重试</Button>}
      {canMerge && (
        <Button
          variant={card.status === 'done' ? 'primary' : 'secondary'}
          disabled={merging}
          onClick={async () => {
            setMerging(true)
            try {
              await actions.merge(card)
            } finally {
              setMerging(false)
            }
          }}
        >
          合并到 {board.baseBranch ?? '基准分支'}
        </Button>
      )}
      {card.sessionId && card.status !== 'approval' && (
        <>
          <Button icon={<ExternalLink />} onClick={() => actions.openSession(card)}>打开会话</Button>
          <Button icon={<PanelRightOpen size={13} />} onClick={() => actions.openSplit(card)}>在分屏中打开</Button>
        </>
      )}
      {['todo', 'queued', 'failed'].includes(card.status) && (
        <Button icon={<Pencil />} onClick={() => actions.edit(card)}>编辑</Button>
      )}
      {card.status !== 'running' && card.status !== 'approval' && (
        <Button variant="danger-ghost" icon={<Trash2 />} onClick={() => actions.remove(card)}>删除</Button>
      )}
    </div>
  )
}

export function CardDetail({ card, board, actions }: { card: BoardCard; board: Board; actions: CardActions }) {
  const deps = depTitles(card, board.cards)
  const result = card.result
  const exec = { ...board.defaults, ...card.exec }
  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-1 text-[12px] font-medium text-text-tertiary">提示词</h3>
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-secondary">{card.prompt}</p>
        {card.proposedBy ? (
          <p className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-[var(--t-surface-2)] px-2 py-0.5 text-[12px] text-text-tertiary">
            由 {card.proposedBy} 提议{card.status === 'todo' ? ' · 待确认' : card.status === 'queued' ? ' · 已接受' : ''}
          </p>
        ) : null}
      </section>
      {card.result?.mergeError ? <ConflictSection card={card} actions={actions} /> : null}
      {card.review ? <ReviewSection card={card} actions={actions} /> : null}
      {(card.status === 'running' || card.status === 'approval') && card.activity ? (
        <section>
          <h3 className="mb-1 text-[12px] font-medium text-text-tertiary">当前活动</h3>
          <p className={cn('text-[13px]', card.status === 'approval' ? 'text-[var(--t-accent-text)]' : 'text-text-secondary')}>{card.activity}</p>
        </section>
      ) : null}
      {card.error ? (
        <section>
          <h3 className="mb-1 text-[12px] font-medium text-text-tertiary">错误</h3>
          <p className="whitespace-pre-wrap break-words text-[13px] text-danger">{card.error}</p>
        </section>
      ) : null}
      {result ? (
        <section>
          <h3 className="mb-1 text-[12px] font-medium text-text-tertiary">结果</h3>
          {result.summary ? <p className="mb-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-secondary">{result.summary}</p> : null}
          <dl className="space-y-1">
            <Field label="改动">
              {result.files} 个文件 +{result.additions} −{result.deletions}
            </Field>
            <Field label="花费">
              {formatUsd(result.costUsd)} · {formatDuration(result.durationMs)}
            </Field>
            {result.branch ? (
              <Field label="分支">
                <span className="inline-flex items-center gap-1">
                  <GitBranch size={12} aria-hidden />
                  <code className="text-[12px]">{result.branch}</code>
                  {result.commit ? <span className="text-text-tertiary">@ {result.commit}</span> : null}
                </span>
              </Field>
            ) : null}
            {result.branch ? (
              <Field label="合并">
                {result.mergedAt ? '已合并' : result.mergeError ? <span className="text-danger">{result.mergeError}</span> : '未合并'}
              </Field>
            ) : null}
          </dl>
        </section>
      ) : null}
      <section>
        <h3 className="mb-1 text-[12px] font-medium text-text-tertiary">配置</h3>
        <dl className="space-y-1">
          {deps.length > 0 ? <Field label="依赖">{deps.join('、')}</Field> : null}
          <Field label="预设">{exec.preset ?? '默认'}</Field>
          {exec.model ? <Field label="模型">{exec.model}</Field> : null}
          <Field label="权限">{exec.permissionMode ?? 'acceptEdits'}</Field>
          <Field label="Worktree">{board.isGit ? (exec.worktree === false ? '关（直接在项目目录运行）' : '开') : '非 git 目录'}</Field>
          <Field label="审批门">{exec.gate ? '完成后需确认' : '无'}</Field>
          <Field label="AI 评审">{exec.aiReview ? '完成后评审（blocker 停在待评审）' : '关'}</Field>
          {exec.budgetUsd ? <Field label="预算">上限 {formatUsd(exec.budgetUsd)}</Field> : null}
          <Field label="重试">{card.attempts} / {exec.maxRetries ?? 1}</Field>
        </dl>
      </section>
      <CardActionBar card={card} board={board} actions={actions} className="border-t border-border pt-3" />
    </div>
  )
}

function ConflictSection({ card, actions }: { card: BoardCard; actions: CardActions }) {
  const files = card.result?.conflictFiles ?? []
  return (
    <section className="rounded-lg border border-border p-3" data-testid="board-conflicts">
      <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-danger">
        <AlertTriangle size={13} aria-hidden /> 合并冲突
      </h3>
      <p className="mt-1 break-words text-[13px] leading-relaxed text-text-secondary">{card.result?.mergeError}</p>
      {files.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] text-text-secondary">
          {files.map((file) => (
            <li key={file}>
              <code className="break-all text-[12px]">{file}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {card.status === 'done' ? (
        <Button className="mt-2.5" onClick={() => actions.resolveConflicts(card)}>
          让 agent 解决冲突
        </Button>
      ) : (
        <p className="mt-2 text-[12px] text-text-tertiary">agent 解决并提交后，仍需你点「合并」。</p>
      )}
    </section>
  )
}

const SEVERITY_LABEL: Record<AiReviewFinding['severity'], string> = {
  blocker: '阻塞',
  warn: '警告',
  nit: '建议',
}

function ReviewSection({ card, actions }: { card: BoardCard; actions: CardActions }) {
  const review = card.review
  const [picked, setPicked] = useState<string[]>([])
  useEffect(() => {
    setPicked(review?.findings.map((finding) => finding.id) ?? [])
  }, [review?.id, review?.status])

  if (!review) return null
  const findings = review.findings
  const blocker = review.status === 'done' && review.verdict === 'blocker'
  const note = findings
    .filter((finding) => picked.includes(finding.id))
    .map(
      (finding) =>
        `- [${SEVERITY_LABEL[finding.severity]}] ${finding.file}:${finding.line} ${finding.title}：${finding.detail}` +
        (finding.suggestion ? `（建议：${finding.suggestion}）` : ''),
    )
    .join('\n')
  return (
    <section className="rounded-lg border border-border p-3" data-testid="board-review">
      <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-text-tertiary">
        AI 评审
        {review.status === 'running' ? <span className="text-text-tertiary">· 评审中，完成后才决定去向</span> : null}
        {blocker ? <span className="text-danger">· 发现阻塞问题</span> : null}
        {review.status === 'done' && !blocker && review.verdict === 'suggest' ? <span>· 有建议</span> : null}
      </h3>
      {review.status === 'error' ? <p className="mt-1 text-[13px] text-danger">{review.error ?? '评审失败'}</p> : null}
      {review.summary ? <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text-secondary">{review.summary}</p> : null}
      {findings.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {findings.map((finding) => {
            const on = picked.includes(finding.id)
            return (
              <li key={finding.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={card.status !== 'review'}
                  onClick={() =>
                    setPicked((list) => (list.includes(finding.id) ? list.filter((id) => id !== finding.id) : [...list, finding.id]))
                  }
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left',
                    on ? 'border-border-strong bg-[var(--t-bg-active)]' : 'border-border',
                    card.status !== 'review' && 'cursor-default',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 shrink-0 rounded px-1 text-[11px]',
                      finding.severity === 'blocker' ? 'text-danger' : 'text-text-tertiary',
                    )}
                  >
                    {SEVERITY_LABEL[finding.severity]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[13px] text-text">{finding.title}</span>
                    <span className="block break-all text-[12px] text-text-tertiary">
                      {finding.file}:{finding.line}
                    </span>
                    <span className="mt-0.5 block break-words text-[12px] leading-relaxed text-text-secondary">{finding.detail}</span>
                    {finding.suggestion ? (
                      <span className="mt-0.5 block break-words text-[12px] text-text-tertiary">建议：{finding.suggestion}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      {card.status === 'review' && findings.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={!note} onClick={() => actions.fixReview(card, note)}>
            让这张卡修复
          </Button>
          {blocker ? <Button onClick={() => actions.approve(card)}>仍然通过</Button> : null}
        </div>
      ) : null}
      {card.status === 'review' && findings.length === 0 && blocker ? (
        <Button className="mt-2.5" onClick={() => actions.approve(card)}>仍然通过</Button>
      ) : null}
    </section>
  )
}

export function CardDrawerHeader({ card, onClose }: { card: BoardCard; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2 border-b border-border px-4 py-3">
      <CardStatusIcon status={card.status} />
      <div className="min-w-0 flex-1">
        <h2 className="break-words text-[15px] font-semibold leading-snug text-text">{card.title}</h2>
        <p className="text-[12px] text-text-tertiary">{STATUS_LABEL[card.status]}</p>
      </div>
      <IconButton label="关闭详情" size="sm" onClick={onClose}>
        <X />
      </IconButton>
    </div>
  )
}
