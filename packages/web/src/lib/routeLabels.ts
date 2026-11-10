import type { DelegationStrategy, RoutePreference, TurnRouteMode } from '@tandem/protocol'

/** 每轮解释模式（服务端 RoutePlan.mode）的文案只在这里定义。 */
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
    label: '整单交执行者',
    hint: '整条消息交给执行者子代理，主会话只看结果',
  },
  division: {
    label: '多代理协作',
    hint: '主会话规划拆解，子任务派给执行者或专长模型',
  },
}

export const ROUTE_MODE_ORDER: TurnRouteMode[] = ['direct', 'cheap', 'division']

export interface DelegationMeta {
  label: string
  /** 设置页下拉用的带说明写法。 */
  longLabel: string
  hint: string
}

export const DELEGATION_META: Record<DelegationStrategy, DelegationMeta> = {
  none: {
    label: '关闭',
    longLabel: '关闭（不提供 Task）',
    hint: '不提供 Task，所有工作由主会话完成',
  },
  less: {
    label: '适度',
    longLabel: '适度（默认）',
    hint: '默认：只在明显独立的多步任务派子代理',
  },
  more: {
    label: '积极',
    longLabel: '积极（尽量拆分并行）',
    hint: '尽量把可独立的子任务拆开并行派发',
  },
}

export const DELEGATION_ORDER: DelegationStrategy[] = ['none', 'less', 'more']

export const ROUTE_BIAS_META: Record<RoutePreference, RouteModeMeta> = {
  cost: {
    label: '省钱',
    hint: '机械任务整单交给执行者，子代理用便宜档',
  },
  balanced: {
    label: '均衡',
    hint: '子代理用均衡档（默认）',
  },
  quality: {
    label: '质量优先',
    hint: '子代理用强档',
  },
}

export const ROUTE_BIAS_ORDER: RoutePreference[] = ['cost', 'balanced', 'quality']

export function delegationLabel(strategy: DelegationStrategy | undefined): string {
  return DELEGATION_META[strategy ?? 'less'].label
}

export function routeBiasLabel(bias: RoutePreference | undefined): string {
  return ROUTE_BIAS_META[bias ?? 'balanced'].label
}
