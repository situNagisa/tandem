import type { ReasoningEffort } from '@tandem/protocol'

export const EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max']

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: '关',
  low: '低',
  medium: '中',
  high: '高',
  max: '最高',
}

/** 思考强度的简短后缀；关闭时不显示。 */
export function effortSuffix(effort: ReasoningEffort | undefined): string {
  return effort && effort !== 'off' ? ` ${EFFORT_LABEL[effort]}` : ''
}

const EFFORT_KEY = 'tandem.effort.v1'

export function loadLastEffort(): ReasoningEffort {
  try {
    const raw = localStorage.getItem(EFFORT_KEY)
    if (raw === 'off' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max') {
      return raw
    }
  } catch {
    /* localStorage 不可用时用默认值 */
  }
  return 'off'
}

export function rememberEffort(effort: ReasoningEffort): void {
  try {
    localStorage.setItem(EFFORT_KEY, effort)
  } catch {
    /* 忽略 */
  }
}
