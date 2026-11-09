import { useState } from 'react'
import { ArrowRightLeft, Clock, Pause } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import type { HandoffReason } from '@tandem/protocol'
import { formatTime } from '../../lib/format'
import { handoffWaitLabel } from '../../lib/quota'
import { cn } from '../../lib/cn'
import { useAppStore } from '../../store/useAppStore'
import { useSessionView } from '../session/SessionScope'
import { Button } from '../ui/Button'

const REASON_TEXT: Record<HandoffReason, string> = {
  ratelimit: '额度将尽',
  budget: '预算即将到达上限',
  forecast: '预计 2 轮内额度耗尽',
}

/** 额度将尽时插在消息流末尾的交接卡：切换备用分组 / 等待重置 / 暂停。 */
export function HandoffCard() {
  const sessionId = useSessionView((s) => s?.sessionId ?? null)
  const hostId = useSessionView((s) => s?.hostId ?? null)
  const state = useSessionView((s) => s?.summary?.handoff ?? null)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const handoffSession = useAppStore((s) => s.handoffSession)
  const [busy, setBusy] = useState<'switch' | 'wait' | 'pause' | null>(null)

  if (!state || state.status === 'done' || state.status === 'paused' || state.status === 'failed') {
    return null
  }
  if (!sessionId || !hostId || !host) return null

  const choose = async (action: 'switch' | 'wait' | 'pause') => {
    if (busy) return
    setBusy(action)
    try {
      await handoffSession(hostId, sessionId, action)
    } finally {
      setBusy(null)
    }
  }

  const switching = state.status === 'switching' || busy === 'switch'
  const waiting = state.status === 'waiting' || busy === 'wait'
  const target = state.target
  const targetText = target ? `${target.label}${target.model ? `（${target.model}）` : ''}` : null
  const resumeText =
    state.resumeAt && state.resumeAt > Date.now()
      ? `${handoffWaitLabel(state.resumeAt)} · ${formatTime(state.resumeAt)}`
      : handoffWaitLabel(state.resumeAt)

  return (
    <div
      role="group"
      aria-label="会话交接"
      data-handoff-card="true"
      className="mb-3 mt-4 rounded-xl border border-accent-strong/35 bg-accent-soft/40 px-3 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ArrowRightLeft size={14} className="shrink-0 text-accent-text" />
        <span className="shrink-0 text-[13px] font-medium">{REASON_TEXT[state.reason]}</span>
        <span className="min-w-0 truncate text-[12px] text-muted">
          {state.from.label}
          {state.from.model ? ` · ${state.from.model}` : ''}
        </span>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-5 text-text-soft">
        {state.message}
        {targetText ? `切换到 ${targetText}，或等待额度重置。` : '等待额度重置，或暂停。'}
      </p>
      {targetText && (
        <p className="mt-0.5 text-[12px] text-muted">
          切换前会保存检查点并压缩上下文到目标模型放得下的大小。
        </p>
      )}
      {waiting ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-[12px] text-accent-text">
            <Clock size={12} className={cn(!state.resumeAt && 'animate-pulse')} />
            {resumeText}
          </span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() => void choose('pause')}
            icon={busy === 'pause' ? <Spinner size={12} /> : <Pause size={12} />}
          >
            暂停
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={!target || !!busy}
            onClick={() => void choose('switch')}
            icon={switching ? <Spinner size={12} /> : <ArrowRightLeft size={12} />}
          >
            {targetText ? `切换到 ${target?.label ?? '备用分组'}` : '没有备用分组'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!!busy}
            onClick={() => void choose('wait')}
            icon={<Clock size={12} />}
          >
            等待额度重置
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() => void choose('pause')}
            icon={<Pause size={12} />}
          >
            暂停
          </Button>
        </div>
      )}
    </div>
  )
}
