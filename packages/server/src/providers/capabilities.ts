// 模型能力推断：优先用 provider 返回的字段，其次按模型 id 前缀查内置表，最后叠加账号/分组的手动覆盖。
// 思考强度的档位、厂商叫法与请求参数映射都集中在能力表里（反馈 #7-05）。
import type {
  ModelCapabilities,
  ModelInfo,
  ProviderKind,
  ReasoningEffort,
} from '@tandem/protocol';

const ANTHROPIC_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max'];
/** o 系列：low/medium/high；gpt-5 及以后另有 minimal。 */
const OPENAI_REASONING: ReasoningEffort[] = ['low', 'medium', 'high'];
const OPENAI_MINIMAL: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];
const GEMINI_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];
const GROK_MINI: ReasoningEffort[] = ['low', 'high'];
const GROK_REASONING: ReasoningEffort[] = ['low', 'medium', 'high'];

const LABELS = {
  anthropic: {
    off: '关',
    low: '低 · 2K',
    medium: '中 · 8K',
    high: '高 · 16K',
    max: '最高 · 32K',
  } satisfies Partial<Record<ReasoningEffort, string>>,
  openai: {
    minimal: '极低 · minimal',
    low: '低 · low',
    medium: '中 · medium',
    high: '高 · high',
  } satisfies Partial<Record<ReasoningEffort, string>>,
  openaiReasoning: {
    low: '低 · low',
    medium: '中 · medium',
    high: '高 · high',
  } satisfies Partial<Record<ReasoningEffort, string>>,
  grokMini: {
    low: '低 · low',
    high: '高 · high',
  } satisfies Partial<Record<ReasoningEffort, string>>,
  gemini: {
    low: '低 · low',
    medium: '中 · medium',
    high: '高 · high',
  } satisfies Partial<Record<ReasoningEffort, string>>,
} as const;

/** 无法确定能力时，按 provider 的默认档位展示。 */
export function defaultEffortsForKind(kind: ProviderKind): ReasoningEffort[] {
  if (kind === 'anthropic') return [...ANTHROPIC_EFFORTS];
  if (kind === 'openai' || kind === 'gemini' || kind === 'openai-compatible' || kind === 'tandem-gateway') {
    return [...OPENAI_REASONING];
  }
  return [...OPENAI_REASONING];
}

export function providerEffortsFor(kind: ProviderKind): ReasoningEffort[] {
  return defaultEffortsForKind(kind);
}

/** 模型 id → 厂商档位与请求映射风格。只按模型 id 本身判断，与 provider 种类无关。 */
type EffortStyle =
  | 'anthropic'
  | 'anthropic-adaptive'
  | 'openai-minimal'
  | 'openai-reasoning'
  | 'gemini'
  | 'grok-mini'
  | 'grok'
  | 'none';

const CLAUDE_MODEL =
  /claude-(?:(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?|(\d)(?:[-.](\d{1,2}))?-(opus|sonnet|haiku|fable|mythos))(?!\d)/;

/**
 * 解析 Claude 型号的家族与版本：`claude-opus-4-5-20251101`、`claude-3-5-sonnet-20241022`、
 * `us.anthropic.claude-sonnet-5-5-v1:0` 都能识别；未来版本号不需要改表。
 */
export function parseClaudeModel(
  model: string,
): { family: string; major: number; minor: number } | undefined {
  const match = model.toLowerCase().match(CLAUDE_MODEL);
  if (!match) return undefined;
  if (match[1]) return { family: match[1], major: Number(match[2]), minor: Number(match[3] ?? 0) };
  return { family: match[6]!, major: Number(match[4]), minor: Number(match[5] ?? 0) };
}

/**
 * Claude 的思考协议：4.7 及以后只接受 adaptive（档位走 output_config.effort，不接受 budget_tokens）；
 * 4.6 及以前用 extended thinking 的 budget_tokens。非 Claude 或 3.7 之前的型号返回 undefined。
 */
export function claudeThinkingMode(model: string): 'adaptive' | 'manual' | undefined {
  const claude = parseClaudeModel(model);
  if (!claude) return undefined;
  if (claude.major > 4 || (claude.major === 4 && claude.minor >= 7)) return 'adaptive';
  if (claude.major >= 4 || (claude.major === 3 && claude.minor === 7)) return 'manual';
  return undefined;
}

function styleFor(kind: ProviderKind, model: string): EffortStyle {
  const effectiveKind: ProviderKind = kind === 'tandem-gateway' ? 'openai-compatible' : kind;
  const id = model.toLowerCase();
  const claudeMode = claudeThinkingMode(id);
  if (effectiveKind === 'anthropic') {
    if (claudeMode === 'adaptive') return 'anthropic-adaptive';
    return claudeMode ? 'anthropic' : 'none';
  }
  if (claudeMode) return 'openai-reasoning';
  const gpt = id.match(/^gpt-(\d+)(?:[-.]|$)/);
  if (gpt) return Number(gpt[1]) >= 5 ? 'openai-minimal' : 'none';
  if (/^o[1-9](?:[-.]|$)/.test(id)) return 'openai-reasoning';
  if (/^grok-3-mini(?:[-.]|$)/.test(id)) return 'grok-mini';
  if (/^grok-(?:4|3)(?:[-.]|$)/.test(id)) return /^grok-4/.test(id) ? 'grok' : 'none';
  if (effectiveKind === 'gemini' && /^gemini-(?:2\.5|3)/.test(id)) return 'gemini';
  return 'none';
}

function labelFor(style: EffortStyle): Partial<Record<ReasoningEffort, string>> | undefined {
  switch (style) {
    case 'anthropic':
    case 'anthropic-adaptive':
      return { ...LABELS.anthropic };
    case 'openai-minimal':
      return { ...LABELS.openai };
    case 'openai-reasoning':
      return { ...LABELS.openaiReasoning };
    case 'gemini':
      return { ...LABELS.gemini };
    case 'grok-mini':
      return { ...LABELS.grokMini };
    case 'grok':
      return { ...LABELS.openaiReasoning };
    default:
      return undefined;
  }
}

function effortsFor(style: EffortStyle): ReasoningEffort[] {
  switch (style) {
    case 'anthropic':
    case 'anthropic-adaptive':
      return [...ANTHROPIC_EFFORTS];
    case 'openai-minimal':
      return [...OPENAI_MINIMAL];
    case 'openai-reasoning':
    case 'grok':
      return [...OPENAI_REASONING];
    case 'gemini':
      return [...GEMINI_EFFORTS];
    case 'grok-mini':
      return [...GROK_MINI];
    default:
      return [];
  }
}

export function builtinCapabilities(kind: ProviderKind, model: string): ModelCapabilities {
  const style = styleFor(kind, model);
  const caps: ModelCapabilities = { efforts: effortsFor(style) };
  const labels = labelFor(style);
  if (labels) caps.effortLabels = labels;

  const id = model.toLowerCase();
  const claude = /^claude-/.test(id);
  // 上下文上限按模型 id 前缀推断（与 provider 无关）
  if (claude) caps.contextWindow = 200_000;
  else if (/^gpt-5/.test(id)) caps.contextWindow = 400_000;
  else if (/^gpt-6/.test(id)) caps.contextWindow = 500_000;
  else if (/^gpt-4\.1/.test(id)) caps.contextWindow = 1_000_000;
  else if (/^gpt-4o/.test(id)) caps.contextWindow = 128_000;
  else if (/^o[1-9]/.test(id)) caps.contextWindow = 200_000;
  else if (/^(?:grok-3|grok-4)/.test(id)) caps.contextWindow = 256_000;
  else if (/^gemini-/.test(id)) caps.contextWindow = 1_048_576;
  else if (/^deepseek-/.test(id)) caps.contextWindow = 128_000;
  else if (/^qwen/.test(id)) caps.contextWindow = 131_072;
  else if (/^(?:moonshot|kimi)-/.test(id)) caps.contextWindow = 262_144;

  return caps;
}

/** 账号/分组的覆盖支持精确模型名与最长前缀（如 gpt-5）。 */
export function overrideFor(
  overrides: Record<string, ModelCapabilities> | undefined,
  model: string,
): ModelCapabilities | undefined {
  if (!overrides) return undefined;
  if (overrides[model]) return overrides[model];
  const key = Object.keys(overrides)
    .filter((prefix) => prefix && model.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  return key ? overrides[key] : undefined;
}

/**
 * 把能力写进 ModelInfo：覆盖 > provider 字段 > 内置表。
 * efforts 为空数组表示明确不支持思考，缺省表示未知。
 */
export function applyModelCapabilities(
  info: ModelInfo,
  kind: ProviderKind,
  overrides?: Record<string, ModelCapabilities>,
  provider?: ModelCapabilities,
): ModelInfo {
  const builtin = builtinCapabilities(kind, info.id);
  const override = overrideFor(overrides, info.id);
  const efforts = override?.efforts ?? provider?.efforts ?? builtin.efforts;
  if (efforts !== undefined) info.efforts = [...efforts];
  const labels = override?.effortLabels ?? provider?.effortLabels ?? builtin.effortLabels;
  if (labels !== undefined) info.effortLabels = { ...labels };
  const contextWindow =
    override?.contextWindow ??
    info.contextWindow ??
    provider?.contextWindow ??
    builtin.contextWindow;
  if (contextWindow !== undefined) info.contextWindow = contextWindow;
  return info;
}

/** 当前模型实际支持的档位（账号覆盖 > provider 字段 > 内置表）；undefined 表示未知。 */
export function resolveEfforts(
  kind: ProviderKind,
  model: string,
  overrides?: Record<string, ModelCapabilities>,
): ReasoningEffort[] | undefined {
  const override = overrideFor(overrides, model);
  if (override?.efforts !== undefined) return override.efforts;
  return builtinCapabilities(kind, model).efforts;
}

/**
 * OpenAI 兼容端点的 reasoning_effort 值。
 * 能力表明确列出该档位才发送；max 不是 OpenAI 的档位，映射为 high。
 */
export function openaiReasoningEffort(
  kind: ProviderKind,
  model: string,
  effort: ReasoningEffort | undefined,
  overrides?: Record<string, ModelCapabilities>,
): string | undefined {
  if (!effort || effort === 'off') return undefined;
  const supported = resolveEfforts(kind, model, overrides);
  if (!supported || !supported.includes(effort)) return undefined;
  return effort === 'max' ? 'high' : effort;
}

/** Anthropic extended thinking 的 budget_tokens 预设（厂商只有预算，没有档位名）。 */
export const ANTHROPIC_THINKING_BUDGETS: Partial<Record<ReasoningEffort, number>> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  max: 32000,
};
