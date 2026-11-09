import { useEffect, useState } from 'react'
import { FileDiff, GitBranch, Loader2 } from 'lucide-react'
import type { Board, BoardMergePreview } from '@tandem/protocol'
import { api } from '../../lib/api'
import type { HostConfig } from '../../lib/types'
import { Button } from '../ui/Button'
import { ConfirmAction } from '../ui/ConfirmAction'
import { CardDiffDialog } from './CardDiffDialog'

/**
 * 看板合并前确认：目标分支、将合并的卡、每张卡改动的文件与 +/−，
 * 可逐张点开看 diff。单卡合并只列那一张；「合并」按钮列全部待合并卡。
 */
export function MergeConfirmDialog({
  open,
  host,
  board,
  cardId,
  onClose,
  onConfirm,
}: {
  open: boolean
  host: HostConfig | null
  board: Board
  /** 给出时只合并这一张卡；缺省为按依赖顺序合并全部已完成卡。 */
  cardId?: string
  onClose: () => void
  onConfirm: (cardIds: string[]) => Promise<void> | void
}) {
  const [preview, setPreview] = useState<BoardMergePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diffCard, setDiffCard] = useState<{ id: string; title: string } | null>(null)

  useEffect(() => {
    if (!open || !host) return
    let cancelled = false
    setPreview(null)
    setError(null)
    setLoading(true)
    api
      .boardMergePreview(host, board.id)
      .then((value) => {
        if (!cancelled) setPreview(value)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取合并预览失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, host, board.id])

  const base = preview?.baseBranch ?? board.baseBranch ?? '基准分支'
  const cards = cardId
    ? (preview?.cards ?? []).filter((card) => card.id === cardId)
    : (preview?.cards ?? [])
  const totalFiles = cards.reduce((n, card) => n + card.files, 0)
  const totalAdd = cards.reduce((n, card) => n + card.additions, 0)
  const totalDel = cards.reduce((n, card) => n + card.deletions, 0)

  return (
    <>
      <ConfirmAction
        open={open}
        title={cardId ? '合并这张卡' : '合并全部已完成卡'}
        description={
          loading
            ? '正在读取将要合并的卡片与改动…'
            : error
              ? error
              : cards.length === 0
                ? `没有可合并的已完成卡（需要卡片分支且尚未合并）。`
                : `将把 ${cardId ? '这张卡的分支' : `${cards.length} 张卡的分支`}合并到 ${base}（squash 提交），共 ${totalFiles} 个文件 +${totalAdd} −${totalDel}。`
        }
        dangerText={`会把改动直接写入 ${base}；合并后主工作区的代码会立即变化。`}
        danger
        confirmLabel={
          loading
            ? '读取中…'
            : cards.length > 0
              ? cardId
                ? `合并到 ${base}`
                : `合并 ${cards.length} 张到 ${base}`
              : '关闭'
        }
        onConfirm={async () => {
          if (cards.length === 0) return
          await onConfirm(cards.map((card) => card.id))
        }}
        onClose={onClose}
        testId="board-merge-confirm"
      >
        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : (
          <div className="space-y-2" data-testid="board-merge-cards">
            {cards.map((card) => (
              <div key={card.id} className="rounded-lg border border-border p-2.5">
                <div className="flex items-center gap-1.5 text-[13px] text-text">
                  <span className="min-w-0 flex-1 break-words">{card.title}</span>
                  <span className="shrink-0 font-mono text-[12px] text-[var(--t-git-plus)]">+{card.additions}</span>
                  <span className="shrink-0 font-mono text-[12px] text-[var(--t-git-minus)]">−{card.deletions}</span>
                </div>
                <p className="mt-0.5 flex items-center gap-1 font-mono text-[12px] text-text-tertiary">
                  <GitBranch size={11} aria-hidden />
                  <span className="min-w-0 truncate">{card.branch}</span>
                  <span className="shrink-0">· {card.files} 个文件</span>
                </p>
                {card.fileList.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5" data-testid="board-merge-files">
                    {card.fileList.map((file) => (
                      <li key={file.path} className="flex items-center gap-1.5 font-mono text-[12px] text-text-secondary">
                        <span className="min-w-0 flex-1 truncate" data-tip={file.path}>
                          {file.path}
                        </span>
                        <span className="shrink-0 text-[var(--t-git-plus)]">+{file.additions}</span>
                        <span className="shrink-0 text-[var(--t-git-minus)]">−{file.deletions}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1.5 px-1.5 text-[12px]"
                  icon={<FileDiff size={12} />}
                  onClick={() => setDiffCard({ id: card.id, title: card.title })}
                >
                  查看 diff
                </Button>
              </div>
            ))}
          </div>
        )}
      </ConfirmAction>
      <CardDiffDialog
        open={!!diffCard}
        host={host}
        boardId={board.id}
        cardId={diffCard?.id ?? ''}
        title={diffCard?.title}
        onClose={() => setDiffCard(null)}
      />
    </>
  )
}
