// 上下文占用估算：请求前按字符数粗估各部分，收到真实 usage 后按比例校准。
// 参考 Claude Code /context 的分类；token 估算使用字符数 / 3.5。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  ContextBreakdown,
  ContextSettings,
  ContextTopItem,
  ContextTurnItem,
  Message,
  ModelCapabilities,
  ProviderKind,
} from '@tandem/protocol';
import type { ToolDefinition } from './types.js';
import { builtinCapabilities, overrideFor } from './providers/capabilities.js';

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

export function contextWindowForModel(
  model: string,
  kind?: ProviderKind,
  overrides?: Record<string, ModelCapabilities>,
): number {
  const fromOverride = overrideFor(overrides, model)?.contextWindow;
  if (fromOverride !== undefined) return fromOverride;
  if (kind) {
    const fromCapabilities = builtinCapabilities(kind, model).contextWindow;
    if (fromCapabilities !== undefined) return fromCapabilities;
  }
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
  providerKind?: ProviderKind;
  capabilityOverrides?: Record<string, ModelCapabilities>;
  /** 自动压缩触发配置；只用于面板提示，不参与估算。 */
  autoCompact?: { enabled: boolean; threshold: number };
}

/** 用户消息里只要不是纯 tool_result，就算新的一轮开始；压缩摘要不计一轮。 */
export function isTurnStart(message: Message): boolean {
  return (
    message.role === 'user' &&
    !message.summary &&
    message.content.some((block) => block.type !== 'tool_result')
  );
}

/** 每条消息所属轮次（1-based；纯 tool_result 的 user 消息归入前面最近的轮次）。 */
export function turnNumbers(messages: Message[]): number[] {
  let turn = 0;
  return messages.map((message) => {
    if (isTurnStart(message)) turn += 1;
    return turn;
  });
}

/** 保留最近 keepTurns 轮原文时的起始下标；不足 keepTurns 轮时返回 0。 */
export function keepFromIndex(messages: Message[], keepTurns: number): number {
  if (keepTurns <= 0) return 0;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isTurnStart(messages[i]!)) continue;
    seen += 1;
    if (seen === keepTurns) return i;
  }
  return 0;
}

function previewOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/** 消息整体 token 估算（与 estimateBreakdown 的 messages/tool_results 口径一致）。 */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += 4;
    for (const block of message.content) {
      if (block.type === 'text') total += estimateTokens(block.text);
      else if (block.type === 'thinking') total += estimateTokens(block.text);
      else if (block.type === 'image') total += 1_200;
      else if (block.type === 'tool_use') total += estimateTokens(JSON.stringify(block.input ?? {}));
      else if (block.type === 'tool_result') total += estimateTokens(block.content);
    }
  }
  return total;
}

export interface TrimmedMessages {
  messages: Message[];
  trimmed: number;
  savedTokens: number;
}

/** 发送前把较旧的大工具输出换成占位；返回副本，会话里的原文不动。 */
export function trimOldToolResults(
  messages: Message[],
  settings: ContextSettings,
): TrimmedMessages {
  if (!settings.trimLargeToolResults) return { messages, trimmed: 0, savedTokens: 0 };
  const turns = turnNumbers(messages);
  const currentTurn = turns.length > 0 ? turns[turns.length - 1]! : 0;
  // 只裁剪「最近 N 轮之外」的工具输出
  const cutoff = currentTurn - settings.trimKeepTurns;
  if (cutoff <= 0) return { messages, trimmed: 0, savedTokens: 0 };
  let trimmed = 0;
  let savedTokens = 0;
  const next = messages.map((message, index) => {
    if (turns[index]! > cutoff) return message;
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const tokens = estimateTokens(block.content);
      if (tokens <= settings.trimToolResultTokens) return block;
      const lines = block.content.split('\n').length;
      const placeholder = `[已省略 ${lines} 行，可用 Read 重新读取]`;
      changed = true;
      trimmed += 1;
      savedTokens += tokens - estimateTokens(placeholder);
      return { ...block, content: placeholder };
    });
    return changed ? { ...message, content } : message;
  });
  return { messages: next, trimmed, savedTokens };
}

export function autoCompactTriggerTokens(
  contextWindow: number,
  settings: ContextSettings,
): number {
  return Math.floor(contextWindow * settings.autoCompactThreshold);
}

/**
 * 是否达到自动压缩阈值。
 * 字符数估算（约 3.5 字符/token）对中文明显偏低，只看本轮估算会让占用早已过半的会话永远不压缩；
 * 因此同时参考上一次请求按真实 usage 校准的占用。压缩后传 undefined，避免在旧基线上重复触发。
 */
export function autoCompactDue(
  estimateUsedTokens: number,
  lastActualUsedTokens: number | undefined,
  contextWindow: number,
  settings: ContextSettings,
): boolean {
  const used = Math.max(estimateUsedTokens, lastActualUsedTokens ?? 0);
  return used >= autoCompactTriggerTokens(contextWindow, settings);
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
  let turn = 0;
  const toolNames = new Map<string, string>();
  const toolOwners = new Map<string, string>();
  const items: ContextTopItem[] = [];
  const turnItems = new Map<number, ContextTopItem[]>();
  const turnAccs: Array<{ turn: number; messageId: string; preview: string; tokens: number }> = [];
  let currentTurn: (typeof turnAccs)[number] | null = null;
  const addItem = (item: ContextTopItem) => {
    items.push(item);
    const list = turnItems.get(item.turn);
    if (list) list.push(item);
    else turnItems.set(item.turn, [item]);
  };
  for (const message of input.messages) {
    if (isTurnStart(message)) {
      turn += 1;
      currentTurn = { turn, messageId: message.id, preview: '', tokens: 0 };
      turnAccs.push(currentTurn);
    }
    messages += 4;
    if (currentTurn && !message.summary) currentTurn.tokens += 4;
    let messageTokens = 0;
    let messagePreview = '';
    for (const block of message.content) {
      if (block.type === 'text') {
        const tokens = estimateTokens(block.text);
        messages += tokens;
        messageTokens += tokens;
        if (currentTurn && !message.summary) currentTurn.tokens += tokens;
        if (!messagePreview) messagePreview = previewOf(block.text);
      } else if (block.type === 'thinking') {
        const tokens = estimateTokens(block.text);
        messages += tokens;
        messageTokens += tokens;
        if (currentTurn && !message.summary) currentTurn.tokens += tokens;
        if (!messagePreview) messagePreview = previewOf(block.text);
      } else if (block.type === 'image') {
        messages += 1_200;
        messageTokens += 1_200;
        if (currentTurn && !message.summary) currentTurn.tokens += 1_200;
        if (!messagePreview) messagePreview = '[图片]';
      } else if (block.type === 'tool_use') {
        const tokens = estimateTokens(JSON.stringify(block.input ?? {}));
        messages += tokens;
        messageTokens += tokens;
        if (currentTurn && !message.summary) currentTurn.tokens += tokens;
        toolNames.set(block.id, block.name);
        toolOwners.set(block.id, message.id);
        if (!messagePreview) messagePreview = `工具调用 ${block.name}`;
      } else if (block.type === 'tool_result') {
        const tokens = estimateTokens(block.content);
        toolResults += tokens;
        if (currentTurn && !message.summary) currentTurn.tokens += tokens;
        if (tokens > 0) {
          const tool = toolNames.get(block.toolUseId);
          addItem({
            // 指向对应 tool_use 所在消息，面板点一下能滚到工具卡
            messageId: toolOwners.get(block.toolUseId) ?? message.id,
            role: message.role,
            kind: 'tool_result',
            turn,
            tokens,
            preview: previewOf(block.content) || '（空输出）',
            ...(tool ? { tool } : {}),
          });
        }
      }
    }
    if (currentTurn && !message.summary && !currentTurn.preview && messagePreview) {
      currentTurn.preview = messagePreview;
    }
    if (messageTokens > 0 && !message.summary) {
      addItem({
        messageId: message.id,
        role: message.role,
        kind: 'message',
        turn,
        tokens: messageTokens,
        preview: messagePreview || '消息',
      });
    }
  }
  const topItems = [...items].sort((a, b) => b.tokens - a.tokens).slice(0, 10);
  // 「最占空间」以用户发言为基本单位：每轮总量 + 该轮内最大的几项，供二级展开。
  const topTurns: ContextTurnItem[] = turnAccs
    .filter((acc) => acc.turn > 0 && acc.tokens > 0)
    .map((acc) => ({
      turn: acc.turn,
      messageId: acc.messageId,
      tokens: acc.tokens,
      preview: acc.preview || '（无文本）',
      items: [...(turnItems.get(acc.turn) ?? [])].sort((a, b) => b.tokens - a.tokens).slice(0, 5),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.turn - b.turn)
    .slice(0, 10);

  const parts = toParts({ system, tools, mcp, memory, messages, tool_results: toolResults });
  const usedTokens = sumParts(parts);
  const contextWindow = contextWindowForModel(
    input.model,
    input.providerKind,
    input.capabilityOverrides,
  );
  return finish(
    parts,
    usedTokens,
    contextWindow,
    input.model,
    input.cacheHitRate,
    input.autoCompact,
    topItems,
    topTurns,
  );
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
    estimate.autoCompact,
    estimate.topItems?.map((item) => ({ ...item, tokens: Math.round(item.tokens * scale) })),
    estimate.topTurns?.map((turn) => ({
      ...turn,
      tokens: Math.round(turn.tokens * scale),
      items: turn.items.map((item) => ({ ...item, tokens: Math.round(item.tokens * scale) })),
    })),
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
  autoCompact?: { enabled: boolean; threshold: number },
  topItems?: ContextTopItem[],
  topTurns?: ContextTurnItem[],
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
    ...(autoCompact ? { autoCompact: { ...autoCompact } } : {}),
    ...(topItems && topItems.length > 0 ? { topItems } : {}),
    ...(topTurns && topTurns.length > 0 ? { topTurns } : {}),
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
