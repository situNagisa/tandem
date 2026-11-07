import { useEffect, useState } from 'react'
import type { Checkpoint, ContentBlock } from '@tandem/protocol'
import { Code2, Loader2, MessageSquare, RotateCcw, TriangleAlert } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { api } from '../lib/api'
import { cn } from '../lib/cn'
import type { UiMessage } from '../lib/types'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

type Mode = 'both' | 'conversation' | 'code'

const OPTIONS: Array<{ value: Mode; title: string; description: string; icon: typeof RotateCcw }> = [
  {
    value: 'both',
    title: '恢复代码和对话',
    description: '文件回到此消息之前，对话也删掉这之后的内容',
    icon: RotateCcw,
  },
  {
    value: 'conversation',
    title: '只恢复对话',
    description: '保留当前文件，只回退对话历史',
    icon: MessageSquare,
  },
  {
    value: 'code',
    title: '只恢复代码',
    description: '保留当前对话，只把文件恢复到此前状态',
    icon: Code2,
  },
]

function messageText(message: UiMessage): string {
  return message.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
}

export function RewindDialog({
  message,
  onClose,
}: {
  message: UiMessage
  onClose: () => void
}) {
  const hostId = useAppStore((s) => s.active?.hostId ?? null)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const running = useAppStore((s) => s.active?.running ?? false)
  const messages = useAppStore((s) => s.active?.messages ?? [])
  const rewind = useAppStore((s) => s.rewind)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)

  const targetIndex = messages.findIndex((m) => m.id === message.id)
  const afterCount = targetIndex >= 0 ? messages.length - targetIndex : 0

  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const [mode, setMode] = useState<Mode>('both')
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => {
    if (!host || !sessionId) {
      setLoading(false)
      setError('会话未就绪')
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .checkpoints(host, sessionId)
      .then((list) => {
        if (cancelled) return
        const target = list.find((cp) => cp.messageId === message.id) ?? null
        setCheckpoint(target)
        // 没有检查点时只能回退对话（旧会话、导入会话或本轮没有改过文件）。
        setMode(target ? 'both' : 'conversation')
        if (!target) setError(undefined)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取检查点失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [host, sessionId, message.id])

  const submit = async () => {
    if (submitting || running) return
    const restoreFiles = mode !== 'conversation' && !!checkpoint
    const restoreConversation = mode !== 'code'
    if (!restoreFiles && !restoreConversation) return
    setSubmitting(true)
    const ok = await rewind(
      {
        checkpointId: restoreFiles ? checkpoint!.id : '',
        restoreFiles,
        restoreConversation,
        messageId: message.id,
      },
      restoreConversation ? messageText(message) : undefined,
    )
    setSubmitting(false)
    if (ok) onClose()
  }

  const disabled = running || (!checkpoint && mode !== 'conversation') || submitting

  return (
    <Modal
      open
      onClose={onClose}
      title="回退到此处"
      description={
        checkpoint
          ? '选择一个恢复范围。回退后，此消息之后的 Tandem 文件修改会被撤销。'
          : '选择一个恢复范围。这一轮没有可回退的文件改动，只能恢复对话。'
      }
      className="max-w-lg"
      footer={
        <>
          <Button size="lg" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button size="lg" variant="primary" onClick={() => void submit()} disabled={disabled}>
            {submitting && <Loader2 size={14} className="animate-spin" />}
            回退
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : error ? (
        <p className="rounded-lg border border-danger/30 bg-danger-soft/40 px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-bg/60 px-3 py-2">
            <p className="text-[12px] text-muted">回退到这条消息之前</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-text-soft [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden">
              {messageText(message) || '（这条消息没有文本内容）'}
            </p>
          </div>
          {!checkpoint && (
            <p className="text-[12px] leading-5 text-muted">
              这一轮没有可回退的文件改动（检查点只在本轮开始前有文件被修改时创建），只能恢复对话。
            </p>
          )}
          <div className="space-y-1.5" role="radiogroup" aria-label="恢复范围">
            {OPTIONS.map((option) => {
              const Icon = option.icon
              const active = mode === option.value
              const needsCheckpoint = option.value !== 'conversation'
              const optionDisabled = !checkpoint && needsCheckpoint
              return (
                <button
                  key={option.value}
                  role="radio"
                  aria-checked={active}
                  disabled={optionDisabled}
                  onClick={() => setMode(option.value)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    active
                      ? 'border-[var(--t-border-strong)] bg-[var(--t-bg-active)]'
                      : 'border-border bg-surface/50 hover:bg-[var(--t-bg-hover)]',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md',
                      active ? 'bg-[var(--t-bg-active)] text-text' : 'bg-bg-hover text-muted',
                    )}
                  >
                    <Icon size={13} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-text">{option.title}</span>
                    <span className="mt-0.5 block text-[13px] leading-5 text-muted">
                      {option.description}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft/40 px-3 py-2 text-[13px] leading-5 text-warning">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span className="space-y-1">
              {mode !== 'conversation' && (
                <span className="block">
                  文件会回到此消息之前的状态（Bash 命令造成的改动无法撤销）。
                  {checkpoint && checkpoint.files.length > 0 && ` 本轮快照涉及 ${checkpoint.files.length} 个文件。`}
                </span>
              )}
              {mode !== 'code' && (
                <span className="block">
                  {afterCount > 0
                    ? `这条消息及其后 ${afterCount - 1} 条对话将被删除。`
                    : '这条消息会从对话中移除。'}
                </span>
              )}
              {mode === 'conversation' && <span className="block">当前文件保持不变。</span>}
            </span>
          </div>

          {running && (
            <p className="text-[13px] text-danger">会话正在运行，结束后才能回退。</p>
          )}
        </div>
      )}
    </Modal>
  )
}
