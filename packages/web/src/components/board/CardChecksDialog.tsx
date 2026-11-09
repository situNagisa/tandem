import { useEffect, useState } from 'react'
import { TerminalSquare } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import type { BoardCardCheck } from '@tandem/protocol'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import type { HostConfig } from '../../lib/types'
import { Modal } from '../ui/Modal'

/** 卡片会话里最近一次测试/检查命令的结果（完成后核对是否真的跑过测试）。 */
export function CardChecksDialog({
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
  const [check, setCheck] = useState<BoardCardCheck | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !host) return
    let cancelled = false
    setCheck(null)
    setError(null)
    setLoading(true)
    api
      .boardCardChecks(host, boardId, cardId)
      .then((value) => {
        if (!cancelled) setCheck(value.check ?? null)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取测试结果失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, host, boardId, cardId])

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="测试与检查结果"
      title={title ? `测试与检查：${title}` : '测试与检查结果'}
      className="max-h-[80dvh] w-[min(720px,94vw)]"
      bodyClassName="min-h-0 flex-1 overflow-y-auto p-4"
    >
      {loading ? (
        <div className="flex items-center justify-center py-10 text-muted">
          <Spinner size={16} />
        </div>
      ) : error ? (
        <p className="text-[13px] text-danger">{error}</p>
      ) : !check ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <TerminalSquare size={22} className="text-text-tertiary" />
          <p className="text-[13px] text-text-secondary">这张卡的会话里没有运行过测试/检查命令。</p>
          <p className="max-w-[380px] text-[12px] leading-5 text-muted">
            识别 npm test、pnpm check、pytest、go test、cargo test、tsc、vitest、node scripts/check.mjs 等命令。
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-bg/60 px-3 py-2">
            <p className="text-[12px] text-muted">命令</p>
            <code className="mt-0.5 block break-all font-mono text-[12px] text-text">{check.command}</code>
          </div>
          <p className={cn('text-[12px]', check.isError ? 'text-danger' : 'text-[var(--t-git-plus)]')}>
            {check.isError ? '最近一次结果：失败' : '最近一次结果：成功'}
          </p>
          <pre
            data-testid="board-card-check-output"
            className="max-h-[46dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2/40 p-3 font-mono text-[12px] leading-5 text-text-soft"
          >
            {check.output}
          </pre>
        </div>
      )}
    </Modal>
  )
}
