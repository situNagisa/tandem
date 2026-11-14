import type { ProviderKind, ReasoningEffort } from '@tandem/protocol'
import { readRaw, writeRaw } from './storage'

/** 档位全集：只用于排序、校验与离线兜底；某模型实际支持哪些由服务端能力决定。 */
export const EFFORTS: ReasoningEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  off: '关',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
}

/** 思考强度的简短后缀；关闭时不显示。 */
export function effortSuffix(effort: ReasoningEffort | undefined): string {
  return effort && effort !== 'off' ? ` ${EFFORT_LABEL[effort]}` : ''
}

/**
 * 离线兜底：能力接口还没返回或请求失败时，模型菜单先给一组通用档位。
 * 真实档位、厂商叫法与上下文窗口都以服务端下发的能力为准，这里不推断具体型号。
 */
export function offlineEffortsFor(kind: ProviderKind | undefined): ReasoningEffort[] {
  if (kind === 'anthropic' || kind === undefined) return [...EFFORTS]
  if (kind === 'demo') return ['off']
  return ['low', 'medium', 'high']
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

/** 上次显式选择过的档位；没选过返回 undefined（按模型官方默认，不擅自发送）。 */
export function loadLastEffort(): ReasoningEffort | undefined {
  const raw = readRaw(EFFORT_KEY)
  if (raw === 'off' || raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max') {
    return raw
  }
  return undefined
}

export function rememberEffort(effort: ReasoningEffort): void {
  writeRaw(EFFORT_KEY, effort)
}
