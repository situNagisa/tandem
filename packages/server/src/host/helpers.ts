// host.ts 拆出的纯函数：不持有 Host 状态，供 host/ 各模块复用。
import { readFileSync } from 'node:fs';
import type {
  ContentBlock,
  DelegationStrategy,
  PermissionDecision,
  PermissionMode,
  ReasoningEffort,
  SlashCommand,
  VoiceSettings,
} from '@tandem/protocol';
import { providerDefaultBaseUrl } from '../config.js';
import { cacheHitRateOf } from '../context.js';
import { normalizeFactLines } from '../memory.js';
import type { SessionRecord, StoredProfile } from '../types.js';

/** 只保留已知字段，路径原样（客户端填写的是 Host 本机路径）。 */
export function sanitizeVoiceSettings(input: VoiceSettings): VoiceSettings {
  const engine =
    input.engine === 'whisper-cpp' || input.engine === 'faster-whisper' ? input.engine : 'auto';
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    engine,
    binaryPath: text(input.binaryPath, 4096),
    modelPath: text(input.modelPath, 4096),
    language: text(input.language, 16) || 'zh',
  };
}

export const PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);

export const EFFORTS = new Set<ReasoningEffort>(['off', 'low', 'medium', 'high', 'max']);
export const DELEGATIONS = new Set<DelegationStrategy>(['orchestrate', 'more', 'less', 'none']);

export interface PermissionEntry {
  sessionId: string;
  resolve: (decision: PermissionDecision, reason?: string) => void;
}

/** 预算金额展示：常规金额保留两位，极小金额保留有效小数。 */
export function formatUsd(value: number): string {
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/** 带 HTTP 状态码的错误，供 server 路由按状态返回（如运行中回退 409）。 */
export function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** `#记住 …` 的正文；不是该前缀时返回 undefined。支持 `#记住：` / `#记住 `。 */
export function rememberTextOf(content: ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined;
  const first = content[0];
  if (!first || first.type !== 'text') return undefined;
  const text = first.text.trim();
  if (!text.startsWith('#记住')) return undefined;
  return text.replace(/^#记住\s*[:：]?\s*/, '').trim();
}

/** /compact 输出拆成摘要与长期记忆事实；模型未按格式输出时整段当摘要。 */
export function splitCompactOutput(raw: string): { summary: string; facts: string[] } {
  const match = /^#{2,3}\s*项目记忆\s*$/m.exec(raw);
  if (!match) return { summary: raw.trim(), facts: [] };
  const before = raw.slice(0, match.index).trim();
  const after = raw.slice(match.index + match[0].length).trim();
  const summary = before.replace(/^#{2,3}\s*摘要\s*$/m, '').trim() || before;
  const facts = normalizeFactLines(after).filter(
    (line) => !/^[-*]\s*(无|none|暂无|无。)\s*$/i.test(line),
  );
  return { summary: summary || after, facts };
}

/** /cost 的本地摘要：token 用量 + 已记录花费。 */
export function costSummary(rec: SessionRecord): string {
  const usage = rec.usage;
  const cost =
    typeof usage.costUsd === 'number' ? `$${usage.costUsd.toFixed(4)}` : '未记录（该账号未配置单价）';
  const hit = cacheHitRateOf(usage);
  const totalInput =
    usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return [
    '本会话用量',
    `- 输入 token: ${usage.inputTokens.toLocaleString('en-US')}（未命中缓存）`,
    `- 输出 token: ${usage.outputTokens.toLocaleString('en-US')}`,
    `- 缓存读: ${(usage.cacheReadTokens ?? 0).toLocaleString('en-US')}`,
    `- 缓存写: ${(usage.cacheWriteTokens ?? 0).toLocaleString('en-US')}`,
    `- 缓存命中率: ${hit !== undefined ? `${Math.round(hit * 100)}%` : '—'}`,
    `- 总输入（含缓存）: ${totalInput.toLocaleString('en-US')}`,
    `- 累计花费: ${cost}`,
    `- 当前模型: ${rec.model || '(未设置)'}`,
  ].join('\n');
}

export function labelOfSource(source: SlashCommand['source']): string {
  if (source === 'builtin') return '内置';
  if (source === 'project') return '项目';
  if (source === 'skill') return '技能';
  return '用户';
}

/** 清理模型返回的标题：取首行、去引号/前缀，限制 20 字。 */
export function cleanTitle(raw: string): string {
  let title = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  title = title
    .replace(/^标题\s*[:：]\s*/, '')
    .replace(/^["'`“”‘’「」『』《》]+|["'`“”‘’「」『』《》]+$/g, '')
    .replace(/[。！？!?，,、；;：:]+$/g, '')
    .trim();
  return [...title].slice(0, 20).join('').trim();
}

export function commandPrefix(command: string): string {
  const firstLine = command.split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? '';
  if (!firstLine) return '';
  const tokens = firstLine.split(' ');
  const prefixTokens = [tokens[0]!];
  if (tokens[1] && !tokens[1].startsWith('-')) prefixTokens.push(tokens[1]);
  return prefixTokens.join(' ');
}

export function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'text' ||
    type === 'thinking' ||
    type === 'image' ||
    type === 'tool_use' ||
    type === 'tool_result'
  );
}

export function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

/** 供 server 路由复用。 */
export function defaultBaseUrlFor(kind: StoredProfile['kind']): string {
  return providerDefaultBaseUrl(kind);
}
