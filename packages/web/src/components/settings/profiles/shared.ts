import type {
  BalancePlatform,
  Profile,
  ProfileGroup,
  ProfileGroupInput,
  ProfileInput,
  ProfileKey,
  ProfileKeyInput,
  ProviderKind,
} from '@tandem/protocol'
import { formatElapsed } from '../../../lib/format'

export const inputCls =
  'h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] text-text outline-none transition-colors placeholder:text-muted focus:border-border-strong'
export const labelCls = 'settings-label'

/** 分组协议下拉的简短名称（与用户熟悉的叫法一致）。 */
export const GROUP_KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI 兼容',
  gemini: 'Gemini',
  'tandem-gateway': 'Tandem 网关',
  ...(__TANDEM_DEBUG__ ? { demo: '演示模型' } : { demo: 'Demo' }),
}

export type Step = 1 | 2 | 3

export type PriceMap = Record<string, { input: number; output: number }>

export interface FormState {
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  /** 余额查询：auto 自动识别；none 关闭；custom 用自定义 URL + JSON 路径。 */
  balancePlatform: BalancePlatform
  balanceUrl: string
  balancePath: string
  balanceCurrency: string
  balanceThreshold: string
}

export function emptyForm(): FormState {
  return {
    name: '',
    kind: 'openai-compatible',
    baseUrl: '',
    apiKey: '',
    balancePlatform: 'auto',
    balanceUrl: '',
    balancePath: '',
    balanceCurrency: '',
    balanceThreshold: '',
  }
}

export interface GroupDraft {
  id?: string
  name: string
  kind: ProviderKind
  apiKey: string
  apiKeyMasked?: string
  /** 老账号无分组时按账号字段合成的隐式分组，Key 留在账号上 */
  inheritedKey?: boolean
  baseUrl: string
  models: string[]
  defaultModel: string
  /** 价格倍率：官方价 × 账号倍率 × 分组倍率；缺省 1。 */
  multiplier?: number
  /** 备用分组链（同一账号，按顺序）。 */
  fallbackGroupIds?: string[]
}

export function emptyGroupDraft(kind: ProviderKind = 'openai-compatible'): GroupDraft {
  return { name: '', kind, apiKey: '', baseUrl: '', models: [], defaultModel: '' }
}

export function defaultGroupDraft(kind: ProviderKind, models: string[] = [], defaultModel = ''): GroupDraft {
  return {
    name: '默认',
    kind,
    apiKey: '',
    baseUrl: '',
    models,
    defaultModel: defaultModel || models[0] || '',
  }
}

/** 与服务端一致：分组协议与账号不同且未填 URL 时，去掉账号完整端点并补该协议常见版本段。 */
export function inferGroupBaseUrl(baseUrl: string | undefined, kind: ProviderKind): string | undefined {
  const value = baseUrl?.trim()
  if (!value) return undefined
  let base = value.replace(/\/+$/, '')
  base = base
    .replace(/\/(?:v1\/)?messages$/i, '')
    .replace(/\/(?:v1\/)?chat\/completions$/i, '')
    .replace(/\/models$/i, '')
  if (!base) return undefined
  if (kind === 'anthropic') return base
  try {
    const pathname = new URL(base).pathname.replace(/\/+$/, '')
    if (!pathname || pathname === '/') {
      return `${base}/${kind === 'gemini' ? 'v1beta/openai' : 'v1'}`
    }
    if (kind === 'gemini' && pathname === '/v1beta') return `${base}/openai`
  } catch {
    /* 交给服务端报错 */
  }
  return base
}

/** 分组协议对应的 Base URL 提示（完整端点原样使用，否则由 provider 拼接路径）。 */
export function groupBaseUrlPlaceholder(kind: ProviderKind): string {
  switch (kind) {
    case 'anthropic':
      return 'https://api.anthropic.com（自动拼接 /v1/messages）'
    case 'openai':
      return 'https://api.openai.com/v1（自动拼接 /chat/completions）'
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta/openai'
    case 'tandem-gateway':
      return 'http://网关 Host:8271（自动拼接 /gateway/v1）'
    default:
      return 'https://api.example.com/v1'
  }
}

export function groupInputOf(group: ProfileGroup): ProfileGroupInput {
  return {
    id: group.id,
    name: group.name,
    ...(group.kind ? { kind: group.kind } : {}),
    ...(group.baseUrl ? { baseUrl: group.baseUrl } : {}),
    ...(group.keyStrategy ? { keyStrategy: group.keyStrategy } : {}),
    models: group.models,
    defaultModel: group.defaultModel,
    ...(group.multiplier !== undefined ? { multiplier: group.multiplier } : {}),
    ...(group.modelCapabilities ? { modelCapabilities: group.modelCapabilities } : {}),
    ...(group.fallbackGroupIds?.length ? { fallbackGroupIds: group.fallbackGroupIds } : {}),
    apiKeys: group.keys.map(keyInputOf),
  }
}

export function keyInputOf(key: ProfileKey) {
  return {
    id: key.id,
    ...(key.label ? { label: key.label } : {}),
    ...(key.disabled ? { disabled: true } : {}),
  }
}

export function profileInputOf(profile: Profile, groups: ProfileGroupInput[]): ProfileInput {
  return {
    name: profile.name,
    kind: profile.kind,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    models: profile.models,
    defaultModel: profile.defaultModel,
    ...(profile.price ? { price: profile.price } : {}),
    ...(profile.modelCapabilities ? { modelCapabilities: profile.modelCapabilities } : {}),
    groups,
  }
}

export function keyStatus(key: ProfileKey, now: number): { text: string; tone: string } {
  if (key.disabled) return { text: '已停用', tone: 'text-muted' }
  if (key.cooldownUntil && key.cooldownUntil > now) {
    return {
      text: `冷却中 ${formatElapsed(key.cooldownUntil - now)}`,
      tone: 'text-accent-text',
    }
  }
  return { text: '可用', tone: 'text-muted' }
}
