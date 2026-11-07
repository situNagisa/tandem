// 会话全文索引（纯 JS 倒排，落盘 ~/.tandem/index/search.json）。
// 覆盖 Tandem 会话与外部 Claude Code / Codex 会话；中文按字符 + bigram，英文按词。
import path from 'node:path';
import type {
  Message,
  SearchFilters,
  SearchHit,
  SearchResponse,
  SearchSource,
  Session,
} from '@tandem/protocol';
import { readJson, writePrivateFile } from './config.js';
import type { Host } from './host.js';
import type { SessionRecord } from './types.js';

const INDEX_VERSION = 1;
const FILE_NAME = 'search.json';
const MAX_DOC_CHARS = 20_000;
const MAX_TOOL_CHARS = 4_000;
const MAX_RESULTS = 120;
const SAVE_DELAY_MS = 1_500;

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_RE = /[a-z0-9_]+/g;
const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    : null;

interface IndexedDoc {
  key: string;
  source: SearchSource;
  sessionId: string;
  messageId: string;
  messageIndex: number;
  role: 'user' | 'assistant';
  title: string;
  project: string;
  cwd: string;
  updatedAt: number;
  text: string;
}

interface StoredIndex {
  version: number;
  docs: IndexedDoc[];
  external?: Record<string, { mtimeMs: number; size: number }>;
}

interface ScoredDoc {
  doc: IndexedDoc;
  score: number;
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function projectNameOf(rec: SessionRecord): string {
  const candidate = rec.worktree?.path?.replace(/\\/g, '/').match(/\/worktrees\/([^/]+)\//)?.[1];
  if (candidate) return candidate;
  return rec.env?.repoName || path.basename(rec.cwd) || '未命名项目';
}

/** 工具入参里的字符串（命令、文件路径、模式等），跳过图片 base64。 */
function flattenToolInput(value: unknown, out: string[], budget: { left: number }, depth = 0): void {
  if (budget.left <= 0 || depth > 5) return;
  if (typeof value === 'string') {
    if (!value) return;
    const text = value.slice(0, Math.min(MAX_TOOL_CHARS, budget.left));
    if (text) {
      out.push(text);
      budget.left -= text.length;
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    for (const item of value) flattenToolInput(item, out, budget, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'data' || key === 'dataBase64' || key === 'source') continue;
    flattenToolInput(item, out, budget, depth + 1);
  }
}

function messageSearchText(message: Message): string {
  if (message.notice) return '';
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text.trim()) parts.push(block.text);
      continue;
    }
    if (block.type !== 'tool_use') continue;
    const values: string[] = [];
    flattenToolInput(block.input, values, { left: MAX_TOOL_CHARS });
    if (values.length) parts.push(`${block.name} ${values.join(' ')}`);
  }
  const text = parts.join('\n').trim();
  return text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text;
}

/** 建索引与查询共用的 token：英文词、CJK 单字与相邻 bigram、Intl.Segmenter 词。 */
export function indexTokens(text: string): string[] {
  const norm = normalizeText(text);
  const tokens = new Set<string>();
  for (const match of norm.matchAll(LATIN_RE)) {
    tokens.add(match[0]);
  }
  for (const run of norm.match(CJK_RUN_RE) ?? []) {
    const chars = [...run];
    for (let i = 0; i < chars.length; i += 1) {
      tokens.add(chars[i]!);
      if (i + 1 < chars.length) tokens.add(`${chars[i]}${chars[i + 1]}`);
    }
  }
  if (segmenter) {
    for (const part of segmenter.segment(norm)) {
      if (!part.isWordLike) continue;
      const token = part.segment.trim();
      if (token) tokens.add(token);
    }
  }
  return [...tokens].filter((token) => token.length > 0 && token.length <= 48);
}

function docTokens(doc: IndexedDoc): string[] {
  return indexTokens(`${doc.title}\n${doc.text}`);
}

function sameDoc(a: IndexedDoc, b: IndexedDoc): boolean {
  return (
    a.title === b.title &&
    a.project === b.project &&
    a.cwd === b.cwd &&
    a.updatedAt === b.updatedAt &&
    a.role === b.role &&
    a.messageIndex === b.messageIndex &&
    a.text === b.text
  );
}

function findRange(haystack: string, needle: string): { start: number; end: number } | null {
  const value = needle.trim();
  if (!value) return null;
  const index = normalizeText(haystack).indexOf(normalizeText(value));
  if (index < 0) return null;
  return { start: index, end: index + value.length };
}

function highlightRanges(text: string, needles: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>();
  for (const needle of needles) {
    const value = needle.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const hay = normalizeText(text);
    const q = normalizeText(value);
    let at = hay.indexOf(q);
    while (at >= 0) {
      ranges.push({ start: at, end: at + value.length });
      at = hay.indexOf(q, at + Math.max(1, q.length));
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && range.start <= prev.end) {
      prev.end = Math.max(prev.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.slice(0, 20);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildSnippet(
  doc: IndexedDoc,
  query: string,
  terms: string[],
): { snippet: string; highlights: Array<{ start: number; end: number }> } {
  const candidates = [query, ...terms.filter((term) => term.length >= 2), ...terms];
  for (const source of [doc.text, doc.title]) {
    if (!source) continue;
    for (const candidate of candidates) {
      const range = findRange(source, candidate);
      if (!range) continue;
      const from = Math.max(0, range.start - 50);
      const to = Math.min(source.length, range.end + 80);
      const snippet = collapse(source.slice(from, to));
      const highlights = highlightRanges(snippet, [candidate]);
      if (highlights.length === 0) {
        highlights.push({ start: 0, end: Math.min(snippet.length, candidate.length) });
      }
      return { snippet, highlights };
    }
  }
  const fallback = collapse(doc.text || doc.title).slice(0, 140);
  return { snippet: fallback, highlights: [] };
}

export class SearchIndex {
  private docs: Array<IndexedDoc | undefined> = [];
  private docIndex = new Map<string, number>();
  private postings = new Map<string, Set<number>>();
  private pendingSessions = new Set<string>();
  private pendingExternal = false;
  private externalState = new Map<string, { mtimeMs: number; size: number }>();
  private externalSyncing = false;
  private flushTimer?: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;
  private externalTimer?: NodeJS.Timeout;
  private tombstoneCount = 0;
  private ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(
    private readonly host: Host,
    private readonly home: string,
  ) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    void this.bootstrap();
  }

  private get file(): string {
    return path.join(this.home, 'index', FILE_NAME);
  }

  private async bootstrap(): Promise<void> {
    try {
      this.load();
      this.syncAllTandem();
      await this.syncExternal(true);
    } catch (err) {
      console.warn('[tandem] 搜索索引初始化失败，将按需重建:', (err as Error).message);
    } finally {
      this.resolveReady();
      this.schedulePersist();
    }
  }

  private load(): void {
    const stored = readJson<StoredIndex>(this.file);
    if (!stored || stored.version !== INDEX_VERSION || !Array.isArray(stored.docs)) return;
    for (const raw of stored.docs) {
      if (!raw || typeof raw !== 'object') continue;
      const doc = raw as IndexedDoc;
      if (
        typeof doc.key !== 'string' ||
        typeof doc.sessionId !== 'string' ||
        typeof doc.text !== 'string' ||
        (doc.source !== 'tandem' && doc.source !== 'claude-code' && doc.source !== 'codex')
      ) {
        continue;
      }
      this.addDoc({
        key: doc.key,
        source: doc.source,
        sessionId: doc.sessionId,
        messageId: typeof doc.messageId === 'string' ? doc.messageId : '',
        messageIndex: Number.isFinite(doc.messageIndex) ? doc.messageIndex : -1,
        role: doc.role === 'user' ? 'user' : 'assistant',
        title: typeof doc.title === 'string' ? doc.title : '',
        project: typeof doc.project === 'string' ? doc.project : '',
        cwd: typeof doc.cwd === 'string' ? doc.cwd : '',
        updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : 0,
        text: doc.text,
      });
    }
    if (stored.external) {
      for (const [key, value] of Object.entries(stored.external)) {
        if (!value || typeof value !== 'object') continue;
        if (typeof value.mtimeMs === 'number' && typeof value.size === 'number') {
          this.externalState.set(key, { mtimeMs: value.mtimeMs, size: value.size });
        }
      }
    }
  }

  private addDoc(doc: IndexedDoc): void {
    if (this.docIndex.has(doc.key)) return;
    const slot = this.docs.length;
    this.docs.push(doc);
    this.docIndex.set(doc.key, slot);
    for (const token of docTokens(doc)) {
      let slots = this.postings.get(token);
      if (!slots) {
        slots = new Set();
        this.postings.set(token, slots);
      }
      slots.add(slot);
    }
  }

  private removeSlot(slot: number): void {
    const doc = this.docs[slot];
    if (!doc) return;
    this.docs[slot] = undefined;
    this.tombstoneCount += 1;
    this.docIndex.delete(doc.key);
    for (const token of docTokens(doc)) {
      const slots = this.postings.get(token);
      if (!slots) continue;
      slots.delete(slot);
      if (slots.size === 0) this.postings.delete(token);
    }
  }

  private compactIfNeeded(): void {
    const active = this.docIndex.size;
    if (this.tombstoneCount < 500 && this.docs.length < active * 2) return;
    const docs: IndexedDoc[] = [];
    for (const doc of this.docs) if (doc) docs.push(doc);
    this.docs = [];
    this.docIndex.clear();
    this.postings.clear();
    this.tombstoneCount = 0;
    for (const doc of docs) this.addDoc(doc);
  }

  private docsForSession(rec: SessionRecord): IndexedDoc[] {
    const title = rec.title || '未命名会话';
    const project = projectNameOf(rec);
    const docs: IndexedDoc[] = [];
    rec.messages.forEach((message, messageIndex) => {
      const text = messageSearchText(message);
      if (!text) return;
      docs.push({
        key: `tandem\u0000${rec.id}\u0000${message.id}`,
        source: 'tandem',
        sessionId: rec.id,
        messageId: message.id,
        messageIndex,
        role: message.role,
        title,
        project,
        cwd: rec.cwd,
        updatedAt: rec.updatedAt,
        text,
      });
    });
    if (docs.length === 0) {
      docs.push({
        key: `tandem\u0000${rec.id}\u0000`,
        source: 'tandem',
        sessionId: rec.id,
        messageId: '',
        messageIndex: -1,
        role: 'assistant',
        title,
        project,
        cwd: rec.cwd,
        updatedAt: rec.updatedAt,
        text: '',
      });
    }
    return docs;
  }

  private docsForExternal(session: Session, source: SearchSource): IndexedDoc[] {
    const title = session.title || '未命名会话';
    const project = path.basename(session.cwd) || '未命名项目';
    const docs: IndexedDoc[] = [];
    session.messages.forEach((message, messageIndex) => {
      const text = messageSearchText(message);
      if (!text) return;
      docs.push({
        key: `${source}\u0000${session.id}\u0000${message.id}`,
        source,
        sessionId: session.id,
        messageId: message.id,
        messageIndex,
        role: message.role,
        title,
        project,
        cwd: session.cwd,
        updatedAt: session.updatedAt,
        text,
      });
    });
    if (docs.length === 0) {
      docs.push({
        key: `${source}\u0000${session.id}\u0000`,
        source,
        sessionId: session.id,
        messageId: '',
        messageIndex: -1,
        role: 'assistant',
        title,
        project,
        cwd: session.cwd,
        updatedAt: session.updatedAt,
        text: '',
      });
    }
    return docs;
  }

  private replaceSessionDocs(source: SearchSource, sessionId: string, next: IndexedDoc[]): void {
    const existing = new Map<string, { slot: number; doc: IndexedDoc }>();
    for (let slot = 0; slot < this.docs.length; slot += 1) {
      const doc = this.docs[slot];
      if (!doc || doc.source !== source || doc.sessionId !== sessionId) continue;
      existing.set(doc.key, { slot, doc });
    }
    const nextByKey = new Map(next.map((doc) => [doc.key, doc]));
    for (const [key, item] of existing) {
      const replacement = nextByKey.get(key);
      if (!replacement || !sameDoc(item.doc, replacement)) this.removeSlot(item.slot);
    }
    for (const doc of next) {
      if (this.docIndex.has(doc.key)) continue;
      this.addDoc(doc);
    }
    this.compactIfNeeded();
  }

  private removeSessionDocs(source: SearchSource, sessionId: string): void {
    this.replaceSessionDocs(source, sessionId, []);
  }

  private syncAllTandem(): void {
    const valid = new Set<string>();
    for (const rec of this.host.store.list()) {
      if (rec.evalRun) continue;
      valid.add(rec.id);
      this.syncSession(rec.id);
    }
    const stale = new Set<string>();
    for (const doc of this.docs) {
      if (doc?.source === 'tandem' && !valid.has(doc.sessionId)) stale.add(doc.sessionId);
    }
    for (const sessionId of stale) this.removeSessionDocs('tandem', sessionId);
  }

  private syncSession(id: string): void {
    const rec = this.host.store.get(id);
    if (!rec || rec.evalRun) {
      this.removeSessionDocs('tandem', id);
      return;
    }
    this.replaceSessionDocs('tandem', id, this.docsForSession(rec));
  }

  /** 会话写入时调用（store.markDirty/saveNow），150ms 合并后增量更新。 */
  touchSession(id: string): void {
    this.pendingSessions.add(id);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushPending();
      this.schedulePersist();
    }, 150);
  }

  touchExternal(): void {
    this.pendingExternal = true;
    if (this.externalTimer) return;
    this.externalTimer = setTimeout(() => {
      this.externalTimer = undefined;
      void this.syncExternal(false).then(() => this.schedulePersist());
    }, 600);
  }

  private flushPending(): void {
    const ids = [...this.pendingSessions];
    this.pendingSessions.clear();
    for (const id of ids) this.syncSession(id);
    if (this.pendingExternal) {
      this.pendingExternal = false;
      void this.syncExternal(false);
    }
  }

  private async syncExternal(force: boolean): Promise<void> {
    if (this.externalSyncing) return;
    this.externalSyncing = true;
    try {
      const seen = new Set<string>();
      const entries = this.host.external.indexEntries();
      for (const entry of entries) {
        const key = `${entry.source}:${entry.id}`;
        seen.add(key);
        const prev = this.externalState.get(key);
        if (!force && prev && prev.mtimeMs === entry.mtimeMs && prev.size === entry.size) continue;
        const parsed = this.host.external.preview(entry.source, entry.id);
        if (!parsed) {
          this.removeSessionDocs(entry.source, entry.id);
          this.externalState.delete(key);
          continue;
        }
        this.replaceSessionDocs(entry.source, entry.id, this.docsForExternal(parsed, entry.source));
        this.externalState.set(key, { mtimeMs: entry.mtimeMs, size: entry.size });
      }
      for (const key of [...this.externalState.keys()]) {
        if (seen.has(key)) continue;
        const [source, id] = key.split(':');
        if (source === 'claude-code' || source === 'codex') {
          this.removeSessionDocs(source, id);
        }
        this.externalState.delete(key);
      }
      this.compactIfNeeded();
    } catch (err) {
      console.warn('[tandem] 更新外部会话搜索索引失败:', (err as Error).message);
    } finally {
      this.externalSyncing = false;
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, SAVE_DELAY_MS);
  }

  private persist(): void {
    try {
      const docs: IndexedDoc[] = [];
      for (const doc of this.docs) if (doc) docs.push(doc);
      const data: StoredIndex = {
        version: INDEX_VERSION,
        docs,
        external: Object.fromEntries(this.externalState),
      };
      writePrivateFile(this.file, JSON.stringify(data));
    } catch (err) {
      console.warn('[tandem] 保存搜索索引失败:', (err as Error).message);
    }
  }

  /** 进程退出/测试清理：立即应用待处理会话并落盘。 */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.externalTimer) {
      clearTimeout(this.externalTimer);
      this.externalTimer = undefined;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.flushPending();
    this.persist();
  }

  async search(query: string, filters: SearchFilters = {}): Promise<SearchResponse> {
    const started = Date.now();
    await this.ready;
    this.flushPending();
    const q = query.trim();
    if (!q) return { q, tookMs: 0, total: 0, hits: [] };
    const terms = indexTokens(q);
    if (terms.length === 0) return { q, tookMs: 0, total: 0, hits: [] };
    const normalizedQuery = normalizeText(q);
    const compactQuery = normalizedQuery.replace(/\s+/g, '');
    const hasCjk = CJK_RE.test(q);
    // 单一中文短语做连续匹配；带空格的中英混合查询按 token AND（短语可能跨行）
    const strictPhrase = hasCjk && !/\s/.test(q);

    const sets: Set<number>[] = [];
    for (const term of terms) {
      const slots = this.postings.get(term);
      if (!slots || slots.size === 0) return { q, tookMs: Date.now() - started, total: 0, hits: [] };
      sets.push(slots);
    }
    sets.sort((a, b) => a.size - b.size);
    const candidates = sets[0]!;
    const scored: ScoredDoc[] = [];
    for (const slot of candidates) {
      const doc = this.docs[slot];
      if (!doc) continue;
      if (filters.source && filters.source !== 'all' && doc.source !== filters.source) continue;
      const hay = normalizeText(`${doc.title}\n${doc.text}`);
      const compactHay = hay.replace(/\s+/g, '');
      if (strictPhrase && !compactHay.includes(compactQuery)) continue;
      const titleHay = normalizeText(doc.title);
      let score = 0;
      if (titleHay.includes(normalizedQuery)) score += 40;
      const needle = hasCjk ? compactQuery : normalizedQuery.replace(/\s+/g, ' ');
      let at = hay.indexOf(needle);
      let occurrences = 0;
      while (at >= 0) {
        occurrences += 1;
        at = hay.indexOf(needle, at + Math.max(1, needle.length));
      }
      score += occurrences * 8;
      if (hasCjk) {
        let compactAt = compactHay.indexOf(compactQuery);
        let compactOccurrences = 0;
        while (compactAt >= 0) {
          compactOccurrences += 1;
          compactAt = compactHay.indexOf(compactQuery, compactAt + Math.max(1, compactQuery.length));
        }
        score += compactOccurrences * 6;
      }
      // 新会话略微优先，但不盖过命中次数。
      score += Math.min(10, Math.max(0, (doc.updatedAt || 0) / Date.now()) * 10);
      if (score <= 0) score = 1;
      scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt);
    const hits: SearchHit[] = [];
    for (const item of scored.slice(0, MAX_RESULTS)) {
      const { doc, score } = item;
      const { snippet, highlights } = buildSnippet(doc, q, terms);
      hits.push({
        source: doc.source,
        sessionId: doc.sessionId,
        messageId: doc.messageId,
        messageIndex: doc.messageIndex,
        title: doc.title,
        project: doc.project,
        role: doc.role,
        snippet,
        highlights,
        updatedAt: doc.updatedAt,
        score,
      });
    }
    return { q, tookMs: Date.now() - started, total: scored.length, hits };
  }
}
