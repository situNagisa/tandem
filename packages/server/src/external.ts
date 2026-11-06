// 外部会话（Claude Code / Codex）：只读扫描原软件的数据目录，转换为 Tandem 消息格式。
// 绝不写原软件文件；"导入"只是把内容复制成一个新的 Tandem 会话。
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
}

interface CacheEntry {
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
const CODEX_SESSIONS_DIR = path.join('.codex', 'sessions');

/** 明显是系统注入/命令回显的内容，不作为标题。 */
function isInjectedText(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  if (value.startsWith('<')) return true;
  if (/^caveat:/i.test(value)) return true;
  if (value.startsWith('[Request interrupted')) return true;
  if (value.startsWith('This session is being continued')) return true;
  return false;
}

function cleanTitle(text: string): string {
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, 60).join('').trim();
}

function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
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
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const lines = text.split(/\r?\n/);
  let id = fallbackId;
  let cwd = '';
  let title = '';
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
    if (o.type === 'summary' && !title && typeof o.summary === 'string') {
      title = cleanTitle(o.summary);
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
    const blocks = convertClaudeBlocks(msg.content);
    if (!blocks.length) continue;

    const toolOnly = blocks.every((b) => b.type === 'tool_result');
    // 首条真实用户文本作为标题（跳过命令/系统注入内容）
    if (role === 'user' && !title && !toolOnly) {
      const text = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text && !isInjectedText(text)) title = cleanTitle(text);
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
  return {
    source: 'claude-code',
    id,
    title: title || fallbackTitle(cwd),
    cwd,
    createdAt: createdAt || stat?.birthtimeMs || stat?.mtimeMs || 0,
    updatedAt: updatedAt || stat?.mtimeMs || 0,
    messageCount: count,
    file,
    messages: collect ? messages : [],
  };
}

/** Codex rollout：session_meta / response_item 等事件，按公开格式尽力解析。 */
function parseCodexFile(file: string, collect: boolean, fallbackId: string): Parsed {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const lines = text.split(/\r?\n/);
  const id = fallbackId;
  let cwd = '';
  let title = '';
  let createdAt = 0;
  let updatedAt = 0;
  let count = 0;
  const messages: Message[] = [];

  const push = (role: Message['role'], content: ContentBlock[], ts: number): void => {
    if (!content.length) return;
    count++;
    if (collect) messages.push(messageFrom(role, randomUUID(), content, ts));
  };

  const handleMessage = (role: string, content: unknown, ts: number): void => {
    const blocks: ContentBlock[] = [];
    if (typeof content === 'string') {
      if (content.trim()) blocks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
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
        }
      }
    }
    if (!blocks.length) return;
    // 跳过 Codex 注入的环境说明，避免污染标题与预览
    if (role === 'user' && blocks.every((b) => b.type === 'text' && isInjectedText(b.text))) return;
    const textOnly = blocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (role === 'user' && !title && textOnly && !isInjectedText(textOnly)) title = cleanTitle(textOnly);
    push(role === 'assistant' ? 'assistant' : 'user', blocks, ts);
  };

  const handleResponseItem = (payload: Record<string, unknown>, ts: number): void => {
    switch (payload.type) {
      case 'message':
        handleMessage(String(payload.role ?? ''), payload.content, ts);
        break;
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

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const ts = parseTime(o.timestamp);
    if (ts) {
      if (!createdAt) createdAt = ts;
      updatedAt = Math.max(updatedAt, ts);
    }
    const payload = o.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') continue;

    if (o.type === 'session_meta') {
      // 以文件名中的 uuid 作为会话 id，与列表路径保持一致
      if (typeof payload.cwd === 'string' && payload.cwd) cwd ||= payload.cwd;
      const metaTs = parseTime(payload.timestamp);
      if (metaTs && !createdAt) createdAt = metaTs;
      continue;
    }
    if (o.type === 'turn_context') {
      if (typeof payload.cwd === 'string' && payload.cwd) cwd ||= payload.cwd;
      continue;
    }
    if (o.type === 'response_item') {
      handleResponseItem(payload, ts);
      continue;
    }
    // 兼容更早的扁平格式
    if (o.type === 'message') handleMessage(String(o.role ?? ''), o.content, ts);
  }

  const stat = statSafe(file);
  return {
    source: 'codex',
    id,
    title: title || fallbackTitle(cwd),
    cwd,
    createdAt: createdAt || stat?.birthtimeMs || stat?.mtimeMs || 0,
    updatedAt: updatedAt || stat?.mtimeMs || 0,
    messageCount: count,
    file,
    messages: collect ? messages : [],
  };
}

function statSafe(file: string) {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

function fallbackTitle(cwd: string): string {
  const base = cwd ? path.basename(cwd) : '';
  return base ? `外部会话 · ${base}` : '外部会话';
}

/** 从 rollout-xxx-<uuid>.jsonl 等文件名里取兜底 id。 */
function idFromFile(file: string): string {
  const base = path.basename(file, '.jsonl');
  const uuid = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuid ? uuid[0] : base;
}

/** 扫描并缓存外部会话；按文件 mtime+size 增量更新。 */
export class ExternalSessionStore {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly host: Host) {}

  private listFiles(source: ExternalSource): Array<{ file: string; fallbackId: string }> {
    const root =
      source === 'claude-code'
        ? path.join(os.homedir(), PROJECTS_DIR)
        : path.join(os.homedir(), CODEX_SESSIONS_DIR);
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
        else if (name.endsWith('.jsonl') && name.startsWith('rollout-')) {
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
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.meta;

    let parsed: Parsed;
    try {
      parsed = source === 'claude-code'
        ? parseClaudeFile(file, false, fallbackId)
        : parseCodexFile(file, false, fallbackId);
    } catch (err) {
      console.warn(`[tandem] 无法解析外部会话 ${file}:`, (err as Error).message);
      this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta: null });
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
    this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
    return meta;
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

  list(source?: ExternalSource): ExternalSession[] {
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
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
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
        : parseCodexFile(item.file, collect, item.fallbackId);
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
      title: parsed.title || '外部会话',
    });
    rec.messages = parsed.messages;
    rec.importedFrom = { source, id: parsed.id };
    this.host.store.markDirty(rec.id, false);
    this.host.broadcastSummary(rec);
    return rec;
  }
}
