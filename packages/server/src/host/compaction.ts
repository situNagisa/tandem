// 历史压缩：复用 /compact 提示词，把较早的对话压成摘要，并保留最近若干轮原文。
// 供手动 /compact、请求前自动压缩、上下文超长报错后的兜底压缩共用。
import { randomUUID } from 'node:crypto';
import type { ContentBlock, Message } from '@tandem/protocol';
import type { Host } from '../host.js';
import type { SessionRecord } from '../types.js';
import {
  contextWindowForModel,
  estimateMessagesTokens,
  estimateTokens,
  keepFromIndex,
} from '../context.js';
import { streamChat } from '../providers/index.js';
import { costOfUsage, priceForModel } from '../usage.js';
import { errorMessage } from '../util/text.js';
import { splitCompactOutput } from './helpers.js';

export interface CompactHistoryOptions {
  model: string;
  /** 保留最近多少轮原文；0 表示全部压缩。 */
  keepTurns: number;
  /** 自动触发（含超长报错兜底）为 true，手动 /compact 为 false。 */
  auto: boolean;
  /** 强制压缩：历史不足 keepTurns 时也至少压掉最老的一轮（上下文已超长时使用）。 */
  force?: boolean;
  signal?: AbortSignal;
}

export interface CompactHistoryResult {
  /** 压缩后的消息列表：[摘要（界面隐藏）, 压缩提示, ...保留的最近轮次]。 */
  messages: Message[];
  summary: string;
  savedTokens: number;
  keptTurns: number;
  removedMessages: number;
}

/** token 数展示：82k / 950。 */
function formatShortTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * 压缩一段历史。返回 undefined 表示没有可压缩的更早内容（不足保留轮数）。
 * 会把摘要里提取的长期事实写入项目记忆，并在会话里留下可展开的压缩提示。
 */
export async function compactHistory(
  host: Host,
  rec: SessionRecord,
  history: Message[],
  opts: CompactHistoryOptions,
): Promise<CompactHistoryResult | undefined> {
  let keepTurns = Math.max(0, Math.round(opts.keepTurns));
  let boundary = keepTurns === 0 ? history.length : keepFromIndex(history, keepTurns);
  if (boundary <= 0 && keepTurns > 0 && opts.force) {
    // 历史不足保留轮数：至少压掉最老的一轮，避免超长请求原样重发
    const turnStarts = history.filter((message) =>
      message.role === 'user' &&
      !message.summary &&
      message.content.some((block) => block.type !== 'tool_result'),
    ).length;
    keepTurns = Math.max(0, turnStarts - 1);
    boundary = keepTurns === 0 ? history.length : keepFromIndex(history, keepTurns);
  }
  if (boundary <= 0 && keepTurns > 0) return undefined;
  const older = history.slice(0, boundary);
  const kept = history.slice(boundary);
  if (older.length === 0) return undefined;

  const selection = host.keyCandidates(rec.profileId, rec.groupId);
  const compactKey = selection.candidates[0];
  const profile = compactKey?.profile ?? host.profileFor(rec.profileId, rec.groupId);
  if (!profile?.apiKey) {
    throw new Error(host.keysUnavailableMessage(rec.profileId, rec.groupId) ?? '当前账号未配置 API Key');
  }
  if (!opts.model) throw new Error('当前账号没有配置模型');
  host.assertBudget(rec, opts.model);

  const instructionText = host.promptTemplates.get('compact', rec.cwd);
  const instruction: Message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: instructionText }],
    createdAt: Date.now(),
  };
  const system = host.buildSystemFor(rec, { allowTask: false }).system;
  const compactInput = fitForCompactor(
    older.filter((message) => !message.notice),
    contextWindowForModel(opts.model, profile.kind, profile.modelCapabilities),
    estimateTokens(system) + estimateTokens(instructionText) + 4096,
  );

  const blocks: ContentBlock[] = [];
  let result: Awaited<ReturnType<typeof streamChat>>;
  try {
    result = await streamChat({
      profile,
      model: opts.model,
      system,
      messages: [...compactInput, instruction],
      tools: [],
      blocks,
      signal: opts.signal ?? new AbortController().signal,
      idleTimeoutSec: host.config.idleTimeoutSec ?? 180,
      maxTokens: 4096,
      onBlockStart: () => {},
      onText: () => {},
      onToolInput: () => {},
    });
    host.markKeySuccess(rec.profileId, rec.groupId, compactKey?.keyId);
  } catch (err) {
    host.markKeyFailure(rec.profileId, rec.groupId, compactKey?.keyId, err);
    throw err;
  }

  const raw = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  const { summary, facts } = splitCompactOutput(raw);
  if (!summary) throw new Error('模型没有返回摘要内容');
  // 摘要里提取的长期事实先写入项目记忆，再替换历史
  if (facts.length > 0) {
    try {
      host.memory.add(rec.cwd, facts.join('\n'));
    } catch (err) {
      console.warn('[tandem] 写入项目记忆失败:', errorMessage(err));
    }
  }

  const summaryMessage: Message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `[此前对话摘要]\n\n${summary}` }],
    createdAt: Date.now(),
    summary: true,
  };
  const savedTokens = Math.max(
    0,
    estimateMessagesTokens(older) - estimateMessagesTokens([summaryMessage]),
  );
  const notice: Message = {
    id: randomUUID(),
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: `${opts.auto ? '已自动压缩' : '已压缩上下文'} · 节省 ${formatShortTokens(savedTokens)} tokens`,
      },
    ],
    createdAt: Date.now(),
    notice: true,
    compaction: { summary, savedTokens, keptTurns: keepTurns, auto: opts.auto },
  };

  recordCompactUsage(host, rec, opts.model, profile, result.usage, compactKey?.keyId);

  return {
    messages: [summaryMessage, notice, ...kept],
    summary,
    savedTokens,
    keptTurns: keepTurns,
    removedMessages: older.length,
  };
}

/** 压缩请求本身也可能撞上上下文上限：先裁剪/截断旧内容，保证摘要请求发得出去。 */
function fitForCompactor(messages: Message[], contextWindow: number, reservedTokens: number): Message[] {
  const budget = Math.max(1000, Math.floor(contextWindow * 0.85) - reservedTokens);
  if (estimateMessagesTokens(messages) <= budget) return messages;
  let current = messages.map((message) => ({
    ...message,
    content: message.content.map((block) => ({ ...block })),
  }));

  // 1）先替换大工具结果
  current = current.map((message) => ({
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'tool_result' || estimateTokens(block.content) <= 1500) return block;
      const lines = block.content.split('\n').length;
      return { ...block, content: `[已省略 ${lines} 行，可用 Read 重新读取]` };
    }),
  }));

  // 2）再截断超长文本
  if (estimateMessagesTokens(current) > budget) {
    const clip = 4000;
    current = current.map((message) => ({
      ...message,
      content: message.content.map((block) => {
        if (block.type === 'text' && block.text.length > clip) {
          return { ...block, text: `${block.text.slice(0, clip)}\n…（压缩前已截断）` };
        }
        if (block.type === 'thinking' && block.text.length > clip) {
          return { ...block, text: block.text.slice(0, clip) };
        }
        return block;
      }),
    }));
  }

  // 3）仍然超预算时从最旧的开始丢弃，至少保留最近两条
  while (estimateMessagesTokens(current) > budget && current.length > 2) current.shift();
  return current;
}

function recordCompactUsage(
  host: Host,
  rec: SessionRecord,
  model: string,
  profile: NonNullable<ReturnType<Host['profileFor']>>,
  usage: Awaited<ReturnType<typeof streamChat>>['usage'],
  keyId?: string,
): void {
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const cacheReadTokens = usage.cacheReadTokens || 0;
  const cacheWriteTokens = usage.cacheWriteTokens || 0;
  rec.usage.inputTokens += inputTokens;
  rec.usage.outputTokens += outputTokens;
  rec.usage.cacheReadTokens = (rec.usage.cacheReadTokens ?? 0) + cacheReadTokens;
  rec.usage.cacheWriteTokens = (rec.usage.cacheWriteTokens ?? 0) + cacheWriteTokens;
  const price = priceForModel(profile, model);
  const cost = costOfUsage(price, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, profile.kind);
  if (price) rec.usage.costUsd = Math.round(((rec.usage.costUsd ?? 0) + cost) * 1e8) / 1e8;
  if (profile.kind !== 'demo') {
    host.usage.record({
      hostId: host.config.hostId,
      profileId: rec.profileId,
      model,
      inputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
      outputTokens,
      costUsd: cost,
      ...(keyId ? { keyId } : {}),
      ...(rec.groupId ? { groupId: rec.groupId } : {}),
    });
  }
}
