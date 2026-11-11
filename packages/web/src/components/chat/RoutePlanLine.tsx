import { useState } from 'react'
import type { RoutePlan } from '@tandem/protocol'
import { ChevronRight, ScrollText } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Tooltip } from '../ui/Tooltip'

/**
 * 每个任务一行的路由结论提示（模式名与理由由服务端规则给出）。
 * 反馈1323#03：本轮的注入文本要能被看到——有注入时可展开看原文（与「系统提示 · N 段」
 * 同一种呈现），没有注入时说明只用于选择分工与模型。
 */
export function RoutePlanLine({ text, plan }: { text: string; plan: RoutePlan }) {
  const injected = plan.injected ?? []
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const hasInjected = injected.length > 0
  return (
    <div
      className="msg-row flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[12px] leading-4 text-muted"
      data-route-plan={plan.mode}
      data-route-injected={hasInjected ? 'true' : undefined}
    >
      {hasInjected ? (
        <button
          data-raw-button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setMounted(true)
            setOpen((v) => !v)
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors duration-[120ms] hover:bg-[var(--t-bg-hover)] hover:text-text-soft"
        >
          <ScrollText size={12} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1">{text}</span>
          <span className="shrink-0 text-[12px] text-text-tertiary">本轮注入 {injected.length} 段</span>
          <ChevronRight
            size={11}
            className={cn('shrink-0 opacity-60 transition-transform duration-150', open && 'rotate-90')}
          />
        </button>
      ) : (
        <Tooltip
          label={
            plan.mode === 'native'
              ? '原生模式：未向模型注入分工或取向说明'
              : '仅用于选择分工与模型，未向模型注入内容'
          }
          className="flex min-w-0 flex-1 items-center px-1 py-0.5"
        >
          <span className="min-w-0 flex-1">{text}</span>
        </Tooltip>
      )}
      {mounted && (
        <div className="collapse-grid w-full" data-open={open} data-route-injection="">
          <div className="collapse-inner">
            <div className="my-1 space-y-1 rounded-lg border border-border/60 bg-[var(--t-bg-subtle)]/60 p-1.5">
              {injected.map((seg) => (
                <div key={seg.name} className="min-w-0">
                  <div className="px-1 text-[12px] text-muted">{seg.name}</div>
                  <pre className="my-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--t-bg-subtle)] px-2.5 py-2 font-mono text-[12.5px] leading-5 text-text-soft">
                    {seg.content}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
