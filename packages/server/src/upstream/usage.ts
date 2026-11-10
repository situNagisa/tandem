// usage 字段归一：OpenAI 兼容 / Anthropic 两种协议的字段别名与缓存扣减只在这里处理。
// 累计策略按调用方传参：网关透传多个事件时取各字段最大值，provider 以最后一条 usage 为准。
import type { Usage } from '@tandem/protocol';

type AnyRecord = Record<string, any>;

export type UsageMergeMode = 'max' | 'replace';

export interface OpenAiUsageOptions {
  merge: UsageMergeMode;
  /** 识别非标准的输入/输出/缓存字段别名（网关历史行为；provider 只认官方字段）。 */
  inputAliases?: boolean;
  outputAliases?: boolean;
  cachedAlias?: boolean;
}

function finite(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** OpenAI 的 prompt_tokens 已包含缓存命中；内部 Usage 记录未命中部分。 */
export function applyOpenAiUsage(raw: AnyRecord | undefined, usage: Usage, opts: OpenAiUsageOptions): void {
  if (!raw) return;
  const prompt = finite(raw.prompt_tokens ?? (opts.inputAliases ? raw.input_tokens : undefined)) ?? 0;
  const cached =
    finite(raw.prompt_tokens_details?.cached_tokens) ??
    finite(raw.prompt_cache_hit_tokens) ??
    (opts.cachedAlias ? finite(raw.cached_tokens) : undefined) ??
    0;
  const completion = finite(raw.completion_tokens ?? (opts.outputAliases ? raw.output_tokens : undefined));
  const reasoning =
    finite(raw.completion_tokens_details?.reasoning_tokens) ?? finite(raw.reasoning_tokens) ?? 0;
  if (opts.merge === 'replace') {
    usage.inputTokens = Math.max(0, prompt - cached);
    usage.cacheReadTokens = cached;
    if (completion !== undefined) usage.outputTokens = completion;
    usage.reasoningTokens = reasoning;
    return;
  }
  usage.inputTokens = Math.max(usage.inputTokens, Math.max(0, prompt - cached));
  if (cached > 0) usage.cacheReadTokens = Math.max(usage.cacheReadTokens ?? 0, cached);
  usage.outputTokens = Math.max(usage.outputTokens, completion ?? 0);
  if (reasoning > 0) usage.reasoningTokens = Math.max(usage.reasoningTokens ?? 0, reasoning);
}

/** Anthropic 的流式 usage 是累计值：只增不减，部分事件可以缺字段甚至为 0。 */
export function applyAnthropicUsage(raw: AnyRecord | undefined, usage: Usage): void {
  if (!raw) return;
  if (typeof raw.input_tokens === 'number') usage.inputTokens = Math.max(usage.inputTokens, raw.input_tokens);
  if (typeof raw.output_tokens === 'number') usage.outputTokens = Math.max(usage.outputTokens, raw.output_tokens);
  if (typeof raw.cache_read_input_tokens === 'number') {
    usage.cacheReadTokens = Math.max(usage.cacheReadTokens ?? 0, raw.cache_read_input_tokens);
  }
  if (typeof raw.cache_creation_input_tokens === 'number') {
    usage.cacheWriteTokens = Math.max(usage.cacheWriteTokens ?? 0, raw.cache_creation_input_tokens);
  }
}
