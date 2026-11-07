import { useEffect, useRef, useState } from 'react'
import { Check, Maximize2, MessageSquareText, ScrollText, X } from 'lucide-react'
import type { PermissionRequest } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useSessionTarget } from './session/SessionScope'
import { Markdown } from './Markdown'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

function planText(request: PermissionRequest): string {
  const input =
    request.input && typeof request.input === 'object'
      ? (request.input as Record<string, unknown>)
      : {}
  return typeof input.plan === 'string' ? input.plan.trim() : ''
}

/** 计划模式下 ExitPlanMode 的审批卡片：显示在上方输入框之上，可全屏阅读。 */
export function PlanCard({ request, more }: { request: PermissionRequest; more: number }) {
  const decide = useAppStore((s) => s.decidePermission)
  const scopeTarget = useSessionTarget() ?? undefined
  const [expanded, setExpanded] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  const plan = planText(request) || '（模型没有提交计划内容）'

  useEffect(() => {
    if (feedbackOpen) feedbackRef.current?.focus()
  }, [feedbackOpen])

  const submitFeedback = () => {
    const text = feedback.trim()
    if (!text) return
    decide(request.id, 'deny', text, scopeTarget)
  }

  return (
    <div className="permission-card mb-2.5">
      <div className="flex items-center gap-2.5 border-b border-border/70 px-4 py-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-text-secondary">
          <ScrollText size={14} />
        </span>
        <span className="text-[13.5px] font-semibold text-text">计划</span>
        <span className="rounded border border-border px-1.5 py-px text-[12px] text-muted">
          等待批准
        </span>
        {more > 0 && <span className="text-[12px] text-muted">另有 {more} 个待审批</span>}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setExpanded(true)}
          icon={<Maximize2 size={13} />}
          className="min-h-11 sm:min-h-[28px]"
        >
          全屏阅读
        </Button>
      </div>

      <div className="max-h-[min(38dvh,360px)] overflow-y-auto px-4 py-3">
        <Markdown text={plan} />
      </div>

      {feedbackOpen ? (
        <div className="border-t border-border/70 px-4 py-3">
          <label className="block">
            <span className="mb-1 block text-[13px] text-muted">
              告诉模型需要怎么完善计划（会作为拒绝反馈回填）
            </span>
            <textarea
              ref={feedbackRef}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
              placeholder="例如：先补充错误处理和回滚方案，再开始实施。"
              className="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-[13px] leading-5 text-text outline-none placeholder:text-muted focus-visible:border-border-strong"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  submitFeedback()
                }
              }}
            />
          </label>
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setFeedbackOpen(false)}>
              取消
            </Button>
            <Button size="sm" variant="primary" onClick={submitFeedback} disabled={!feedback.trim()}>
              <MessageSquareText size={13} />
              提交反馈
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border/70 px-3 py-2.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFeedbackOpen(true)}
            className="min-h-11 sm:min-h-[28px]"
          >
            <MessageSquareText size={13} />
            继续完善
          </Button>
          <Button
            size="sm"
            onClick={() => decide(request.id, 'allow', undefined, scopeTarget)}
            className="min-h-11 sm:min-h-[28px]"
          >
            批准并开始执行（逐个询问）
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => decide(request.id, 'allow_always', undefined, scopeTarget)}
            icon={<Check size={13} />}
            className="min-h-11 sm:min-h-[28px]"
          >
            批准并开始执行（自动接受编辑）
          </Button>
        </div>
      )}

      <Modal
        open={expanded}
        onClose={() => setExpanded(false)}
        title="计划"
        description="批准前可完整阅读；关闭后仍会显示在输入框上方与右侧信息栏。"
        className="max-w-[min(820px,94vw)]"
        bodyClassName="p-5"
        footer={
          <Button size="lg" onClick={() => setExpanded(false)} icon={<X size={14} />}>
            关闭
          </Button>
        }
      >
        <Markdown text={plan} />
      </Modal>
    </div>
  )
}
