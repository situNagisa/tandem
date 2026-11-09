import type { DelegationStrategy, TurnRouteMode } from '@tandem/protocol'

/** 执行方式与委派倾向的 UI 文案只在这里定义（反馈8#01 #03 #09）。 */
export interface RouteModeMeta {
  label: string
  hint: string
}

export const ROUTE_MODE_META: Record<TurnRouteMode, RouteModeMeta> = {
  direct: {
    label: '单代理',
    hint: '主会话模型自己完成，不派子代理',
  },
  cheap: {
    label: '低成本',
    hint: '整条消息交给低价执行者子代理，主会话只看结果',
  },
  division: {
    label: '多代理协作',
    hint: '主会话规划拆解，子任务派给执行者或专长模型',
  },
}

export const ROUTE_MODE_ORDER: TurnRouteMode[] = ['direct', 'cheap', 'division']

export const ROUTE_MODE_OPTIONS = ROUTE_MODE_ORDER.map((value) => ({
  value,
  ...ROUTE_MODE_META[value],
}))

export interface DelegationMeta {
  label: string
  /** 设置页下拉用的带说明写法。 */
  longLabel: string
  hint: string
}

export const DELEGATION_META: Record<DelegationStrategy, DelegationMeta> = {
  orchestrate: {
    label: '仅规划',
    longLabel: '仅规划（只规划 / 汇总）',
    hint: '主会话只规划与汇总，读写和命令交给子代理',
  },
  more: {
    label: '积极',
    longLabel: '积极（鼓励并行）',
    hint: '鼓励把可独立、可并行的子任务派给子代理',
  },
  less: {
    label: '适度',
    longLabel: '适度（默认）',
    hint: '只有明显独立且多步的任务才派子代理（默认）',
  },
  none: {
    label: '关闭',
    longLabel: '关闭（不提供 Task）',
    hint: '不提供 Task 工具，所有工作由主会话自己完成',
  },
}

export const DELEGATION_ORDER: DelegationStrategy[] = ['orchestrate', 'more', 'less', 'none']

export const DELEGATION_LABEL: Record<DelegationStrategy, string> = Object.fromEntries(
  DELEGATION_ORDER.map((value) => [value, DELEGATION_META[value].label]),
) as Record<DelegationStrategy, string>

export function routeModeLabel(mode: TurnRouteMode | undefined): string {
  return mode ? ROUTE_MODE_META[mode].label : '自动'
}

export function delegationLabel(strategy: DelegationStrategy | undefined): string {
  return DELEGATION_META[strategy ?? 'less'].label
}
