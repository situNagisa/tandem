// 外部会话（Claude Code / Codex）：只读扫描原软件的数据目录，转换为 Tandem 消息格式。
// 绝不写原软件文件；"导入"只是把内容复制成一个新的 Tandem 会话。
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import type {
  ContentBlock,
  ExternalSession,
  ExternalSource,
  Message,
  Session,
} from '@tandem/protocol';
import type { Host } from './host.js';
import type { SessionRecord } from './types.js';
import { truncateMiddle } from './util/text.js';

interface Meta {
  source: ExternalSource;
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  file: string;
}

interface Parsed extends Meta {
  messages: Message[];
  /** Codex 内部 subagent（guardian 等）会话，不展示给用户。 */
  hidden?: boolean;
}

interface CacheEntry {
  version: number;
  mtimeMs: number;
  size: number;
  meta: Meta | null;
}

export interface ExternalImportInput {
  profileId?: unknown;
  groupId?: unknown;
  model?: unknown;
}

const PROJECTS_DIR = path.join('.claude', 'projects');
/** 与 Codex CLI 一致：CODEX_HOME 指向 ~/.codex 的替代目录（测试也用它指向假目录）。 */
const CODEX_HOME = process.env.CODEX_HOME?.trim();
const CODEX_ROOT = CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_ROOT, 'sessions');
const CODEX_INDEX_FILE = path.join(CODEX_ROOT, 'session_index.jsonl');

/** 解析规则变化时递增，旧条目自动失效。 */
const CACHE_VERSION = 4;

/** 外部工具注入的整块标签：系统提醒、提及列表、IDE 上下文、Codex 环境说明等。 */
const DROP_TAGS = [
  'system-reminder',
  'session-mentions',
  'ide_opened_file',
  'ide_selection',
  'ide_line',
  'ide_context',
  'user-prompt-submit-hook',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'task-notification',
  'environment_context',
  'user_instructions',
  'skills_instructions',
  'permissions instructions',
  'app-context',
  'collaboration_mode',
  'multi_agent_mode',
  'turn_aborted',
  'INSTRUCTIONS',
];

/** 命令回显块：转换为简短的 "/命令 参数" 文本。 */
const COMMAND_TAGS = ['command-name', 'command-message', 'command-args'];

/** 整条消息都是注入时直接收进上下文块的特征（无法可靠地只删其中一段）。 */
const INJECTED_MARKERS: Array<{ re: RegExp; kind: string }> = [
  { re: /^#*\s*AGENTS\.md instructions\b/im, kind: 'AGENTS.md' },
  { re: /<!--\s*CODEGRAPH_START/i, kind: 'codegraph' },
  { re: /^The following is the Codex agent history\b/im, kind: 'agent history' },
  { re: /^This session is being continued from a previous conversation\b/im, kind: 'conversation history' },
  { re: /^Caveat: The messages below were generated\b/im, kind: 'caveat' },
];

interface InjectedContext {
  kind: string;
  text: string;
}

/** Claude Code 的斜杠命令里，只有元命令不值得作为标题。 */
const META_COMMAND = /^\/(?:model|clear|effort|agents|statusline|help|login|logout|compact|config|permissions|resume|vim|terminal-setup|init|cost|doctor|memory|mcp|hooks|plugin|export|import)(?:\s|$)/i;

function tagged(tag: string): RegExp {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'gi');
}

function commandSummary(text: string): string {
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  if (!name) return '';
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  const command = name.startsWith('/') ? name : `/${name}`;
  return args ? `${command} ${args}` : command;
}

/** 去掉 @[名字](路径) 这类提及语法外壳，只留名字。 */
function unwrapMentions(text: string): string {
  return text.replace(/@\[([^\]\n]+)\](?:\([^)\n]*\))?/g, '$1');
}

/**
 * 把 Claude Code / Codex 注入到用户消息里的标签块收进可折叠的上下文，
 * 只留下真正的用户文本。整段注入（AGENTS.md 等）保留全文，前端默认折叠。
 */
export function extractInjected(text: string): { text: string; contexts: InjectedContext[] } {
  const contexts: InjectedContext[] = [];
  const marker = INJECTED_MARKERS.find((item) => item.re.test(text));
  let out = text;
  if (marker && marker.kind !== 'AGENTS.md') {
    const value = text.trim();
    if (value) contexts.push({ kind: marker.kind, text: value });
    return { text: '', contexts };
  }
  // AGENTS.md 头只占一行，后面常跟着 <INSTRUCTIONS> 等块；拆开保留，其余注入仍按标签分类。
  if (marker) {
    const header = out.match(/^#*\s*AGENTS\.md instructions[^\n]*\r?\n?/i)?.[0] ?? '';
    if (!header) {
      const value = out.trim();
      if (value) contexts.push({ kind: 'AGENTS.md', text: value });
      return { text: '', contexts };
    }
    if (header) {
      out = out.slice(header.length);
      const instructions = out.match(/<INSTRUCTIONS(?:\s[^>]*)?>([\s\S]*?)<\/INSTRUCTIONS>/i);
      const parts = [header.trim()];
      if (instructions) {
        const value = String(instructions[1] ?? '').trim();
        if (value) parts.push(value);
        out = out.replace(instructions[0], '');
      }
      contexts.push({ kind: 'AGENTS.md', text: parts.join('\n\n') });
    }
  }

  const command = commandSummary(text);
  for (const tag of COMMAND_TAGS) out = out.replace(tagged(tag), '');
  for (const tag of DROP_TAGS) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
    out = out.replace(re, (_whole, inner: string) => {
      const value = String(inner ?? '').trim();
      if (value) contexts.push({ kind: tag, text: value });
      return '';
    });
  }
  // 未闭合的注入标签（如被截断的 <INSTRUCTIONS>）整块收进上下文。
  const unclosed = out.match(/^\s*<([a-zA-Z][\w: -]*?)(?:\s[^>]*)?>/);
  if (unclosed) {
    const name = unclosed[1]!.trim();
    if (DROP_TAGS.some((tag) => tag.toLowerCase() === name.toLowerCase())) {
      const value = out.trim();
      if (value) contexts.push({ kind: name, text: value });
      out = '';
    }
  }
  out = unwrapMentions(out)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: command ? `${command}${out ? `\n${out}` : ''}` : out, contexts };
}

/** 明显是系统注入/命令回显的内容，不作为标题。 */
function isInjectedText(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  if (value.startsWith('<')) return true;
  if (/^caveat:/i.test(value)) return true;
  if (value.startsWith('[Request interrupted')) return true;
  if (value.startsWith('This session is being continued')) return true;
  if (value.startsWith('The following is the Codex agent history')) return true;
  if (value === '已授权' || /^(?:approved|denied)$/i.test(value)) return true;
  if (META_COMMAND.test(value)) return true;
  if (/^\/\S+$/.test(value)) return true;
  if (INJECTED_MARKERS.some((item) => item.re.test(value))) return true;
  return false;
}

export function cleanTitle(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '';
  const plain = unwrapMentions(line)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...plain].slice(0, 60).join('').trim();
}

/** 标题本身是注入文本（含旧版本导入时存下的坏标题，例如 "# AGENTS.md instructions …"）。 */
export function isInjectedTitle(title: string): boolean {
  const value = title.replace(/\s+/g, ' ').trim();
  if (!value) return false;
  // 只判定“标题本身就是注入内容”，避免误伤正文里提到 AGENTS.md 的正常标题。
  if (/^(?:#+\s*)?AGENTS\.md instructions\b/i.test(value)) return true;
  if (/CODEGRAPH_(?:START|END)/i.test(value)) return true;
  if (/^(?:The following is the Codex agent history|This session is being continued from a previous conversation|Caveat: The messages below were generated)\b/i.test(value)) return true;
  const tag = value.match(/^<\/?([a-zA-Z][\w: -]*?)(?:\s[^>]*)?>/);
  if (tag && DROP_TAGS.some((item) => item.toLowerCase() === tag[1]!.trim().toLowerCase())) return true;
  return false;
}

/** 从消息里找第一条真实用户文本重新生成标题；都不可用时退回项目名 + 日期。 */
export function titleFromMessages(messages: Message[], cwd: string, createdAt: number): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = message.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (!text.trim()) continue;
    const title = cleanTitle(text);
    if (title && !isInjectedTitle(title)) return title;
  }
  return fallbackTitle(cwd, createdAt);
}

/** 用户文本块统一过一遍注入清理：注入内容转成折叠上下文，空文本块丢弃。 */
export function cleanUserBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type !== 'text') {
      out.push(block);
      continue;
    }
    const { text, contexts } = extractInjected(block.text);
    for (const context of contexts) {
      out.push({ type: 'context', kind: context.kind, text: context.text });
    }
    if (text) out.push({ ...block, text });
  }
  return out;
}

function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

/** Codex 新版本会把 rollout 写成 .jsonl.zst；读取时解压到内存，绝不回写。 */
function readSessionText(file: string): string {
  try {
    const raw = readFileSync(file);
    return file.endsWith('.zst') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
  } catch {
    return '';
  }
}

/** tool_result 的内容可能是字符串或内容块数组。 */
function contentToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object') {
        const block = item as Record<string, unknown>;
        if (block.type === 'image') parts.push('[图片]');
        else if (typeof block.text === 'string') parts.push(block.text);
      }
    }
    return parts.join('\n');
  }
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function truncateContent(text: string): string {
  // 预览/导入时限制单条工具输出长度，避免超大会话撑爆客户端
  return text.length > 50_000 ? truncateMiddle(text, 50_000) : text;
}

/** Anthropic 格式内容块 -> 协议 ContentBlock。 */
function convertClaudeBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    const text = content.trim() ? content : '';
    return text ? [{ type: 'text', text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case 'text': {
        if (typeof block.text === 'string' && block.text) blocks.push({ type: 'text', text: block.text });
        break;
      }
      case 'thinking': {
        const text = typeof block.thinking === 'string' ? block.thinking : typeof block.text === 'string' ? block.text : '';
        if (text) blocks.push({ type: 'thinking', text });
        break;
      }
      case 'redacted_thinking':
        blocks.push({ type: 'thinking', text: '[已打码的思考内容]' });
        break;
      case 'tool_use': {
        if (typeof block.id !== 'string' || typeof block.name !== 'string') break;
        blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} });
        break;
      }
      case 'tool_result': {
        if (typeof block.tool_use_id !== 'string') break;
        blocks.push({
          type: 'tool_result',
          toolUseId: block.tool_use_id,
          content: truncateContent(contentToString(block.content)),
          ...(block.is_error === true ? { isError: true } : {}),
        });
        break;
      }
      case 'image': {
        const source = block.source as Record<string, unknown> | undefined;
        if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
          blocks.push({ type: 'image', mediaType: source.media_type, dataBase64: source.data });
        }
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function messageFrom(role: Message['role'], id: string, content: ContentBlock[], createdAt: number): Message {
  return { id, role, content, createdAt };
}

/**
 * 解析 Claude Code 会话 jsonl。collect=false 时只统计元信息（列表用），
 * collect=true 时产出完整消息（预览/导入用）。
 */
function parseClaudeFile(file: string, collect: boolean, fallbackId: string): Parsed {
  const text = readSessionText(file);
  const lines = text.split(/\r?\n/);
  const id = fallbackId;
  let cwd = '';
  let title = '';
  let summaryTitle = '';
  let customTitle = '';
  let agentName = '';
  let firstUserTitle = '';
  let createdAt = 0;
  let updatedAt = 0;
  let count = 0;
  const messages: Message[] = [];
  let last: Message | undefined;
  let lastToolOnly = false;

  const start = (role: Message['role'], blockId: string, content: ContentBlock[], ts: number): void => {
    const message = messageFrom(role, blockId, content, ts);
    count++;
    if (collect) {
      messages.push(message);
      last = message;
    } else {
      last = message;
    }
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'summary' && typeof o.summary === 'string' && !summaryTitle) {
      summaryTitle = cleanTitle(o.summary);
      continue;
    }
    // Claude Code 会话标题：custom-title 是当前标题，agent-name 是较早的写法
    if (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim()) {
      customTitle = cleanTitle(o.customTitle);
      continue;
    }
    if (o.type === 'agent-name' && typeof o.agentName === 'string' && o.agentName.trim()) {
      agentName = cleanTitle(o.agentName);
      continue;
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain === true || o.isMeta === true) continue;
    // 会话 id 以文件名为准：分叉/继续产生的文件里 sessionId 字段可能仍指向原会话
    if (typeof o.cwd === 'string' && o.cwd) cwd ||= o.cwd;
    const ts = parseTime(o.timestamp);
    if (ts) {
      if (!createdAt) createdAt = ts;
      updatedAt = Math.max(updatedAt, ts);
    }

    let rawMessage = o.message;
    if (typeof rawMessage === 'string') {
      try {
        rawMessage = JSON.parse(rawMessage);
      } catch {
        rawMessage = undefined;
      }
    }
    if (!rawMessage || typeof rawMessage !== 'object') continue;
    const msg = rawMessage as Record<string, unknown>;
    const role: Message['role'] = o.type === 'user' ? 'user' : 'assistant';
    let blocks = convertClaudeBlocks(msg.content);
    if (role === 'user') blocks = cleanUserBlocks(blocks);
    if (!blocks.length) continue;

    const toolOnly = blocks.every((b) => b.type === 'tool_result');
    // 首条真实用户文本作为兜底标题（跳过命令/系统注入内容）
    if (role === 'user' && !firstUserTitle && !toolOnly) {
      const userText = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (userText && !isInjectedText(userText)) firstUserTitle = cleanTitle(userText);
    }

    const messageId =
      typeof msg.id === 'string' && msg.id
        ? msg.id
        : typeof o.uuid === 'string' && o.uuid
          ? o.uuid
          : randomUUID();

    if (role === 'user' && toolOnly) {
      // 同一轮的工具结果合并成一条用户消息
      if (last && last.role === 'user' && lastToolOnly) {
        last.content.push(...blocks);
        if (collect) {
          if (!last.createdAt) last.createdAt = ts;
        }
      } else {
        start('user', messageId, blocks, ts);
        lastToolOnly = true;
      }
      continue;
    }

    if (role === 'assistant' && last && last.role === 'assistant' && last.id === messageId) {
      // Claude Code 按内容块逐行落盘，同一条 assistant 消息需要合并
      last.content.push(...blocks);
      continue;
    }

    start(role, messageId, blocks, ts);
    lastToolOnly = false;
  }

  const stat = statSafe(file);
  const created = createdAt || stat?.birthtimeMs || stat?.mtimeMs || 0;
  const rawTitle = summaryTitle || customTitle || agentName || firstUserTitle;
  title = rawTitle && !isInjectedTitle(rawTitle) ? rawTitle : fallbackTitle(cwd, created);
  return {
    source: 'claude-code',
    id,
    title: title || fallbackTitle(cwd, created),
    cwd,
    createdAt: created,
    updatedAt: updatedAt || stat?.mtimeMs || 0,
    messageCount: count,
    file,
    messages: collect ? messages : [],
  };
}

/** Codex 消息内容可能是字符串或 input_text/output_text/local_image 数组。 */
function convertCodexContent(content: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ type: 'text', text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim()) blocks.push({ type: 'text', text: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (typeof block.text === 'string' && block.text) {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && typeof block.data === 'string') {
      // 图片在协议里需要 base64 与 mediaType，结构不确定时保留占位
      const mediaType = typeof block.media_type === 'string' ? block.media_type : 'image/png';
      blocks.push({ type: 'image', mediaType, dataBase64: block.data });
    } else if (block.type === 'local_image') {
      blocks.push({ type: 'text', text: '[图片]' });
    }
  }
  return blocks;
}

/**
 * Codex rollout：session_meta / event_msg / response_item。
 * 新版本把真实用户输入放在 event_msg 的 UserMessage 里，response_item 的 user
 * 消息常混入 AGENTS.md、环境说明等注入；有 event 流时以 event 流为准，避免重复。
 */
function parseCodexFile(file: string, collect: boolean, fallbackId: string, knownTitle = ''): Parsed {
  const lines = readSessionText(file).split(/\r?\n/);
  const records: Array<{ o: Record<string, unknown>; ts: number }> = [];
  let hasUserEvent = false;
  let hasAgentEvent = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    records.push({ o, ts: parseTime(o.timestamp) });
    if (o.type !== 'event_msg') continue;
    const payload = o.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') continue;
    const kind = typeof payload.type === 'string' ? payload.type : '';
    if (kind === 'item_completed') {
      const item = payload.item as Record<string, unknown> | undefined;
      if (item?.type === 'UserMessage') hasUserEvent = true;
      else if (item?.type === 'AgentMessage') hasAgentEvent = true;
    } else if (kind === 'user_message') {
      hasUserEvent = true;
    } else if (kind === 'agent_message') {
      hasAgentEvent = true;
    }
  }

  let cwd = '';
  let firstUserTitle = '';
  let hidden = false;
  let createdAt = 0;
  let updatedAt = 0;
  let count = 0;
  const messages: Message[] = [];

  const push = (role: Message['role'], content: ContentBlock[], ts: number): void => {
    if (!content.length) return;
    count++;
    if (collect) messages.push(messageFrom(role, randomUUID(), content, ts));
  };

  const handleText = (role: 'user' | 'assistant', content: unknown, ts: number): void => {
    let blocks = convertCodexContent(content);
    if (!blocks.length) return;
    if (role === 'user') {
      blocks = cleanUserBlocks(blocks);
      if (!blocks.length) return;
      if (blocks.every((b) => b.type === 'text' && isInjectedText(b.text))) return;
      const textOnly = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (!firstUserTitle && textOnly && !isInjectedText(textOnly)) {
        firstUserTitle = cleanTitle(textOnly);
      }
    }
    push(role, blocks, ts);
  };

  const handleResponseItem = (payload: Record<string, unknown>, ts: number): void => {
    switch (payload.type) {
      case 'message': {
        const role = String(payload.role ?? '');
        // developer 是 Codex 的权限/技能/协作说明，不属于对话内容
        if (role === 'developer') break;
        if (role === 'user') {
          // 有 event_msg 时，response_item 的 user 只是回放，且多为注入
          if (!hasUserEvent) handleText('user', payload.content, ts);
        } else if (role === 'assistant') {
          if (!hasAgentEvent) handleText('assistant', payload.content, ts);
        }
        break;
      }
      case 'reasoning': {
        const parts: string[] = [];
        for (const key of ['summary', 'content'] as const) {
          const items = payload[key];
          if (!Array.isArray(items)) continue;
          for (const item of items) {
            if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') {
              parts.push(String((item as Record<string, unknown>).text));
            }
          }
        }
        if (parts.length) push('assistant', [{ type: 'thinking', text: parts.join('\n') }], ts);
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : typeof payload.id === 'string' ? payload.id : randomUUID();
        const name =
          typeof payload.name === 'string'
            ? payload.name
            : payload.type === 'local_shell_call'
              ? 'shell'
              : 'tool';
        let input: unknown = payload.arguments ?? payload.input ?? {};
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            input = { raw: input };
          }
        }
        push('assistant', [{ type: 'tool_use', id: callId, name, input }], ts);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
        if (!callId) break;
        push(
          'user',
          [{ type: 'tool_result', toolUseId: callId, content: truncateContent(contentToString(payload.output)) }],
          ts,
        );
        break;
      }
      default:
        break;
    }
  };

  const handleEvent = (payload: Record<string, unknown>, ts: number): void => {
    const kind = typeof payload.type === 'string' ? payload.type : '';
    if (kind === 'item_completed') {
      const item = payload.item as Record<string, unknown> | undefined;
      if (!item || typeof item !== 'object') return;
      if (item.type === 'UserMessage') handleText('user', item.content, ts);
      else if (item.type === 'AgentMessage') handleText('assistant', item.content, ts);
      return;
    }
    // 兼容旧版 event_msg：user_message / agent_message 直接带 message 字符串
    if (kind === 'user_message') handleText('user', payload.message, ts);
    else if (kind === 'agent_message') handleText('assistant', payload.message, ts);
  };

  for (const { o, ts } of records) {
    if (ts) {
      if (!createdAt) createdAt = ts;
      updatedAt = Math.max(updatedAt, ts);
    }
    const payload = o.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') continue;

    if (o.type === 'session_meta') {
      // 以文件名中的 uuid 作为会话 id，与列表路径保持一致
      if (typeof payload.cwd === 'string' && payload.cwd) cwd ||= payload.cwd;
      if (payload.thread_source === 'subagent') hidden = true;
      const source = payload.source as Record<string, unknown> | undefined;
      if (source && typeof source === 'object' && source.subagent) hidden = true;
      const metaTs = parseTime(payload.timestamp);
      if (metaTs && !createdAt) createdAt = metaTs;
      continue;
    }
    if (o.type === 'turn_context') {
      if (typeof payload.cwd === 'string' && payload.cwd) cwd ||= payload.cwd;
      continue;
    }
    if (o.type === 'event_msg') {
      handleEvent(payload, ts);
      continue;
    }
    if (o.type === 'response_item') {
      handleResponseItem(payload, ts);
      continue;
    }
    // 兼容更早的扁平格式
    if (o.type === 'message') handleText(String(o.role ?? '') === 'assistant' ? 'assistant' : 'user', o.content, ts);
  }

  const stat = statSafe(file);
  const created = createdAt || stat?.birthtimeMs || stat?.mtimeMs || 0;
  return {
    source: 'codex',
    id: fallbackId,
    title:
      (knownTitle && !isInjectedTitle(knownTitle) ? knownTitle : '') ||
      (firstUserTitle && !isInjectedTitle(firstUserTitle) ? firstUserTitle : '') ||
      fallbackTitle(cwd, created),
    cwd,
    createdAt: created,
    updatedAt: updatedAt || stat?.mtimeMs || 0,
    messageCount: count,
    file,
    messages: collect ? messages : [],
    ...(hidden ? { hidden: true } : {}),
  };
}

function statSafe(file: string) {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function formatDate(ts: number): string {
  if (!ts) return '';
  const date = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fallbackTitle(cwd: string, createdAt: number): string {
  const base = projectName(cwd);
  const date = formatDate(createdAt);
  if (base && date) return `${base} 的会话 · ${date}`;
  if (base) return `${base} 的会话`;
  return date ? `外部会话 · ${date}` : '外部会话';
}

/** 从 rollout-xxx-<uuid>.jsonl 等文件名里取兜底 id。 */
function idFromFile(file: string): string {
  const base = path.basename(file, '.jsonl');
  const uuid = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuid ? uuid[0] : base;
}

const WATCH_INTERVAL_MS = 30_000;

/** 扫描并缓存外部会话；按文件 mtime+size 增量更新。 */
export class ExternalSessionStore {
  private cache = new Map<string, CacheEntry>();
  private titleCache?: { mtimeMs: number; size: number; titles: Map<string, string> };
  private watchTimer?: NodeJS.Timeout;
  private signature = '';
  /** 短时间内重复拉取（侧栏 + Ctrl+K）直接复用，避免每次都 stat 3000 个文件。 */
  private listMemo = new Map<string, { at: number; result: ExternalSession[] }>();

  constructor(private readonly host: Host) {}

  private listFiles(source: ExternalSource): Array<{ file: string; fallbackId: string }> {
    const root =
      source === 'claude-code'
        ? path.join(os.homedir(), PROJECTS_DIR)
        : CODEX_SESSIONS_DIR;
    const out: Array<{ file: string; fallbackId: string }> = [];
    if (source === 'claude-code') {
      let dirs: string[] = [];
      try {
        dirs = readdirSync(root);
      } catch {
        return out;
      }
      for (const dir of dirs) {
        const projectDir = path.join(root, dir);
        try {
          if (!statSync(projectDir).isDirectory()) continue;
        } catch {
          continue;
        }
        let files: string[] = [];
        try {
          files = readdirSync(projectDir);
        } catch {
          continue;
        }
        for (const name of files) {
          if (!name.endsWith('.jsonl')) continue;
          const file = path.join(projectDir, name);
          if (!statSafe(file)?.isFile()) continue;
          out.push({ file, fallbackId: idFromFile(file) });
        }
      }
      return out;
    }

    // Codex：YYYY/MM/DD/rollout-*.jsonl
    const walk = (dir: string, depth: number): void => {
      if (depth > 3) return;
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const full = path.join(dir, name);
        const stat = statSafe(full);
        if (!stat) continue;
        if (stat.isDirectory()) walk(full, depth + 1);
        else if (
          name.startsWith('rollout-') &&
          (name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'))
        ) {
          out.push({ file: full, fallbackId: idFromFile(full) });
        }
      }
    };
    walk(root, 0);
    return out;
  }

  private metaOf(source: ExternalSource, file: string, fallbackId: string): Meta | null {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return null;
    }
    const cached = this.cache.get(file);
    if (
      cached &&
      cached.version === CACHE_VERSION &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.meta;
    }

    let parsed: Parsed;
    try {
      parsed = source === 'claude-code'
        ? parseClaudeFile(file, false, fallbackId)
        : parseCodexFile(file, false, fallbackId, this.codexTitles().get(fallbackId) ?? '');
    } catch (err) {
      console.warn(`[tandem] 无法解析外部会话 ${file}:`, (err as Error).message);
      this.cache.set(file, { version: CACHE_VERSION, mtimeMs: stat.mtimeMs, size: stat.size, meta: null });
      return null;
    }
    if (parsed.hidden) {
      this.cache.set(file, { version: CACHE_VERSION, mtimeMs: stat.mtimeMs, size: stat.size, meta: null });
      return null;
    }
    const meta: Meta = {
      source,
      id: parsed.id,
      title: parsed.title,
      cwd: parsed.cwd,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt || stat.mtimeMs,
      messageCount: parsed.messageCount,
      file,
    };
    this.cache.set(file, { version: CACHE_VERSION, mtimeMs: stat.mtimeMs, size: stat.size, meta });
    return meta;
  }

  /** Codex 会话标题索引（session_index.jsonl，用户重命名/自动生成）。 */
  private codexTitles(): Map<string, string> {
    const file = CODEX_INDEX_FILE;
    const stat = statSafe(file);
    if (!stat) {
      this.titleCache = undefined;
      return new Map();
    }
    if (
      this.titleCache &&
      this.titleCache.mtimeMs === stat.mtimeMs &&
      this.titleCache.size === stat.size
    ) {
      return this.titleCache.titles;
    }
    const titles = new Map<string, string>();
    const updated = new Map<string, string>();
    for (const line of readSessionText(file).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = typeof o.id === 'string' ? o.id : '';
      const name = typeof o.thread_name === 'string' ? o.thread_name : '';
      if (!id || !name.trim() || isInjectedText(name)) continue;
      const at = typeof o.updated_at === 'string' ? o.updated_at : '';
      if (titles.has(id) && (updated.get(id) ?? '') > at) continue;
      titles.set(id, cleanTitle(name));
      updated.set(id, at);
    }
    this.titleCache = { mtimeMs: stat.mtimeMs, size: stat.size, titles };
    return titles;
  }

  /** 轻量文件签名：只 stat，不解析内容，用于 30s 定时发现外部会话变动。 */
  private fileSignature(): string {
    const parts: string[] = [];
    for (const source of ['claude-code', 'codex'] as ExternalSource[]) {
      for (const item of this.listFiles(source)) {
        const stat = statSafe(item.file);
        if (stat) parts.push(`${item.file}:${stat.mtimeMs}:${stat.size}`);
      }
    }
    return parts.sort().join('|');
  }

  /** 定时扫描外部目录，文件变化时通知 Host 广播事件（只读，不写原文件）。 */
  startWatching(onChange: () => void): void {
    if (this.watchTimer) return;
    this.signature = this.fileSignature();
    this.watchTimer = setInterval(() => {
      const next = this.fileSignature();
      if (next === this.signature) return;
      this.signature = next;
      onChange();
    }, WATCH_INTERVAL_MS);
    // 不阻止进程退出
    this.watchTimer.unref?.();
  }

  stopWatching(): void {
    if (!this.watchTimer) return;
    clearInterval(this.watchTimer);
    this.watchTimer = undefined;
  }

  /** 已导入的外部会话 -> Tandem 会话 id。 */
  private importedMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const rec of this.host.listSessions()) {
      const from = rec.importedFrom;
      if (from) map.set(`${from.source}:${from.id}`, rec.id);
    }
    return map;
  }

  /** since（毫秒时间戳）存在时只返回该时间之后有更新的会话，供增量刷新。 */
  list(source?: ExternalSource, since?: number): ExternalSession[] {
    const memoKey = `${source ?? 'all'}:${since ?? ''}`;
    const memo = this.listMemo.get(memoKey);
    if (memo && Date.now() - memo.at < 1_500) return memo.result.map((item) => ({ ...item }));
    const sources: ExternalSource[] = source ? [source] : ['claude-code', 'codex'];
    const imported = this.importedMap();
    const seenFiles = new Set<string>();
    const result: ExternalSession[] = [];
    for (const src of sources) {
      for (const item of this.listFiles(src)) {
        seenFiles.add(item.file);
        const meta = this.metaOf(src, item.file, item.fallbackId);
        if (!meta) continue;
        // 同一会话可能出现在多个文件里，保留最新的
        const existing = result.findIndex((s) => s.source === meta.source && s.id === meta.id);
        const session: ExternalSession = {
          source: meta.source,
          id: meta.id,
          title: meta.title,
          cwd: meta.cwd,
          updatedAt: meta.updatedAt,
          messageCount: meta.messageCount,
          ...(imported.has(`${meta.source}:${meta.id}`)
            ? { importedSessionId: imported.get(`${meta.source}:${meta.id}`) }
            : {}),
        };
        if (existing >= 0) {
          if (result[existing]!.updatedAt < session.updatedAt) result[existing] = session;
        } else result.push(session);
      }
    }
    // 清理已删除文件的缓存
    for (const file of [...this.cache.keys()]) {
      if (!seenFiles.has(file) && !statSafe(file)) this.cache.delete(file);
    }
    const out = result
      .filter((s) => since === undefined || s.updatedAt > since)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (this.listMemo.size > 8) this.listMemo.clear();
    this.listMemo.set(memoKey, { at: Date.now(), result: out });
    return out.map((item) => ({ ...item }));
  }

  /** 找到源会话文件并完整解析。 */
  private find(source: ExternalSource, id: string, collect: boolean): Parsed | undefined {
    let best: Parsed | undefined;
    for (const item of this.listFiles(source)) {
      const meta = this.metaOf(source, item.file, item.fallbackId);
      if (!meta || meta.id !== id) continue;
      if (best && best.updatedAt >= meta.updatedAt) continue;
      const parsed = source === 'claude-code'
        ? parseClaudeFile(item.file, collect, item.fallbackId)
        : parseCodexFile(item.file, collect, item.fallbackId, this.codexTitles().get(item.fallbackId) ?? '');
      best = { ...parsed, ...meta, messages: parsed.messages };
    }
    return best;
  }

  /** 只读预览：转换为协议的 Session 结构，不落盘。 */
  preview(source: ExternalSource, id: string): Session | undefined {
    const parsed = this.find(source, id, true);
    if (!parsed) return undefined;
    return {
      id: parsed.id,
      title: parsed.title,
      cwd: parsed.cwd,
      profileId: '',
      model: '',
      permissionMode: 'default',
      status: 'idle',
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: parsed.messages,
      todos: [],
    };
  }

  /** 复制为 Tandem 会话：cwd 沿用，消息历史完整带入，之后可用任意模型继续。 */
  async importSession(
    source: ExternalSource,
    id: string,
    input: ExternalImportInput,
  ): Promise<SessionRecord | undefined> {
    const parsed = this.find(source, id, true);
    if (!parsed) return undefined;

    const profiles = this.host.profiles.list();
    const profileId =
      typeof input.profileId === 'string' && input.profileId.trim()
        ? input.profileId.trim()
        : profiles[0]?.id ?? '';
    if (!profileId) throw new Error('还没有账号，请先创建账号');
    const profile = this.host.profiles.get(profileId);
    if (!profile) throw new Error('账号不存在');
    const groupId =
      typeof input.groupId === 'string' && input.groupId.trim() ? input.groupId.trim() : undefined;
    if (groupId && !profile.groups?.some((g) => g.id === groupId)) throw new Error('分组不存在');

    const cwd = parsed.cwd && statSafe(parsed.cwd)?.isDirectory() ? parsed.cwd : os.homedir();
    const rec = await this.host.createSession({
      cwd,
      profileId,
      groupId,
      model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined,
      title:
        (parsed.title && !isInjectedTitle(parsed.title)
          ? parsed.title
          : titleFromMessages(parsed.messages, parsed.cwd, parsed.createdAt)) || '外部会话',
    });
    rec.messages = parsed.messages;
    rec.importedFrom = { source, id: parsed.id };
    this.host.store.markDirty(rec.id, false);
    this.host.broadcastSummary(rec);
    this.host.notifyExternalSessionsChanged();
    return rec;
  }
}
