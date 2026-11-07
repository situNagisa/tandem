// 模型能力推断：优先用 provider 返回的字段，其次按模型 id 前缀查内置表，最后叠加账号/分组的手动覆盖。
import type {
  ModelCapabilities,
  ModelInfo,
  ProviderKind,
  ReasoningEffort,
} from '@tandem/protocol';

const ANTHROPIC_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max'];
const OPENAI_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high'];
const GEMINI_EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

/** 无法确定能力时，按 provider 的默认档位展示。 */
export function defaultEffortsForKind(kind: ProviderKind): ReasoningEffort[] {
  if (kind === 'anthropic') return [...ANTHROPIC_EFFORTS];
  if (kind === 'openai' || kind === 'gemini' || kind === 'openai-compatible' || kind === 'tandem-gateway') {
    return [...OPENAI_EFFORTS];
  }
  return [...ANTHROPIC_EFFORTS];
}

export function providerEffortsFor(kind: ProviderKind): ReasoningEffort[] {
  return defaultEffortsForKind(kind);
}

export function builtinCapabilities(kind: ProviderKind, model: string): ModelCapabilities {
  const effectiveKind: ProviderKind = kind === 'tandem-gateway' ? 'openai-compatible' : kind;
  const id = model.toLowerCase();
  const caps: ModelCapabilities = {};

  const claude = /^claude-/.test(id);
  // 常见 id：claude-sonnet-4 / 4-5 / 4.5、opus-4 / 4-1、haiku-4-5、3-7-sonnet 等（可带日期后缀）
  const claudeThinking =
    /claude-(?:3[-.]7|(?:sonnet|opus|haiku)-(?:4|5)(?:[-.]\d+)*)(?:-|$)/.test(id) ||
    /claude-4(?:[-.]\d+)*(?:-|$).*(?:sonnet|opus|haiku)/.test(id);
  // o1/o3/o4-mini 等推理模型与 gpt-5 / gpt-5.1 / gpt-6 系列
  const openaiReasoning = /^(?:o[1-9](?:[-.]|$)|gpt-(?:5|6)(?:[-.]|$))/.test(id);
  const geminiThinking = /^gemini-(?:2\.5|3)/.test(id);

  if (effectiveKind === 'anthropic') {
    // claude 3.7 / 4 / 4.x / 5 系列支持 extended thinking（预算可调）
    if (claudeThinking) caps.efforts = [...ANTHROPIC_EFFORTS];
    else if (claude) caps.efforts = [];
  } else if (/^deepseek-reasoner/.test(id) || /^deepseek-/.test(id)) {
    // 推理过程固定开启，没有可调档位
    caps.efforts = [];
  } else if (claudeThinking || openaiReasoning || geminiThinking) {
    // 走 OpenAI 兼容端点时统一用 reasoning_effort；max 在服务端映射为 high
    caps.efforts = effectiveKind === 'gemini' ? [...GEMINI_EFFORTS] : [...OPENAI_EFFORTS];
  } else if (claude || /^(?:gpt-|o\d|chatgpt-|gemini-)/.test(id)) {
    caps.efforts = [];
  }

  // 上下文上限按模型 id 前缀推断（与 provider 无关）
  if (claude) caps.contextWindow = 200_000;
  else if (/^gpt-5/.test(id)) caps.contextWindow = 400_000;
  else if (/^gpt-4\.1/.test(id)) caps.contextWindow = 1_000_000;
  else if (/^gpt-4o/.test(id)) caps.contextWindow = 128_000;
  else if (/^o[1-9]/.test(id)) caps.contextWindow = 200_000;
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
  const contextWindow =
    override?.contextWindow ??
    info.contextWindow ??
    provider?.contextWindow ??
    builtin.contextWindow;
  if (contextWindow !== undefined) info.contextWindow = contextWindow;
  return info;
}
