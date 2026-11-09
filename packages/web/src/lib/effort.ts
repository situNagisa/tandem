import type { ProviderKind, ReasoningEffort } from '@tandem/protocol'
import { readRaw, writeRaw } from './storage'

export const EFFORTS: ReasoningEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'max']

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: '关',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  max: '最高',
}

/** 思考强度的简短后缀；关闭时不显示。 */
export function effortSuffix(effort: ReasoningEffort | undefined): string {
  return effort && effort !== 'off' ? ` ${EFFORT_LABEL[effort]}` : ''
}

/** 能力未知时按 provider 默认展示的档位。 */
export function defaultEffortsForKind(kind: ProviderKind | undefined): ReasoningEffort[] {
  if (kind === 'anthropic' || kind === undefined) return [...EFFORTS]
  if (kind === 'demo') return ['off']
  return EFFORTS.filter((effort) => effort !== 'max' && effort !== 'off')
}

/** 当前强度不在支持列表时，取档位距离最近的一项；列表为空表示不支持思考。 */
export function nearestEffort(
  supported: ReasoningEffort[],
  current: ReasoningEffort,
): ReasoningEffort {
  if (supported.includes(current)) return current
  const index = EFFORTS.indexOf(current)
  for (let distance = 1; distance < EFFORTS.length; distance++) {
    const lower = EFFORTS[index - distance]
    if (lower && supported.includes(lower)) return lower
    const higher = EFFORTS[index + distance]
    if (higher && supported.includes(higher)) return higher
  }
  return supported[0] ?? 'off'
}

const EFFORT_KEY = 'tandem.effort.v1'

export function loadLastEffort(): ReasoningEffort {
  const raw = readRaw(EFFORT_KEY)
  if (raw === 'off' || raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max') {
    return raw
  }
  return 'off'
}

export function rememberEffort(effort: ReasoningEffort): void {
  writeRaw(EFFORT_KEY, effort)
}
