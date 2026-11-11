import { CheckCircle2, CircleSlash, XCircle } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { Badge } from '../ui/Badge'
import type { EvalCase, EvalResult, EvalRun } from '@tandem/protocol'
import { cn } from '../../lib/cn'
import { MessageList } from '../MessageList'
import { Modal } from '../ui/Modal'
import { collectToolResults, formatCost, formatDuration, resultLabel } from './evalDisplay'

function VerdictIcon({ result }: { result?: EvalResult }) {
  if (!result) return null
  if (result.status === 'running' || result.status === 'queued') {
    return <Spinner size={14} className="text-muted" />
  }
  if (result.status === 'cancelled' || result.status === 'failed' || !result.passed) {
    return <XCircle size={14} className="text-danger" />
  }
  return <CheckCircle2 size={14} className="text-success" />
}

/** 只读轨迹：直接复用消息列表渲染。 */
export function EvalTraceDialog({
  open,
  onClose,
  run,
  testCase,
  result,
}: {
  open: boolean
  onClose: () => void
  run?: EvalRun
  testCase?: EvalCase
  result?: EvalResult
}) {
  const config = run?.configs.find((item) => item.id === result?.configId)
  const toolResults = collectToolResults(result?.messages)
  const status = resultLabel(result)
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="评测轨迹"
      layer={70}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <VerdictIcon result={result} />
          <span className="truncate">{testCase?.title ?? result?.caseTitle ?? '评测轨迹'}</span>
          <span className="shrink-0 text-[12px] font-normal text-muted">
            {config?.name ?? result?.configName ?? ''}
          </span>
        </span>
      }
      className="h-[min(88dvh,900px)] w-[min(96vw,1040px)] max-w-none max-sm:fixed max-sm:inset-0 max-sm:my-0 max-sm:h-auto max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
    >
      {!result ? (
        <div className="flex flex-1 items-center justify-center p-10 text-[13px] text-muted">
          未找到这次运行的结果
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 text-[12px] text-text-soft">
            <Badge
              tone={
                result.passed
                  ? 'success'
                  : result.status === 'running' || result.status === 'queued'
                    ? 'neutral'
                    : 'danger'
              }
            >
              {status}
            </Badge>
            <span>花费 {formatCost(result.costUsd)}</span>
            <span>耗时 {formatDuration(result.durationMs)}</span>
            <span>
              {result.turns} 轮 · {result.toolCalls} 次工具
            </span>
            <span>
              输入 {result.usage.inputTokens} / 输出 {result.usage.outputTokens}
            </span>
            {result.check && (
              <span className={result.check.ok ? 'text-success' : 'text-danger'}>
                检查命令 {result.check.ok ? '通过' : `失败（退出码 ${result.check.exitCode ?? 'null'}）`}
              </span>
            )}
            {result.review && (
              <span className={result.review.verdict === 'pass' ? 'text-success' : 'text-danger'}>
                评审 {result.review.verdict === 'pass' ? '通过' : '不通过'}
              </span>
            )}
          </div>
          {(result.error || result.review || result.check) && (
            <div className="max-h-[220px] shrink-0 space-y-2 overflow-y-auto border-b border-border bg-bg/40 px-4 py-2.5 text-[12px] leading-5">
              {result.error && (
                <div className="flex items-start gap-1.5 text-danger">
                  <CircleSlash size={13} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 break-words">{result.error}</span>
                </div>
              )}
              {result.review && (
                <div className="text-text-soft">
                  <span className="text-muted">评审理由：</span>
                  {result.review.reason}
                </div>
              )}
              {result.check && (
                <details className="text-text-soft">
                  <summary className="cursor-pointer select-none text-muted">
                    检查命令 <code className="font-mono">{result.check.command}</code>
                  </summary>
                  <pre className="mt-1 max-h-[140px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--t-bg-hover)] px-2 py-1.5 font-mono text-[12px] leading-5">
                    {result.check.output || '(无输出)'}
                  </pre>
                </details>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
            {result.messages && result.messages.length > 0 ? (
              <div className="mx-auto w-full max-w-[860px]">
                <MessageList
                  messages={result.messages}
                  readOnly
                  toolResults={toolResults}
                  cwd={testCase?.snapshot.cwd}
                />
              </div>
            ) : (
              <p className="py-12 text-center text-[12.5px] text-muted">
                {result.status === 'running' ? '运行中，轨迹将在完成后写入。' : '没有可显示的轨迹。'}
              </p>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}
