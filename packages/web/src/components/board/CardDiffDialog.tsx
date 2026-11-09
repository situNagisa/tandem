import { useEffect, useState } from 'react'
import { GitBranch} from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import type { BoardCardDiff } from '@tandem/protocol'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import type { HostConfig } from '../../lib/types'
import { DiffView } from '../DiffView'
import { Modal } from '../ui/Modal'

/** 卡片 worktree 分支相对起点的改动审阅（完成后也能核对改了什么）。 */
export function CardDiffDialog({
  open,
  host,
  boardId,
  cardId,
  title,
  onClose,
}: {
  open: boolean
  host: HostConfig | null
  boardId: string
  cardId: string
  title?: string
  onClose: () => void
}) {
  const [summary, setSummary] = useState<BoardCardDiff | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !host) return
    let cancelled = false
    setSummary(null)
    setSelected(null)
    setDiff(null)
    setError(null)
    setLoading(true)
    api
      .boardCardDiff(host, boardId, cardId)
      .then((value) => {
        if (cancelled) return
        setSummary(value)
        setSelected(value.files[0]?.path ?? null)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取改动失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, host, boardId, cardId])

  useEffect(() => {
    if (!open || !host || !selected) {
      setDiff(null)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .boardCardDiff(host, boardId, cardId, selected)
      .then((value) => {
        if (!cancelled) setDiff(value.diff)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取 diff 失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, host, boardId, cardId, selected])

  const files = summary?.files ?? []
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={title ? `改动：${title}` : '卡片改动'}
      title={title ? `改动：${title}` : '卡片改动'}
      className="h-[min(760px,92dvh)] w-[min(960px,96vw)]"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
    >
      <div className="flex min-h-0 flex-1 max-sm:flex-col">
        <div className="w-[260px] shrink-0 overflow-y-auto border-r border-border max-sm:w-full max-sm:max-h-40 max-sm:border-b max-sm:border-r-0">
          <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[12px] text-muted">
            <GitBranch size={12} aria-hidden />
            <span className="min-w-0 truncate font-mono">{summary?.branch ?? '分支'}</span>
            {summary?.base ? <span className="shrink-0 truncate text-text-tertiary">← {summary.base.slice(0, 8)}</span> : null}
          </div>
          {files.length === 0 ? (
            <p className="px-3 py-4 text-[13px] text-text-secondary">这张卡没有可展示的改动。</p>
          ) : (
            <div className="py-1">
              {files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelected(file.path)}
                  data-testid="card-diff-file"
                  className={cn(
                    'flex h-7 w-full items-center gap-1.5 px-2.5 text-left font-mono text-[12px] transition-colors',
                    selected === file.path
                      ? 'bg-[var(--t-bg-active)] text-text'
                      : 'text-text-soft hover:bg-[var(--t-bg-hover)]',
                  )}
                  data-tip={file.path}
                >
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  <span className="shrink-0 text-[var(--t-git-plus)]">+{file.additions}</span>
                  <span className="shrink-0 text-[var(--t-git-minus)]">−{file.deletions}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {error ? (
            <p className="rounded-lg border border-danger/30 bg-danger-soft/40 px-3 py-2 text-[13px] text-danger">{error}</p>
          ) : loading ? (
            <div className="flex h-full items-center justify-center text-muted">
              <Spinner size={16} />
            </div>
          ) : diff ? (
            <>
              {summary?.truncated ? (
                <p className="mb-2 rounded-lg border border-border bg-[var(--t-bg-hover)] px-3 py-2 text-[12px] text-muted">
                  diff 过大，已截断为前 1MB / 2 万行。
                </p>
              ) : null}
              <DiffView unified={diff} fileName={selected ?? undefined} maxHeight={100000} />
            </>
          ) : (
            <p className="px-1 py-4 text-[13px] text-text-secondary">选择左侧文件查看 diff。</p>
          )}
        </div>
      </div>
    </Modal>
  )
}
