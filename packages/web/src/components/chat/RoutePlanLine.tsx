import type { TurnRouteMode } from '@tandem/protocol'

/** 每个任务一行的路由结论提示（模式名与理由由服务端规则给出）。 */
export function RoutePlanLine({ text, mode }: { text: string; mode: TurnRouteMode }) {
  return (
    <div
      className="msg-row flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[12px] leading-4 text-muted"
      data-route-plan={mode}
    >
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  )
}
