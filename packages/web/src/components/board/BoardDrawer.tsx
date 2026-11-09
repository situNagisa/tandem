import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitMerge,
  PanelRightOpen,
  Pencil,
  PlayCircle,
  RotateCcw,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react'
import type { AiReviewFinding, Board, BoardCard, BoardCardStatus } from '@tandem/protocol'
import { cn } from '../../lib/cn'
import { STATUS_LABEL, depTitles, formatDuration, formatUsd } from '../../lib/board'
import { Button, IconButton } from '../ui/Button'
import { Modal } from '../ui/Modal'
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
  /** 卡片分支相对起点的改动审阅（完成后也能核对）。 */
  viewDiff: (card: BoardCard) => void
  /** 卡片会话里最近一次测试/检查结果。 */
  viewChecks: (card: BoardCard) => void
  edit: (card: BoardCard) => void
  remove: (card: BoardCard) => void
}

export type CardActionKey =
  | 'start'
  | 'unqueue'
  | 'stop'
  | 'approval'
  | 'approve'
  | 'reject'
  | 'retry'
  | 'merge'
  | 'openSession'
  | 'viewDiff'
  | 'viewChecks'
  | 'viewError'
  | 'openSplit'
  | 'edit'
  | 'remove'

interface CardActionDef {
  key: CardActionKey
  label: (card: BoardCard, board: Board) => string
  primary?: boolean
  /** 缺省总是显示；返回 false 时隐藏（如没有分支可合并）。 */
  when?: (card: BoardCard, board: Board) => boolean
}

function canMerge(card: BoardCard): boolean {
  return card.status === 'done' && !!card.result?.branch && !card.result.mergedAt
}

/**
 * 状态 → 操作清单：抽屉与列表的操作按钮都从这里取，避免完成态只剩「删除」。
 * 每个状态显式列出可用操作；按钮的顺序即展示顺序。
 */
export const CARD_ACTIONS_BY_STATUS: Record<BoardCardStatus, CardActionDef[]> = {
  todo: [
    { key: 'start', label: (card) => (card.proposedBy ? '接受并排队' : '放行'), primary: true },
    { key: 'edit', label: () => '编辑' },
    { key: 'remove', label: () => '删除' },
  ],
  queued: [
    { key: 'unqueue', label: () => '撤回到待办' },
    { key: 'stop', label: () => '停止' },
    { key: 'openSession', label: () => '打开会话', when: (card) => !!card.sessionId },
    { key: 'openSplit', label: () => '在分屏中打开', when: (card) => !!card.sessionId },
    { key: 'remove', label: () => '删除' },
  ],
  running: [
    { key: 'stop', label: () => '停止' },
    { key: 'openSession', label: () => '打开会话', when: (card) => !!card.sessionId },
    { key: 'openSplit', label: () => '在分屏中打开', when: (card) => !!card.sessionId },
  ],
  approval: [
    { key: 'approval', label: () => '去处理审批', primary: true },
    { key: 'stop', label: () => '停止' },
  ],
  review: [
    { key: 'approve', label: () => '通过', primary: true },
    { key: 'reject', label: () => '打回…' },
    { key: 'openSession', label: () => '打开会话', when: (card) => !!card.sessionId },
    { key: 'openSplit', label: () => '在分屏中打开', when: (card) => !!card.sessionId },
    { key: 'remove', label: () => '删除' },
  ],
  done: [
    { key: 'openSession', label: () => '打开会话', when: (card) => !!card.sessionId },
    { key: 'viewDiff', label: () => '查看改动', when: (card) => !!card.result?.branch },
    { key: 'viewChecks', label: () => '查看测试/检查结果', when: (card) => !!card.sessionId },
    { key: 'merge', label: (_card, board) => `合并到 ${board.baseBranch ?? '基准分支'}`, primary: true, when: canMerge },
    { key: 'retry', label: () => '重新运行', when: (card) => !!card.sessionId },
    { key: 'openSplit', label: () => '在分屏中打开', when: (card) => !!card.sessionId },
    { key: 'remove', label: () => '删除' },
  ],
  failed: [
    { key: 'viewError', label: () => '查看错误', when: (card) => !!card.error },
    { key: 'retry', label: () => '重试', primary: true },
    { key: 'openSession', label: () => '打开会话', when: (card) => !!card.sessionId },
    { key: 'openSplit', label: () => '在分屏中打开', when: (card) => !!card.sessionId },
    { key: 'edit', label: () => '编辑' },
    { key: 'remove', label: () => '删除' },
  ],
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-[13px]">
      <dt className="text-text-tertiary">{label}</dt>
      <dd className="min-w-0 break-words text-text-secondary">{children}</dd>
    </div>
  )
}

const ACTION_ICON: Partial<Record<CardActionKey, React.ReactNode>> = {
  openSession: <ExternalLink />,
  openSplit: <PanelRightOpen size={13} />,
  viewDiff: <FileDiff size={13} />,
  viewChecks: <TerminalSquare size={13} />,
  viewError: <AlertTriangle size={13} />,
  merge: <GitMerge size={13} />,
  retry: <RotateCcw size={13} />,
  start: <PlayCircle size={13} />,
  edit: <Pencil />,
  remove: <Trash2 />,
}

/** 按状态映射表渲染动作；桌面抽屉、手机列表与详情共用。 */
export function CardActionBar({ card, board, actions, className }: { card: BoardCard; board: Board; actions: CardActions; className?: string }) {
  const [errorOpen, setErrorOpen] = useState(false)
  const defs = CARD_ACTIONS_BY_STATUS[card.status].filter((def) => !def.when || def.when(card, board))
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {defs.map((def) => {
        const run = () => {
          switch (def.key) {
            case 'start':
              actions.start(card)
              break
            case 'unqueue':
              actions.unqueue(card)
              break
            case 'stop':
              actions.stop(card)
              break
            case 'approval':
              actions.openSession(card)
              break
            case 'approve':
              actions.approve(card)
              break
            case 'reject':
              actions.reject(card)
              break
            case 'retry':
              actions.retry(card)
              break
            case 'merge':
              void actions.merge(card)
              break
            case 'openSession':
              actions.openSession(card)
              break
            case 'viewDiff':
              actions.viewDiff(card)
              break
            case 'viewChecks':
              actions.viewChecks(card)
              break
            case 'viewError':
              setErrorOpen(true)
              break
            case 'openSplit':
              actions.openSplit(card)
              break
            case 'edit':
              actions.edit(card)
              break
            case 'remove':
              actions.remove(card)
              break
          }
        }
        return (
          <Button
            key={def.key}
            variant={def.key === 'remove' ? 'danger-ghost' : def.primary ? 'primary' : 'secondary'}
            icon={ACTION_ICON[def.key]}
            onClick={run}
            data-card-action={def.key}
          >
            {def.label(card, board)}
          </Button>
        )
      })}
      <Modal
        open={errorOpen}
        onClose={() => setErrorOpen(false)}
        title="卡片错误"
        className="max-w-lg"
        footer={
          <Button size="lg" onClick={() => setErrorOpen(false)}>
            关闭
          </Button>
        }
      >
        <pre className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-words text-[13px] leading-6 text-danger">
          {card.error ?? '没有记录错误信息'}
        </pre>
      </Modal>
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
                <button data-raw-button
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
