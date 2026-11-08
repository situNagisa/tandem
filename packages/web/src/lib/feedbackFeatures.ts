/** 反馈的功能标签推断与根因建议（规则数据在 features.ts / feedbackCauses.ts）。 */
import {
  FEATURE_BY_ID,
  PRODUCT_FEATURES,
  SETTINGS_PAGE_FEATURE,
  SETTING_ID_FEATURE,
  type ProductFeature,
} from './features'
import { suggestCause, type feedbackCauseRule } from './feedbackCauses'

export interface FeedbackTag {
  featureId: string
  featureName: string
  causeId?: string
  causeTitle?: string
}

export interface InferInput {
  element?: Element | null
  component?: string
  selector?: string
  route?: string
  text?: string
  textSnippet?: string
}

export const FEEDBACK_FEATURE_OPTIONS = PRODUCT_FEATURES.map((feature) => ({
  id: feature.id,
  title: feature.title,
}))

export function tagForFeature(featureId: string | undefined): FeedbackTag | undefined {
  if (!featureId) return undefined
  const feature = FEATURE_BY_ID.get(featureId)
  return feature ? { featureId: feature.id, featureName: feature.title } : undefined
}

function componentMatch(component: string): ProductFeature | undefined {
  if (!component) return undefined
  for (const feature of PRODUCT_FEATURES) {
    const names = feature.components ?? []
    if (names.some((name) => component === name || component.startsWith(name))) return feature
  }
  return undefined
}

/** 设置页里用页面/设置项 id 精确定位功能。 */
function settingsMatch(element?: Element | null): ProductFeature | undefined {
  if (!element) return undefined
  const setting = element.closest('[data-setting-id]')?.getAttribute('data-setting-id') ?? ''
  for (const [prefix, featureId] of SETTING_ID_FEATURE) {
    if (setting.startsWith(prefix)) return FEATURE_BY_ID.get(featureId)
  }
  const page =
    element.closest('[data-settings-page-content]')?.getAttribute('data-settings-page-content') ??
    element.closest('[data-settings-page]')?.getAttribute('data-settings-page') ??
    ''
  const featureId = SETTINGS_PAGE_FEATURE[page]
  return featureId ? FEATURE_BY_ID.get(featureId) : undefined
}

function routeMatch(route: string): ProductFeature | undefined {
  if (/\/b(\/|$)/.test(route)) return FEATURE_BY_ID.get('board')
  if (/\/x\/(claude-code|codex)\//.test(route)) return FEATURE_BY_ID.get('chat')
  if (route.includes('inbox')) return FEATURE_BY_ID.get('inbox')
  return undefined
}

function keywordMatch(text: string): ProductFeature | undefined {
  if (!text) return undefined
  const hay = text.toLowerCase()
  let best: { feature: ProductFeature; score: number } | undefined
  for (const feature of PRODUCT_FEATURES) {
    let score = 0
    for (const keyword of feature.keywords ?? []) {
      if (keyword && hay.includes(keyword.toLowerCase())) score += 1
    }
    if (score > 0 && (!best || score > best.score)) best = { feature, score }
  }
  return best?.feature
}

/** 元素 → 组件 → 设置页/设置项 → 路由 → 关键词，逐级回退。 */
export function inferFeedbackFeature(input: InferInput): ProductFeature | undefined {
  const fromSettings = settingsMatch(input.element)
  if (fromSettings) return fromSettings
  const fromComponent = componentMatch(input.component ?? '')
  if (fromComponent) return fromComponent
  const fromRoute = routeMatch(input.route ?? '')
  if (fromRoute) return fromRoute
  const fromText = keywordMatch(`${input.text ?? ''}\n${input.textSnippet ?? ''}`)
  if (fromText) return fromText
  return undefined
}

export function inferFeedbackTag(input: InferInput): FeedbackTag | undefined {
  const feature = inferFeedbackFeature(input)
  const cause = suggestCause(input)
  if (!feature && !cause) return undefined
  return {
    featureId: feature?.id ?? 'uncategorized',
    featureName: feature?.title ?? '未归类',
    ...(cause ? { causeId: cause.id, causeTitle: cause.title } : {}),
  }
}

export function suggestFeedbackCause(input: InferInput): feedbackCauseRule | undefined {
  return suggestCause(input)
}
