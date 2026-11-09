import { useState } from 'react'
import { ChevronRight, FileText, RotateCcw } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import type { Message } from '@tandem/protocol'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import type { UiMessage } from '../../lib/types'
import { Button } from '../ui/Button'
import { ConfirmAction } from '../ui/ConfirmAction'
import { Modal } from '../ui/Modal'

function blocksText(message: Message): string {
  const lines: string[] = []
  for (const block of message.content) {
    if (block.type === 'text' || block.type === 'thinking') {
      const text = block.text.trim()
      if (text) lines.push(block.type === 'thinking' ? `（思考）${text}` : text)
    } else if (block.type === 'tool_use') {
      const input = block.input as { command?: unknown; file_path?: unknown } | null
      const detail =
        typeof input?.command === 'string'
          ? input.command
          : typeof input?.file_path === 'string'
            ? input.file_path
            : JSON.stringify(block.input ?? {}).slice(0, 200)
      lines.push(`〔工具 ${block.name}〕${detail}`)
    } else if (block.type === 'tool_result') {
      const text = block.content.trim()
      if (text) lines.push(`〔结果${block.isError ? '·失败' : ''}〕${text}`)
    }
  }
  return lines.join('\n')
}

/**
 * 「已压缩上下文」提示行：默认显示摘要前两行，可展开摘要全文、查看被压掉的原文、撤销压缩。
 */
export function CompactionNoticeLine({
  message,
  hostId,
  sessionId,
  animate,
}: {
  message: UiMessage
  hostId: string | null
  sessionId: string | null
  animate: boolean
}) {
  const notice = message.compaction
  const toast = useUiStore((s) => s.toast)
  const undoCompaction = useAppStore((s) => s.undoCompaction)
  const [expanded, setExpanded] = useState(false)
  const [original, setOriginal] = useState<{ summary: string; messages: Message[] } | null>(null)
  const [originalOpen, setOriginalOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [confirmUndo, setConfirmUndo] = useState(false)
  const text = message.content
    .filter((b): b is Extract<typeof message.content[number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ')

  if (!notice) return null

  const preview = notice.summary
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('\n')

  const showOriginal = async () => {
    if (!hostId || !sessionId || loading) return
    setLoading(true)
    try {
      const host = useAppStore.getState().hosts.find((item) => item.id === hostId)
      if (!host) throw new Error('主机不存在')
      const value = await api.compactionOriginal(host, sessionId, message.id)
      setOriginal(value)
      setOriginalOpen(true)
    } catch (err) {
      toast(err instanceof Error ? err.message : '读取原文失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className={cn('msg-row px-1 text-[12px] leading-4 text-muted', animate && 'chat-msg-enter')}
      data-message-id={message.id}
      data-compaction-notice="true"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 items-center gap-1 rounded px-0.5 text-left text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
        >
          <ChevronRight
            size={12}
            className={cn('shrink-0 transition-transform', expanded && 'rotate-90')}
          />
          <span>{text}</span>
        </button>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="rounded px-1 py-0.5 text-[12px] text-text-tertiary transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
          >
            {expanded ? '收起摘要' : '展开摘要'}
          </button>
          <button
            type="button"
            onClick={() => void showOriginal()}
            disabled={loading}
            className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[12px] text-text-tertiary transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text disabled:opacity-50"
            data-testid="compaction-original"
          >
            {loading ? <Spinner size={11} /> : <FileText size={11} />}
            查看原文
          </button>
          {notice.canUndo ? (
            <button
              type="button"
              onClick={() => setConfirmUndo(true)}
              className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[12px] text-text-tertiary transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
              data-testid="compaction-undo"
            >
              <RotateCcw size={11} />
              撤销压缩
            </button>
          ) : null}
        </span>
      </div>
      {!expanded ? (
        <pre className="mt-1 max-h-12 overflow-hidden whitespace-pre-wrap rounded-md border border-border bg-surface-2/40 px-2 py-1 text-[12px] leading-4 text-text-soft">
          {preview}
        </pre>
      ) : (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2/50 p-2 text-[12px] leading-4 text-text-soft">
          {notice.summary}
        </pre>
      )}

      <Modal
        open={originalOpen}
        onClose={() => setOriginalOpen(false)}
        title={`压缩前的原文 · ${notice.keptTurns === 0 ? '全部轮次' : `前若干轮（保留最近 ${notice.keptTurns} 轮）`}`}
        className="max-h-[86dvh] w-[min(820px,94vw)]"
        bodyClassName="min-h-0 flex-1 overflow-y-auto p-4"
        footer={
          <Button size="lg" onClick={() => setOriginalOpen(false)}>
            关闭
          </Button>
        }
      >
        <p className="mb-3 text-[12px] leading-5 text-muted">
          这些是压缩时被替换掉的消息，仅供核对；它们不会再发给模型。摘要：
        </p>
        <pre className="mb-3 whitespace-pre-wrap rounded-lg border border-border bg-surface-2/50 p-2.5 text-[12px] leading-5 text-text-soft">
          {notice.summary}
        </pre>
        <div className="space-y-2" data-testid="compaction-original-list">
          {(original?.messages ?? []).map((item) => (
            <div key={item.id} className="rounded-lg border border-border p-2.5">
              <p className="mb-1 text-[12px] text-text-tertiary">
                {item.role === 'user' ? '用户' : '助手'}
                {item.model ? ` · ${item.model}` : ''}
              </p>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-text-secondary">
                {blocksText(item) || '（无文本内容）'}
              </pre>
            </div>
          ))}
        </div>
      </Modal>

      <ConfirmAction
        open={confirmUndo}
        title="撤销压缩"
        description="恢复压缩前的上下文，摘要提示会消失；如果之后再需要压缩，需要重新执行。"
        confirmLabel="撤销压缩"
        successText="已恢复压缩前的上下文"
        onConfirm={async () => {
          if (!hostId || !sessionId) return
          await undoCompaction(message.id, { hostId, sessionId })
        }}
        onClose={() => setConfirmUndo(false)}
        testId="compaction-undo-confirm"
      />
    </div>
  )
}
