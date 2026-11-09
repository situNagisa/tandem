// 任务看板的纯函数：列定义、拖动规则、分组与文案。不依赖 React，便于单测。
import type { Board, BoardCard, BoardCardAction, BoardCardStatus } from '@tandem/protocol'
import { formatDuration as formatDurationShared } from './format'

export const COLUMNS: Array<{ status: BoardCardStatus; label: string; hint: string }> = [
  { status: 'todo', label: '待办', hint: '草稿，放行后才会运行' },
  { status: 'queued', label: '排队', hint: '已放行，等依赖与并发槽' },
  { status: 'running', label: '运行中', hint: '卡片会话正在运行' },
  { status: 'approval', label: '待审批', hint: '卡片在等工具审批' },
  { status: 'review', label: '待评审', hint: '已完成，等你通过或打回' },
  { status: 'done', label: '完成', hint: '已完成' },
  { status: 'failed', label: '失败', hint: '失败，可重试' },
]

export const STATUS_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.status, c.label])) as Record<BoardCardStatus, string>

export type DropPlan =
  | { kind: 'reorder' }
  | { kind: 'action'; action: BoardCardAction; needsNote?: boolean }

/** 把"卡片从 from 列拖到 to 列"翻译成人的意图；null 表示该投放不被允许。 */
export function planDrop(from: BoardCardStatus, to: BoardCardStatus): DropPlan | null {
  if (from === to) return from === 'running' || from === 'approval' ? null : { kind: 'reorder' }
  if (from === 'todo' && to === 'queued') return { kind: 'action', action: 'start' }
  if (from === 'queued' && to === 'todo') return { kind: 'action', action: 'unqueue' }
  if (from === 'failed' && to === 'queued') return { kind: 'action', action: 'retry' }
  if (from === 'review' && to === 'done') return { kind: 'action', action: 'approve' }
  if (from === 'review' && to === 'queued') return { kind: 'action', action: 'reject', needsNote: true }
  if ((from === 'running' || from === 'approval') && to === 'todo') return { kind: 'action', action: 'stop' }
  return null
}

export function cardsOf(board: Board, status: BoardCardStatus): BoardCard[] {
  return board.cards.filter((card) => card.status === status).sort((a, b) => a.order - b.order)
}

/** 手机列表的分组：需要我的在最前。 */
export const MOBILE_GROUPS: Array<{ key: string; label: string; statuses: BoardCardStatus[] }> = [
  { key: 'me', label: '需要我', statuses: ['approval', 'review', 'failed'] },
  { key: 'running', label: '运行中', statuses: ['running'] },
  { key: 'queued', label: '排队', statuses: ['queued'] },
  { key: 'todo', label: '待办', statuses: ['todo'] },
  { key: 'done', label: '完成', statuses: ['done'] },
]

export function needsMeCount(board: Pick<Board, 'cards'>): number {
  return board.cards.filter((card) => card.status === 'approval' || card.status === 'review' || card.status === 'failed').length
}

const BLOCKED_TEXT: Record<NonNullable<BoardCard['blocked']>, string> = {
  waiting: '等待依赖完成',
  upstream_failed: '上游失败',
  slot: '等待并发槽',
  dir: '等待同目录的卡完成',
}

/** 排队卡的一行状态文案：具体到"等待 A、B"。 */
export function queuedText(card: BoardCard, cards: BoardCard[], now = Date.now()): string | undefined {
  if (card.status !== 'queued') return undefined
  if (card.retryAt && card.retryAt > now) return `${Math.max(1, Math.ceil((card.retryAt - now) / 1000))} 秒后重试`
  if (!card.blocked) return undefined
  if (card.blocked === 'waiting') {
    const names = card.deps
      .map((id) => cards.find((item) => item.id === id))
      .filter((dep): dep is BoardCard => !!dep && dep.status !== 'done')
      .map((dep) => dep.title)
    if (names.length > 0) return `等待 ${names.join('、')}`
  }
  return BLOCKED_TEXT[card.blocked]
}

export function formatUsd(value: number | undefined): string {
  if (!value) return '$0'
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

export function formatDuration(ms: number | undefined): string {
  return formatDurationShared(ms, 'human')
}

export function boardCost(board: Pick<Board, 'cards'>): number {
  return board.cards.reduce((sum, card) => sum + (card.result?.costUsd ?? 0), 0)
}

/** 依赖里还没完成的卡数（用于卡片上的 ← 提示）。 */
export function depTitles(card: BoardCard, cards: BoardCard[]): string[] {
  return card.deps
    .map((id) => cards.find((item) => item.id === id)?.title)
    .filter((title): title is string => !!title)
}

/** 新卡依赖候选：排除自己与会形成环的卡（即所有直接/间接依赖了自己的卡）。 */
export function dependencyCandidates(card: Pick<BoardCard, 'id'>, cards: BoardCard[]): BoardCard[] {
  const downstream = new Set<string>([card.id])
  let changed = true
  while (changed) {
    changed = false
    for (const item of cards) {
      if (!downstream.has(item.id) && item.deps.some((dep) => downstream.has(dep))) {
        downstream.add(item.id)
        changed = true
      }
    }
  }
  return cards.filter((item) => !downstream.has(item.id))
}
