import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import type { EvalCase, EvalResult, EvalRun } from '@tandem/protocol'
import { cn } from '../../lib/cn'
import { formatCost, formatDuration, resultLabel } from './evalDisplay'
import { MessageList } from '../MessageList'
import { Modal } from '../ui/Modal'
import { MenuSelect } from '../ui/Menu'
import { collectToolResults } from './evalDisplay'

function Pane({
  run,
  testCase,
  result,
}: {
  run: EvalRun
  testCase?: EvalCase
  result?: EvalResult
}) {
  const config = run.configs.find((item) => item.id === result?.configId)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-border max-md:border-t md:border-l">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-[12px]">
        <span className="min-w-0 flex-1 truncate font-medium text-text">{config?.name ?? '—'}</span>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5',
            result?.passed
              ? 'bg-success-soft text-success'
              : result && (result.status === 'running' || result.status === 'queued')
                ? 'bg-[var(--t-bg-hover)] text-muted'
                : 'bg-danger-soft text-danger',
          )}
        >
          {result?.status === 'running' || result?.status === 'queued' ? (
            <Spinner size={11} />
          ) : result?.passed ? (
            <CheckCircle2 size={11} />
          ) : (
            <XCircle size={11} />
          )}
          {resultLabel(result)}
        </span>
        <span className="text-muted">{formatCost(result?.costUsd)}</span>
        <span className="text-muted">{formatDuration(result?.durationMs ?? 0)}</span>
      </div>
      {result?.check && (
        <div className="border-b border-border px-3 py-1.5 text-[12px]">
          <span className={result.check.ok ? 'text-success' : 'text-danger'}>
            检查命令 {result.check.ok ? '通过' : `失败（${result.check.exitCode ?? 'null'}）`}
          </span>
          {result.review && (
            <span className={cn('ml-3', result.review.verdict === 'pass' ? 'text-success' : 'text-danger')}>
              评审 {result.review.verdict === 'pass' ? '通过' : '不通过'}
            </span>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2">
        {result?.messages && result.messages.length > 0 ? (
          <MessageList
            messages={result.messages}
            readOnly
            toolResults={collectToolResults(result.messages)}
            cwd={testCase?.snapshot.cwd}
          />
        ) : (
          <p className="py-8 text-center text-[12px] text-muted">没有可显示的轨迹</p>
        )}
      </div>
    </div>
  )
}

/** 两个配置并排查看同一用例的完整轨迹。 */
export function EvalCompareDialog({
  open,
  onClose,
  run,
  testCase,
}: {
  open: boolean
  onClose: () => void
  run?: EvalRun
  testCase?: EvalCase
}) {
  const configs = run?.configs ?? []
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  useEffect(() => {
    if (!open || configs.length === 0) return
    setLeft(configs[0]?.id ?? '')
    setRight(configs[1]?.id ?? configs[0]?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, run?.id, configs.length])
  const options = useMemo(
    () => configs.map((config) => ({ value: config.id, label: config.name, hint: config.model })),
    [configs],
  )
  const resultOf = (configId: string) =>
    run?.results.find((item) => item.caseName === testCase?.name && item.configId === configId)
  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="评测并排对比"
      layer={70}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">并排对比 · {testCase?.title ?? '评测用例'}</span>
        </span>
      }
      className="h-[min(90dvh,940px)] w-[min(98vw,1480px)] max-w-none max-sm:fixed max-sm:inset-0 max-sm:my-0 max-sm:h-auto max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="w-10 shrink-0 text-[12px] text-muted">左侧</span>
        <MenuSelect
          value={left}
          onChange={setLeft}
          options={options}
          size="sm"
          wrapperClassName="w-[min(280px,40vw)]"
          aria-label="左侧配置"
        />
        <span className="mx-1 text-[12px] text-muted">vs</span>
        <span className="w-10 shrink-0 text-[12px] text-muted">右侧</span>
        <MenuSelect
          value={right}
          onChange={setRight}
          options={options}
          size="sm"
          wrapperClassName="w-[min(280px,40vw)]"
          aria-label="右侧配置"
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        {run && (
          <>
            <Pane run={run} testCase={testCase} result={resultOf(left)} />
            <Pane run={run} testCase={testCase} result={resultOf(right)} />
          </>
        )}
      </div>
    </Modal>
  )
}
