import type { TurnRouteMode } from '@tandem/protocol'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { cn } from '../../lib/cn'

const MODES: Array<{ value: TurnRouteMode; label: string }> = [
  { value: 'direct', label: '直接做' },
  { value: 'cheap', label: '便宜直做' },
  { value: 'division', label: '分工' },
]

const MODE_LABEL: Record<TurnRouteMode, string> = {
  direct: '直接做',
  cheap: '便宜直做',
  division: '分工',
}

/** 每个任务一行的执行方式提示：展示服务端规则结论，点按钮记住为会话偏好。 */
export function RoutePlanLine({
  text,
  mode,
  hostId,
  sessionId,
}: {
  text: string
  mode: TurnRouteMode
  hostId: string | null
  sessionId: string | null
}) {
  const updateSession = useAppStore((s) => s.updateSession)
  const toast = useUiStore((s) => s.toast)
  const choose = (next: TurnRouteMode) => {
    if (!hostId || !sessionId) return
    void updateSession(hostId, sessionId, { routePreference: next }).then((updated) => {
      if (updated) toast(`已记住：以后同类任务默认${MODE_LABEL[next]}`, 'success')
    })
  }
  return (
    <div
      className="msg-row flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[12px] leading-4 text-muted"
      data-route-plan={mode}
    >
      <span className="min-w-0 flex-1">{text}</span>
      <span className="flex shrink-0 items-center gap-0.5">
        {MODES.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => choose(item.value)}
            className={cn(
              'rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text',
              mode === item.value && 'text-text-secondary',
            )}
            title={`以后同类任务默认${item.label}`}
          >
            {item.label}
          </button>
        ))}
      </span>
    </div>
  )
}
