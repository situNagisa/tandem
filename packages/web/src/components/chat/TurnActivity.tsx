import { Spinner } from '../ui/Spinner'
import { formatElapsed } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import { runningSince } from '../../lib/runClock'

/**
 * 反馈16#10：一轮进行中、暂时没有新 token（等模型首个 token、等工具返回）时，
 * 在消息流末尾显示一行中性色的进度：spinner + 「正在思考…」/「正在运行 Bash…」+ 已用时长。
 */
export function TurnActivity({
  toolName,
  since,
  runKey,
}: {
  /** 正在执行的工具名；没有则在等模型输出。 */
  toolName?: string
  since: number
  runKey: string
}) {
  const now = useNow(true)
  const start = runningSince(runKey, since)
  return (
    <div className="msg-row" data-turn-activity="">
      <div role="status" className="flex h-7 items-center gap-2 px-1 text-[12px] text-muted">
        <Spinner size={13} className="shrink-0 text-text-secondary" aria-hidden />
        <span className="truncate">{toolName ? `正在运行 ${toolName}…` : '正在思考…'}</span>
        <span className="shrink-0 tabular-nums text-[11.5px]">{formatElapsed(now - start)}</span>
      </div>
    </div>
  )
}
