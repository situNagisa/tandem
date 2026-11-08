import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Loader2, Undo2 } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'
import { Button } from './Button'
import { Modal } from './Modal'

export interface ConfirmActionProps {
  open: boolean
  title: string
  /** 一句话说明将要发生什么；需要分点时用 impacts。 */
  description?: ReactNode
  /** 影响范围：逐条列出（如将合并的卡、会改动的文件）。 */
  impacts?: ReactNode[]
  /** 额外内容（diff、预览等）。 */
  children?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** 不可逆操作：确认按钮用危险样式。 */
  danger?: boolean
  /** 覆盖默认的危险提示文案。 */
  dangerText?: string
  /** 确认回调执行期间禁用按钮。 */
  onConfirm: () => void | Promise<void>
  onClose: () => void
  /** 文案给定时，确认后弹出提示；配合 undo 在提示里保留「撤销」N 秒。 */
  successText?: string
  undo?: { label?: string; seconds?: number; onUndo: () => void | Promise<void> }
  className?: string
  testId?: string
}

/**
 * 危险/不可逆操作的统一确认框：标题 + 影响范围 + 明确按钮，默认焦点在「取消」。
 * 可撤销的操作传入 undo，执行完用带「撤销」的提示条兜底，保留 N 秒。
 */
export function ConfirmAction({
  open,
  title,
  description,
  impacts,
  children,
  confirmLabel,
  cancelLabel = '取消',
  danger = false,
  dangerText,
  onConfirm,
  onClose,
  successText,
  undo,
  className,
  testId,
}: ConfirmActionProps) {
  const toast = useUiStore((s) => s.toast)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) setPending(false)
  }, [open])

  const confirm = async () => {
    if (pending) return
    setPending(true)
    try {
      await onConfirm()
      onClose()
      const text = successText ?? (undo ? '已完成' : undefined)
      if (text) {
        toast(text, 'success', {
          ...(undo
            ? {
                actionLabel: undo.label ?? '撤销',
                durationMs: Math.max(4, undo.seconds ?? 8) * 1000,
                onClick: () => void undo.onUndo(),
              }
            : {}),
        })
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!pending) onClose()
      }}
      ariaLabel={title}
      title={title}
      className={cn('w-[min(520px,94vw)]', className)}
      bodyClassName="p-4"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button size="lg" onClick={onClose} disabled={pending} data-autofocus>
            {cancelLabel}
          </Button>
          <Button
            size="lg"
            variant={danger ? 'danger-ghost' : 'primary'}
            onClick={() => void confirm()}
            disabled={pending}
            data-testid={testId ? `${testId}-confirm` : undefined}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {description ? (
        <p className="text-[13px] leading-6 text-text-soft">{description}</p>
      ) : null}
      {impacts && impacts.length > 0 ? (
        <ul className="mt-2.5 space-y-1 text-[13px] leading-5 text-text-soft" data-testid={testId ? `${testId}-impacts` : undefined}>
          {impacts.map((item, index) => (
            <li key={index} className="flex items-start gap-1.5">
              <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-text-tertiary" />
              <span className="min-w-0 flex-1 break-words">{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {danger ? (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger-soft/40 px-2.5 py-2 text-[12px] leading-5 text-danger">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{dangerText ?? '此操作不可撤销，请确认影响范围后再执行。'}</span>
        </p>
      ) : undo ? (
        <p className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-5 text-muted">
          <Undo2 size={13} className="mt-0.5 shrink-0" />
          <span>执行后 {Math.max(4, undo.seconds ?? 8)} 秒内在提示条里可以撤销。</span>
        </p>
      ) : null}
      {children ? <div className="mt-3">{children}</div> : null}
    </Modal>
  )
}
