import { useState } from 'react'
import { ExternalLink, GitBranch, Pencil, Trash2, X } from 'lucide-react'
import type { Board, BoardCard } from '@tandem/protocol'
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
  openSession: (card: BoardCard) => void
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
      {card.status === 'todo' && <Button variant="primary" onClick={() => actions.start(card)}>放行</Button>}
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
        <Button icon={<ExternalLink />} onClick={() => actions.openSession(card)}>打开会话</Button>
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
      </section>
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
          {exec.budgetUsd ? <Field label="预算">上限 {formatUsd(exec.budgetUsd)}</Field> : null}
          <Field label="重试">{card.attempts} / {exec.maxRetries ?? 1}</Field>
        </dl>
      </section>
      <CardActionBar card={card} board={board} actions={actions} className="border-t border-border pt-3" />
    </div>
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
