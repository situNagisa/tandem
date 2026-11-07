import type { SessionStatus } from '@tandem/protocol'
import type { ConnectionState } from '../lib/types'
import { cn } from '../lib/cn'

const CONNECTION_STYLE: Record<ConnectionState, string> = {
  online: 'bg-text-tertiary/70',
  connecting: 'bg-text-secondary/60 running-dot',
  offline: 'bg-muted/40',
}

export function ConnectionDot({
  state,
  className,
}: {
  state: ConnectionState
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        CONNECTION_STYLE[state],
        className,
      )}
      title={state === 'online' ? '在线' : state === 'connecting' ? '连接中' : '离线'}
    />
  )
}

export function SessionStatusDot({ status }: { status: SessionStatus }) {
  if (status === 'running') {
    return (
      <span className="relative inline-flex size-2 shrink-0" title="运行中">
        <span className="absolute inset-0 rounded-full bg-text-secondary/25 running-dot" />
        <span className="relative m-auto size-1.5 rounded-full bg-text-secondary" />
      </span>
    )
  }
  if (status === 'waiting_permission') {
    return <span className="inline-block size-2 shrink-0 rounded-full bg-accent" title="等待审批" />
  }
  if (status === 'retrying') {
    return (
      <span
        className="inline-block size-2 shrink-0 rounded-full bg-warning running-dot"
        title="网络中断，等待重试"
      />
    )
  }
  if (status === 'error') {
    return <span className="inline-block size-2 shrink-0 rounded-full bg-text-tertiary/70" title="出错" />
  }
  return (
    <span
      className="inline-block size-1.5 shrink-0 rounded-full border border-[var(--t-border-strong)]"
      title="空闲"
    />
  )
}
