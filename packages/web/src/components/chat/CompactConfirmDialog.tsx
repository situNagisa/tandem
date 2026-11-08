import { useSessionTarget, useSessionView } from '../session/SessionScope'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { ConfirmAction } from '../ui/ConfirmAction'

/** 手动压缩上下文的确认框：说明会压掉哪些轮次，并提示原文可展开/撤销。 */
export function CompactConfirmDialog() {
  const scoped = useSessionTarget()
  const active = useAppStore((s) => s.active)
  const target = scoped ?? (active ? { hostId: active.hostId, sessionId: active.sessionId } : null)
  const confirmTarget = useUiStore((s) => s.compactConfirm)
  const openCompactConfirm = useUiStore((s) => s.openCompactConfirm)
  const send = useAppStore((s) => s.send)
  const open = !!target && confirmTarget?.hostId === target.hostId && confirmTarget?.sessionId === target.sessionId
  const messages = useSessionView((s) => s?.messages)
  const running = useSessionView((s) => s?.running ?? false)
  const turns = (messages ?? []).filter(
    (message) => message.role === 'user' && !message.summary && !message.gap,
  ).length

  return (
    <ConfirmAction
      open={open}
      title="压缩上下文"
      description={
        turns > 0
          ? `当前会话的 ${turns} 轮对话会被压成一段摘要，之后请求只发送摘要与系统提示以节省 token。`
          : '当前对话会被压成一段摘要，之后请求只发送摘要与系统提示以节省 token。'
      }
      impacts={[
        '原文会留档：压缩后消息流里的「已压缩上下文」提示默认显示摘要前两行，可展开摘要、查看原文。',
        '压缩后 8 秒内可点提示条上的「撤销压缩」恢复为压缩前的上下文；之后也可以从同一条提示里撤销。',
        '压缩本身会发起一次模型请求，计入用量。',
      ]}
      confirmLabel="压缩上下文"
      successText="已开始压缩上下文"
      onConfirm={() => {
        if (running) return
        if (target) send([{ type: 'text', text: '/compact' }], target)
      }}
      onClose={() => openCompactConfirm(null)}
      testId="compact-confirm"
    />
  )
}
