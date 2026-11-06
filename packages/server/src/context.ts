// 上下文占用估算：请求前按字符数粗估各部分，收到真实 usage 后按比例校准。
// 参考 Claude Code /context 的分类；token 估算使用字符数 / 3.5。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ContextBreakdown, Message } from '@tandem/protocol';
import type { ToolDefinition } from './types.js';

type PartKind = ContextBreakdown['parts'][number]['kind'];

/** 内置模型上下文窗口兜底表（ModelInfo.contextWindow 未知时使用）。 */
const CONTEXT_WINDOWS: Array<{ prefix: string; tokens: number }> = [
  { prefix: 'claude-opus-4-1', tokens: 200_000 },
  { prefix: 'claude-opus-4', tokens: 200_000 },
  { prefix: 'claude-sonnet-4-5', tokens: 200_000 },
  { prefix: 'claude-sonnet-4', tokens: 200_000 },
  { prefix: 'claude-3-7-sonnet', tokens: 200_000 },
  { prefix: 'claude-3-5-sonnet', tokens: 200_000 },
  { prefix: 'claude-haiku-4-5', tokens: 200_000 },
  { prefix: 'claude-3-5-haiku', tokens: 200_000 },
  { prefix: 'claude-3-haiku', tokens: 200_000 },
  { prefix: 'gpt-5', tokens: 400_000 },
  { prefix: 'gpt-4.1', tokens: 1_047_576 },
  { prefix: 'gpt-4o', tokens: 128_000 },
  { prefix: 'o1', tokens: 200_000 },
  { prefix: 'o3', tokens: 200_000 },
  { prefix: 'o4', tokens: 200_000 },
  { prefix: 'deepseek', tokens: 128_000 },
  { prefix: 'gemini-2.5-pro', tokens: 1_048_576 },
  { prefix: 'gemini-2.5-flash', tokens: 1_048_576 },
  { prefix: 'gemini', tokens: 1_048_576 },
  { prefix: 'qwen', tokens: 131_072 },
  { prefix: 'moonshot', tokens: 131_072 },
];

export function contextWindowForModel(model: string): number {
  const name = model.trim().toLowerCase().replace(/^[^/]+\//, '');
  if (/\[1m\]$/.test(name)) return 1_000_000;
  for (const entry of CONTEXT_WINDOWS) {
    if (name.startsWith(entry.prefix)) return entry.tokens;
  }
  return 200_000;
}

/** 粗略 token 估算：英文约 3.5 字符/token，中文按字计更接近；统一用字符数/3.5。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

function readMemory(cwd: string): string {
  const parts: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(cwd, name);
    try {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      if (text.trim()) parts.push(text.length > 20_000 ? text.slice(0, 20_000) : text);
    } catch {
      // 不可读则忽略
    }
  }
  return parts.join('\n\n');
}

function toolTokens(tool: ToolDefinition): number {
  return estimateTokens(`${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema)}`);
}

export interface EstimateInput {
  model: string;
  system: string;
  tools: ToolDefinition[];
  messages: Message[];
  cwd: string;
  cacheHitRate?: number;
}

/** 请求前的上下文占用估算。 */
export function estimateBreakdown(input: EstimateInput): ContextBreakdown {
  const memory = estimateTokens(readMemory(input.cwd));
  const system = Math.max(0, estimateTokens(input.system) - memory);
  let tools = 0;
  let mcp = 0;
  for (const tool of input.tools) {
    if (tool.mcp) mcp += toolTokens(tool);
    else tools += toolTokens(tool);
  }

  let messages = 0;
  let toolResults = 0;
  for (const message of input.messages) {
    messages += 4;
    for (const block of message.content) {
      if (block.type === 'text') messages += estimateTokens(block.text);
      else if (block.type === 'thinking') messages += estimateTokens(block.text);
      else if (block.type === 'image') messages += 1_200;
      else if (block.type === 'tool_use') messages += estimateTokens(JSON.stringify(block.input ?? {}));
      else if (block.type === 'tool_result') toolResults += estimateTokens(block.content);
    }
  }

  const parts = toParts({ system, tools, mcp, memory, messages, tool_results: toolResults });
  const usedTokens = sumParts(parts);
  const contextWindow = contextWindowForModel(input.model);
  return finish(parts, usedTokens, contextWindow, input.model, input.cacheHitRate);
}

/** 收到真实 usage 后按比例校准（保持各部分相对占比）。 */
export function calibrateBreakdown(
  estimate: ContextBreakdown,
  actualInputTokens: number,
  cacheHitRate?: number,
): ContextBreakdown {
  const raw = estimate.parts.filter((part) => part.kind !== 'free');
  const rawSum = raw.reduce((n, part) => n + part.tokens, 0);
  const used = Math.max(0, Math.round(actualInputTokens));
  const scale = rawSum > 0 ? used / rawSum : 0;
  const scaled = raw.map((part) => ({
    kind: part.kind,
    tokens: Math.round(part.tokens * scale),
  }));
  if (scaled.length > 0 && used > 0) {
    const diff = used - scaled.reduce((n, part) => n + part.tokens, 0);
    scaled[scaled.length - 1]!.tokens = Math.max(0, scaled[scaled.length - 1]!.tokens + diff);
  }
  return finish(
    toParts(Object.fromEntries(scaled.map((part) => [part.kind, part.tokens]))),
    used,
    estimate.contextWindow,
    estimate.model,
    cacheHitRate ?? estimate.cacheHitRate,
  );
}

function toParts(tokens: Record<string, number>): ContextBreakdown['parts'] {
  const order: PartKind[] = ['system', 'tools', 'mcp', 'memory', 'messages', 'tool_results'];
  return order.map((kind) => ({ kind, tokens: Math.max(0, Math.round(tokens[kind] ?? 0)) }));
}

function sumParts(parts: ContextBreakdown['parts']): number {
  return parts.reduce((n, part) => n + part.tokens, 0);
}

function finish(
  parts: ContextBreakdown['parts'],
  usedTokens: number,
  contextWindow: number,
  model: string,
  cacheHitRate?: number,
): ContextBreakdown {
  const free = Math.max(0, contextWindow - usedTokens);
  return {
    model,
    contextWindow,
    usedTokens,
    parts: [...parts, { kind: 'free', tokens: free }],
    ...(cacheHitRate !== undefined && Number.isFinite(cacheHitRate)
      ? { cacheHitRate: Math.max(0, Math.min(1, cacheHitRate)) }
      : {}),
    updatedAt: Date.now(),
  };
}

/** 会话累计缓存命中率：cacheRead / (未命中输入 + cacheRead + cacheWrite)。 */
export function cacheHitRateOf(usage: {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number | undefined {
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const total = usage.inputTokens + read + write;
  return total > 0 ? read / total : undefined;
}
