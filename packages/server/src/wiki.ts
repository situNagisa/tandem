// 项目 Wiki：为 git 仓库自动生成结构化说明文档，供人浏览、供 agent 用 WikiSearch/WikiRead 检索。
// 存储 ~/.tandem/wiki/<项目 hash>/（meta.json + pages/<id>.md）；页面自动段落与手写段落用注释标记分隔，
// 增量更新只重做「基准 commit 之后有文件改动」的模块页，手写段落原样保留。
//
// 生成在后台进行：建一个只读（Read/Glob/Grep）的隐藏会话，按模块目录分批阅读代码，模型返回整页 Markdown，
// 由 Host 落盘（因此只读会话本身没有写权限，也不会触发审批）。
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type {
  Message,
  PromptTemplateKey,
  ReasoningEffort,
  Schedule,
  WikiEstimate,
  WikiEstimateInput,
  WikiGenerateInput,
  WikiJob,
  WikiMeta,
  WikiPage,
  WikiPageKind,
  WikiPageMeta,
  WikiSearchResult,
} from '@tandem/protocol';
import { indexTokens } from './search.js';
import { projectInfoOf } from './memory.js';
import { effectiveProfile } from './config.js';
import { walkFiles } from './util/fs-walk.js';
import { toPosix } from './util/path.js';
import { costOfUsage, priceForModel } from './usage.js';
import { candidateMetas, routingSettingsOf } from './model-routing.js';
import { runTurn } from './agent/loop.js';
import type { SessionRecord } from './types.js';
import type { Host } from './host.js';

const STORE_VERSION = 1;
const MAX_PAGES = 14;
const MAX_PAGE_CHARS = 80_000;
const MAX_ESTIMATE_INPUT_TOKENS = 500_000;
const AUTO_START = '<!-- tandem-wiki:auto:start -->';
const AUTO_END = '<!-- tandem-wiki:auto:end -->';
const MANUAL_START = '<!-- tandem-wiki:manual:start -->';
const MANUAL_END = '<!-- tandem-wiki:manual:end -->';
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.nuxt',
  'target', 'vendor', 'Pods', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.cache',
  '.gradle', 'tmp', '.tmp', 'generated',
]);
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.kts',
  '.cs', '.c', '.h', '.cc', '.cpp', '.hpp', '.rb', '.php', '.swift', '.vue', '.svelte', '.lua',
  '.sh', '.ps1', '.sql', '.proto', '.graphql', '.toml', '.json', '.yaml', '.yml', '.md',
]);
const GROUP_ROOTS = new Set(['packages', 'apps', 'services', 'modules', 'crates']);

type StoredPage = WikiPageMeta;
interface StoredMeta {
  version: number;
  project: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  commit?: string;
  model?: string;
  profileId?: string;
  pages: StoredPage[];
}

export interface ScannedFile {
  /** 仓库相对 posix 路径。 */
  path: string;
  bytes: number;
}

export interface WikiModule {
  /** 模块根（仓库相对 posix）。 */
  root: string;
  title: string;
  files: ScannedFile[];
}

export interface WikiPlanPage {
  id: string;
  title: string;
  kind: WikiPageKind;
  module?: string;
  files: string[];
}

interface ActiveJob {
  job: WikiJob;
  abort: AbortController;
  sessionId?: string;
  effort?: ReasoningEffort;
}

function safePageId(id: string): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id) && !id.includes('..');
}

function hashProject(project: string): string {
  return createHash('sha1').update(project).digest('hex').slice(0, 16);
}

function runGit(cwd: string, args: string[]): { code: number; out: string } {
  try {
    const result = spawnSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: result.status ?? 1, out: String(result.stdout ?? '') };
  } catch {
    return { code: 1, out: '' };
  }
}

export function wikiCommitOf(project: string): string | undefined {
  const result = runGit(project, ['rev-parse', '--short', 'HEAD']);
  const hash = result.out.trim();
  return result.code === 0 && hash ? hash : undefined;
}

/** 基准 commit 之后的改动文件：已提交 diff + 工作区改动 + 未跟踪文件。 */
export function wikiChangedFiles(project: string, base?: string): string[] {
  const files = new Set<string>();
  if (base) {
    const diff = runGit(project, ['diff', '--name-only', `${base}..HEAD`, '--']);
    if (diff.code === 0) for (const line of diff.out.split(/\r?\n/)) if (line.trim()) files.add(toPosix(line.trim()));
  }
  const work = runGit(project, ['diff', '--name-only', 'HEAD', '--']);
  if (work.code === 0) for (const line of work.out.split(/\r?\n/)) if (line.trim()) files.add(toPosix(line.trim()));
  const untracked = runGit(project, ['ls-files', '--others', '--exclude-standard']);
  if (untracked.code === 0) {
    for (const line of untracked.out.split(/\r?\n/)) if (line.trim()) files.add(toPosix(line.trim()));
  }
  return [...files];
}

function isCodeFile(rel: string): boolean {
  const lower = rel.toLowerCase();
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(lower)) return false;
  if (/\.(min\.js|map)$/.test(lower)) return false;
  return CODE_EXT.has(path.extname(lower));
}

function segmentOf(rel: string, index: number): string {
  return rel.split('/')[index] ?? '';
}

/** 模块划分：monorepo 取 packages/<包>/src/<子目录>，普通仓库取 src/<子目录>。 */
export function moduleOf(rel: string): string {
  const parts = rel.split('/');
  if (parts.length <= 1) return '根目录';
  const first = parts[0]!;
  if (GROUP_ROOTS.has(first)) {
    if (parts.length >= 4 && (parts[2] === 'src' || parts[2] === 'lib' || parts[2] === 'app')) {
      // packages/<包>/src/<子目录>/... 取到子目录；src 下的单文件归到 src 本身。
      return parts.length >= 5 ? parts.slice(0, 4).join('/') : parts.slice(0, 3).join('/');
    }
    return parts.slice(0, 2).join('/');
  }
  if (first === 'src') {
    if (parts.length >= 3) return parts.slice(0, 2).join('/');
    return 'src';
  }
  if (['docs', 'scripts', 'e2e', 'test', 'tests', 'examples', 'benchmarks', 'packages'].includes(first)) {
    return first;
  }
  return first;
}

function moduleSlug(root: string): string {
  const ascii = root
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return ascii || `m-${createHash('sha1').update(root).digest('hex').slice(0, 10)}`;
}

export function scanProject(project: string): { files: ScannedFile[]; modules: WikiModule[] } {
  const all = walkFiles(project, { ignoreDirs: IGNORE_DIRS, maxEntries: 20_000, maxDepth: 18 });
  const files: ScannedFile[] = [];
  for (const abs of all) {
    const rel = toPosix(path.relative(project, abs));
    if (!rel || rel.startsWith('..')) continue;
    if (rel.includes('/.tandem/') || rel.startsWith('.tandem/')) continue;
    if (!isCodeFile(rel)) continue;
    let bytes = 0;
    try {
      bytes = statSync(abs).size;
    } catch {
      continue;
    }
    if (bytes > 400 * 1024) continue;
    files.push({ path: rel, bytes });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const groups = new Map<string, ScannedFile[]>();
  for (const file of files) {
    const root = moduleOf(file.path);
    const list = groups.get(root) ?? [];
    list.push(file);
    groups.set(root, list);
  }
  // 只有 package.json/tsconfig 这类配置的目录并入同名的 src 模块，避免生成空壳页。
  const configOnly = /(^|\/)(package\.json|tsconfig[^/]*\.json|vitest[^/]*\.(ts|js)|vite\.config\.(ts|js)|eslint[^/]*|prettier[^/]*|\.gitignore|README[^/]*)$/i;
  for (const [root, list] of [...groups.entries()]) {
    if (root === '根目录') continue;
    if (!list.every((file) => configOnly.test(file.path))) continue;
    const child = `${root}/src`;
    if (groups.has(child)) {
      groups.set(child, [...groups.get(child)!, ...list]);
      groups.delete(root);
    }
  }
  let modules: WikiModule[] = [...groups.entries()]
    .filter(([root]) => root !== '根目录')
    .map(([root, list]) => ({
      root,
      title: root,
      files: list.sort((a, b) => b.bytes - a.bytes),
    }))
    .sort((a, b) => b.files.length - a.files.length);
  if (modules.length > MAX_PAGES - 2) {
    const head = modules.slice(0, MAX_PAGES - 3);
    const rest = modules.slice(MAX_PAGES - 3);
    const merged: WikiModule = {
      root: '其它',
      title: '其它',
      files: rest.flatMap((module) => module.files).sort((a, b) => a.path.localeCompare(b.path)),
    };
    modules = [...head, merged];
  }
  return { files, modules };
}

function treeOf(project: string, module?: string): string {
  const base = module && module !== '其它' && module !== '根目录' ? path.join(project, module) : project;
  const entries: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 2 || entries.length >= 60) return;
    let items: Array<{ name: string; dir: boolean }> = [];
    try {
      items = readdirSync(dir, { withFileTypes: true })
        .filter((item) => !IGNORE_DIRS.has(item.name) && !item.name.startsWith('.'))
        .map((item) => ({ name: item.name, dir: item.isDirectory() }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= 60) return;
      entries.push(`${prefix}${item.name}${item.dir ? '/' : ''}`);
      if (item.dir) walk(path.join(dir, item.name), `${prefix}  `, depth + 1);
    }
  };
  walk(base, '', 0);
  return entries.join('\n') || '（空目录）';
}

function fileListOf(files: ScannedFile[]): string {
  const shown = files.slice(0, 120).map((file) => `- ${file.path}`);
  if (files.length > shown.length) shown.push(`- …（另有 ${files.length - shown.length} 个文件）`);
  return shown.join('\n') || '（无源码文件）';
}

function parsePage(text: string): { auto: string; manual: string } {
  const autoMatch = new RegExp(`${AUTO_START}\\s*([\\s\\S]*?)\\s*${AUTO_END}`).exec(text);
  if (autoMatch) {
    const manualMatch = new RegExp(`${MANUAL_START}\\s*([\\s\\S]*?)\\s*${MANUAL_END}`).exec(text);
    return {
      auto: autoMatch[1]?.trim() ?? '',
      manual: manualMatch ? (manualMatch[1]?.trim() ?? '') : text.replace(autoMatch[0], '').trim(),
    };
  }
  // 老页面/手写文件：没有自动标记时全部视为手写，更新时保留。
  return { auto: '', manual: text.trim() };
}

export function composePage(auto: string, manual: string): string {
  return [
    AUTO_START,
    auto.trim(),
    AUTO_END,
    '',
    MANUAL_START,
    manual.trim(),
    MANUAL_END,
    '',
  ].join('\n');
}

/** 模型常见外面包了 ```markdown；剥掉围栏与多余空行。 */
export function cleanPageMarkdown(text: string): string {
  let out = String(text ?? '').trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(out);
  if (fence) out = fence[1]!.trim();
  if (!out.startsWith('#')) out = `# Wiki 页面\n\n${out}`;
  return out.length > MAX_PAGE_CHARS ? `${out.slice(0, MAX_PAGE_CHARS)}\n…[已截断]` : out;
}

function normalizeForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function snippetOf(text: string, terms: string[]): string {
  const hay = normalizeForSearch(text);
  let at = -1;
  let len = 0;
  for (const term of terms) {
    const found = hay.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) {
      at = found;
      len = term.length;
    }
  }
  if (at < 0) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
  }
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + len + 100);
  const fragment = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${fragment}${end < text.length ? '…' : ''}`;
}

const KIND_LABEL: Record<WikiPageKind, string> = {
  overview: '概览',
  module: '模块',
  glossary: '术语',
};

export class WikiStore {
  readonly dir: string;

  constructor(private readonly home: string) {
    this.dir = path.join(home, 'wiki');
  }

  dirOf(project: string): string {
    return path.join(this.dir, hashProject(project));
  }

  private metaPath(project: string): string {
    return path.join(this.dirOf(project), 'meta.json');
  }

  private pagePath(project: string, id: string): string {
    return path.join(this.dirOf(project), 'pages', `${id}.md`);
  }

  readMeta(project: string): StoredMeta | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.metaPath(project), 'utf8')) as StoredMeta;
      if (!raw || raw.version !== STORE_VERSION || !Array.isArray(raw.pages)) return undefined;
      return raw;
    } catch {
      return undefined;
    }
  }

  writeMeta(project: string, meta: StoredMeta): void {
    const dir = this.dirOf(project);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.metaPath(project)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.metaPath(project));
  }

  readPageText(project: string, id: string): string | undefined {
    if (!safePageId(id)) return undefined;
    try {
      return readFileSync(this.pagePath(project, id), 'utf8');
    } catch {
      return undefined;
    }
  }

  writePageText(project: string, id: string, text: string): void {
    if (!safePageId(id)) throw new Error('无效的页面 id');
    const dir = path.join(this.dirOf(project), 'pages');
    mkdirSync(dir, { recursive: true });
    const file = this.pagePath(project, id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  }

  listProjects(): Array<{ project: string; name: string }> {
    const out: Array<{ project: string; name: string }> = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      try {
        const raw = JSON.parse(readFileSync(path.join(this.dir, entry, 'meta.json'), 'utf8')) as StoredMeta;
        if (raw?.project) out.push({ project: raw.project, name: raw.name });
      } catch {
        // 忽略损坏目录
      }
    }
    return out;
  }
}

export class WikiManager {
  readonly store: WikiStore;
  private readonly jobs = new Map<string, ActiveJob>();
  private readonly jobHistory: WikiJob[] = [];

  constructor(
    private readonly home: string,
    private readonly host: Host,
  ) {
    this.store = new WikiStore(home);
  }

  private projectOf(cwd: string): { project: string; name: string } {
    const info = projectInfoOf(cwd);
    return { project: path.resolve(info.project), name: info.name };
  }

  private metaOf(project: string): WikiMeta {
    const stored = this.store.readMeta(project);
    const changes = stored?.commit ? wikiChangedFiles(project, stored.commit) : [];
    const wikiFiles = new Set((stored?.pages ?? []).flatMap((page) => page.files));
    return {
      project,
      name: stored?.name ?? path.basename(project) ?? project,
      hash: hashProject(project),
      exists: !!stored && (stored.pages?.length ?? 0) > 0,
      createdAt: stored?.createdAt ?? 0,
      updatedAt: stored?.updatedAt ?? 0,
      ...(stored?.commit ? { commit: stored.commit } : {}),
      ...(stored?.model ? { model: stored.model } : {}),
      pages: (stored?.pages ?? []).map((page) => ({ ...page })),
      changedFiles: changes.length,
      changedInWiki: changes.filter((file) => wikiFiles.has(file)).length,
      running: [...this.jobs.values()].some(
        (entry) => entry.job.project === project && entry.job.status === 'running',
      ),
    };
  }

  meta(cwd: string): WikiMeta {
    return this.metaOf(this.projectOf(cwd).project);
  }

  page(cwd: string, id: string): WikiPage {
    const { project } = this.projectOf(cwd);
    const stored = this.store.readMeta(project);
    const meta = stored?.pages.find((page) => page.id === id);
    if (!stored || !meta) throw new Error('Wiki 页面不存在');
    const text = this.store.readPageText(project, id);
    if (text === undefined) throw new Error('Wiki 页面文件不存在');
    const parsed = parsePage(text);
    return { ...meta, text, auto: parsed.auto, manual: parsed.manual };
  }

  saveManual(cwd: string, id: string, manual: string): WikiPage {
    const { project } = this.projectOf(cwd);
    const stored = this.store.readMeta(project);
    const meta = stored?.pages.find((page) => page.id === id);
    if (!stored || !meta) throw new Error('Wiki 页面不存在');
    const text = this.store.readPageText(project, id) ?? composePage('', '');
    const parsed = parsePage(text);
    const manualText = String(manual ?? '');
    if (manualText.length > 200_000) throw new Error('手写段落过长（上限 20 万字）');
    const next = composePage(parsed.auto, manualText);
    this.store.writePageText(project, id, next);
    stored.updatedAt = Date.now();
    meta.updatedAt = stored.updatedAt;
    meta.chars = parsed.auto.length + parsed.manual.length;
    this.store.writeMeta(project, stored);
    this.broadcastUpdated(project);
    return this.page(project, id);
  }

  search(cwd: string, query: string, limit = 8): WikiSearchResult {
    const { project } = this.projectOf(cwd);
    const stored = this.store.readMeta(project);
    const q = String(query ?? '').trim();
    if (!stored || !q) return { q, total: 0, hits: [] };
    const terms = indexTokens(q);
    if (terms.length === 0) return { q, total: 0, hits: [] };
    const normalized = normalizeForSearch(q).replace(/\s+/g, '');
    const hits: Array<{ pageId: string; title: string; kind: WikiPageKind; snippet: string; score: number }> = [];
    for (const page of stored.pages) {
      const raw = this.store.readPageText(project, page.id);
      if (raw === undefined) continue;
      const parsed = parsePage(raw);
      const text = [parsed.auto, parsed.manual].filter(Boolean).join('\n');
      const hay = normalizeForSearch(`${page.title}\n${text}`);
      if (!terms.every((term) => hay.includes(term))) continue;
      const compact = hay.replace(/\s+/g, '');
      let score = 0;
      if (normalizeForSearch(page.title).includes(q.toLowerCase())) score += 40;
      if (compact.includes(normalized)) score += 20;
      let occurrences = 0;
      for (const term of terms) {
        let at = hay.indexOf(term);
        while (at >= 0) {
          occurrences += 1;
          at = hay.indexOf(term, at + Math.max(1, term.length));
          if (occurrences > 200) break;
        }
      }
      score += occurrences;
      if (score <= 0) continue;
      hits.push({
        pageId: page.id,
        title: page.title,
        kind: page.kind,
        snippet: snippetOf(text, terms),
        score,
      });
    }
    hits.sort((a, b) => b.score - a.score || b.title.localeCompare(a.title));
    return {
      q,
      total: hits.length,
      hits: hits.slice(0, Math.max(1, Math.min(30, limit))).map(({ score: _score, ...hit }) => hit),
    };
  }

  /** 系统提示里的「本项目有 Wiki」一行；没有 Wiki 时返回空串，不占上下文。 */
  promptSection(cwd: string): string {
    const meta = this.meta(cwd);
    if (!meta.exists || meta.pages.length === 0) return '';
    const names = meta.pages.slice(0, 8).map((page) => page.title);
    const more = meta.pages.length > names.length ? ` 等` : '';
    return this.host.promptTemplates.render(
      'wikiHint',
      {
        count: String(meta.pages.length),
        pages: `${names.join('、')}${more}`,
      },
      cwd,
    );
  }

  estimate(input: WikiEstimateInput): WikiEstimate {
    const { project } = this.projectOf(input.project);
    const resolved = this.resolveModel(input.profileId, input.groupId, input.model, 'fast');
    const scanned = scanProject(project);
    const mode = input.mode === 'update' ? 'update' : 'generate';
    const stored = this.store.readMeta(project);
    const changed = stored?.commit ? wikiChangedFiles(project, stored.commit) : [];
    const changedSet = new Set(changed);
    const existing = new Set((stored?.pages ?? []).map((page) => page.id));
    let pages = 0;
    if (mode === 'update' && stored) {
      for (const module of scanned.modules) {
        const id = `m-${moduleSlug(module.root)}`;
        if (!existing.has(id) || module.files.some((file) => changedSet.has(file.path))) pages += 1;
      }
      if (changed.some((file) => /(^|\/)(README|package\.json|AGENTS\.md|CLAUDE\.md)/i.test(file) || file.startsWith('docs/'))) pages += 1;
      if (!existing.has('glossary') && changed.length >= 20) pages += 1;
    } else {
      pages = scanned.modules.length + 2;
    }
    const bytes = scanned.files.reduce((sum, file) => sum + file.bytes, 0);
    const inputTokens = Math.min(
      MAX_ESTIMATE_INPUT_TOKENS,
      Math.round(pages * 6_000 + Math.min(bytes / 4, 260_000) * (mode === 'update' ? 0.25 : 0.6)),
    );
    const outputTokens = Math.max(800, pages * 1_400);
    const profile = resolved.profileId ? this.host.profileFor(resolved.profileId, resolved.groupId) : undefined;
    const price = priceForModel(profile, resolved.model);
    const cost = price
      ? Math.round(((inputTokens * price.input + outputTokens * price.output) / 1_000_000) * 1e4) / 1e4
      : undefined;
    return {
      project,
      mode,
      ...(stored?.commit ? { commit: stored.commit } : {}),
      files: scanned.files.length,
      modules: scanned.modules.length,
      pages,
      inputTokens,
      outputTokens,
      ...(cost !== undefined ? { costUsd: cost } : {}),
      priceKnown: !!price,
      model: resolved.model,
      ...(resolved.profileId ? { profileId: resolved.profileId } : {}),
      ...(resolved.groupId ? { groupId: resolved.groupId } : {}),
      autoRoute: resolved.autoRoute,
      changedFiles: changed.length,
    };
  }

  /** 选择生成模型：显式 model > 自动路由快速档 > 账号默认模型。 */
  private resolveModel(
    profileId?: string,
    groupId?: string,
    model?: string,
    tier: 'fast' | 'balanced' = 'fast',
  ): { profileId?: string; groupId?: string; model: string; autoRoute: boolean } {
    const requested = String(model ?? '').trim();
    const autoRoute = !requested || requested === 'auto';
    const profiles = this.host.profiles.list().filter((profile) => profile.models.length || profile.defaultModel);
    let profile = profileId ? this.host.profiles.get(profileId) : profiles[0];
    if (profileId && !profile) throw new Error('账号不存在');
    if (!profile) throw new Error('请先在设置中配置模型账号');
    const group = groupId && profile.groups?.some((item) => item.id === groupId) ? groupId : undefined;

    if (!requested || requested === 'auto') {
      const settings = routingSettingsOf(this.host);
      if (settings) {
        const metas = candidateMetas(this.host, settings)
          .filter((meta) => meta.available && !meta.budgetBlocked)
          .filter((meta) => {
            if (!profileId) return true;
            return meta.candidate.profileId === profileId && (!group || meta.candidate.groupId === group);
          });
        const candidate = metas.find((meta) => meta.candidate.tier === tier) ?? metas[0];
        if (candidate) {
          return {
            profileId: candidate.candidate.profileId,
            ...(candidate.candidate.groupId ? { groupId: candidate.candidate.groupId } : {}),
            model: candidate.candidate.model,
            autoRoute: true,
          };
        }
      }
      const effective = effectiveProfile(profile, group);
      const fallbackModel = effective.defaultModel || effective.models[0] || '';
      if (!fallbackModel) throw new Error('该账号没有可用模型');
      return { profileId: profile.id, ...(group ? { groupId: group } : {}), model: fallbackModel, autoRoute: true };
    }
    const effectiveModel = requested;
    const models = profile.models.length ? profile.models : [profile.defaultModel].filter(Boolean);
    if (models.length && !models.includes(effectiveModel)) {
      // 允许分组模型与自定义模型名；只在明显不匹配时仍采用请求值（与普通会话一致）。
    }
    return { profileId: profile.id, ...(group ? { groupId: group } : {}), model: effectiveModel, autoRoute: false };
  }

  /** 生成计划：首次=概览+全部模块+术语表；更新=有改动的模块页（+新增模块/概览）。 */
  private plan(project: string, mode: 'generate' | 'update', stored: StoredMeta | undefined, changed: string[]): WikiPlanPage[] {
    const scanned = scanProject(project);
    const changedSet = new Set(changed);
    const existing = new Map((stored?.pages ?? []).map((page) => [page.id, page]));
    const pages: WikiPlanPage[] = [];
    const overviewFiles = scanned.files.filter((file) => !file.path.includes('/')).map((file) => file.path);
    const changedOverview =
      !existing.has('overview') ||
      mode === 'generate' ||
      changed.some((file) => !file.includes('/') || file.startsWith('docs/') || /(^|\/)(README|AGENTS|CLAUDE|package\.json)/i.test(file));
    if (changedOverview) {
      pages.push({
        id: 'overview',
        title: '项目概览',
        kind: 'overview',
        files: [...new Set([...overviewFiles, ...changed.slice(0, 80)])],
      });
    }
    for (const module of scanned.modules) {
      const id = `m-${moduleSlug(module.root)}`;
      const files = module.files.map((file) => file.path);
      const touched = module.files.some((file) => changedSet.has(file.path));
      if (mode === 'generate' || !existing.has(id) || touched) {
        pages.push({
          id,
          title: module.root === '根目录' || module.root === '其它' ? module.root : module.root,
          kind: 'module',
          module: module.root,
          files,
        });
      }
    }
    const glossaryTouched =
      !existing.has('glossary') || mode === 'generate' || changed.filter((file) => file.endsWith('.md')).length >= 3;
    if (glossaryTouched) {
      pages.push({
        id: 'glossary',
        title: '术语表',
        kind: 'glossary',
        files: scanned.files.slice(0, 40).map((file) => file.path),
      });
    }
    const seen = new Set<string>();
    return pages.filter((page) => (seen.has(page.id) ? false : (seen.add(page.id), true))).slice(0, MAX_PAGES);
  }

  start(input: WikiGenerateInput): WikiJob {
    const { project, name } = this.projectOf(input.project);
    const running = [...this.jobs.values()].find(
      (entry) => entry.job.project === project && entry.job.status === 'running',
    );
    if (running) throw new Error('该项目已有 Wiki 生成任务在运行');
    const mode = input.mode === 'update' ? 'update' : 'generate';
    const stored = this.store.readMeta(project);
    const changed = stored?.commit ? wikiChangedFiles(project, stored.commit) : [];
    const plan = this.plan(project, mode, stored, changed);
    const resolved = this.resolveModel(input.profileId, input.groupId, input.model, 'fast');
    const now = Date.now();
    const job: WikiJob = {
      id: randomUUID(),
      project,
      mode,
      status: 'running',
      startedAt: now,
      total: plan.length,
      done: 0,
      pageIds: plan.map((page) => page.id),
      ...(resolved.profileId ? { profileId: resolved.profileId } : {}),
      ...(resolved.groupId ? { groupId: resolved.groupId } : {}),
      model: resolved.model,
    };
    const active: ActiveJob = { job, abort: new AbortController(), ...(input.effort ? { effort: input.effort } : {}) };
    this.jobs.set(job.id, active);
    this.jobHistory.unshift({ ...job });
    if (this.jobHistory.length > 20) this.jobHistory.length = 20;
    this.broadcastJob(job);
    if (plan.length === 0) {
      // 增量更新时没有任何模块改动：不启动模型请求，直接完成。
      job.status = 'done';
      job.endedAt = Date.now();
      this.jobs.delete(job.id);
      this.broadcastJob(job);
      return { ...job };
    }
    void this.execute(active, { project, name, mode, plan, stored, head: wikiCommitOf(project), maxCostUsd: input.maxCostUsd, effort: input.effort }).catch((err) => {
      this.fail(active, (err as Error).message);
    });
    return { ...job };
  }

  private async execute(
    active: ActiveJob,
    ctx: {
      project: string;
      name: string;
      mode: 'generate' | 'update';
      plan: WikiPlanPage[];
      stored: StoredMeta | undefined;
      head?: string;
      maxCostUsd?: number;
      effort?: ReasoningEffort;
    },
  ): Promise<void> {
    const { job } = active;
    const rec = this.createReadOnlySession(active, ctx.project, ctx.name);
    if (active.effort) rec.effort = active.effort;
    active.sessionId = rec.id;
    job.sessionId = rec.id;
    this.broadcastJob(job);
    const scanned = scanProject(ctx.project);
    const moduleByRoot = new Map(scanned.modules.map((module) => [module.root, module]));
    const startingInput = rec.usage.inputTokens;
    const startingOutput = rec.usage.outputTokens;
    let meta = ctx.stored ?? {
      version: STORE_VERSION,
      project: ctx.project,
      name: ctx.name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pages: [],
    };
    meta.project = ctx.project;
    meta.name = ctx.name;
    meta.model = job.model ?? meta.model;

    try {
      for (const page of ctx.plan) {
        if (active.abort.signal.aborted) throw new Error('已取消');
        job.current = page.title;
        job.status = 'running';
        this.broadcastJob(job);
        const module = page.module ? moduleByRoot.get(page.module) : undefined;
        const files = module?.files ?? [];
        const existingPage = meta.pages.find((item) => item.id === page.id);
        const existingText = existingPage ? this.store.readPageText(ctx.project, page.id) : undefined;
        const existingAuto = existingText ? parsePage(existingText).auto : '';
        const changedFiles = ctx.stored?.commit ? wikiChangedFiles(ctx.project, ctx.stored.commit) : [];
        const promptKey: PromptTemplateKey = ctx.mode === 'update' ? 'wikiUpdate' : 'wikiGenerate';
        const basePrompt = this.host.promptTemplates.render(
          promptKey,
          {
            project: ctx.project,
            module: page.module ?? (page.kind === 'overview' ? '项目根目录/整体架构' : '全仓库'),
            kind: KIND_LABEL[page.kind],
            files: fileListOf(files.length ? files : page.files.map((file) => ({ path: file, bytes: 0 }))),
            tree: treeOf(ctx.project, page.module),
            existing: existingAuto.slice(0, 8_000) || '（无）',
            changed: changedFiles.filter((file) => page.files.includes(file)).slice(0, 80).join('\n') || '（无）',
          },
          ctx.project,
        );
        const extra =
          page.kind === 'overview'
            ? '\n\n概览页额外要求：先用一句话说明这个项目做什么；再根据 README / package.json / 构建脚本写清如何安装、运行、测试；最后给出顶层目录地图与各主要模块一句话职责。'
            : page.kind === 'glossary'
              ? '\n\n术语表页面额外要求：列出项目特有的术语、缩写与核心概念，每条一句解释并附关键文件路径；不要罗列通用编程词汇。'
              : '';
        const prompt = `${basePrompt}${extra}`;
        rec.messages.length = 0;
        const message: Message = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          createdAt: Date.now(),
        };
        rec.messages.push(message);
        this.host.hub.broadcastSession(rec.id, { type: 'message_start', sessionId: rec.id, message });
        this.host.hub.broadcastSession(rec.id, { type: 'message_end', sessionId: rec.id, message });
        const result = await runTurn(this.host, rec, { allowTask: false });
        if (active.abort.signal.aborted) throw new Error('已取消');
        if (result.reason === 'error') throw new Error(result.error ?? '模型请求失败');
        if (result.reason === 'interrupted') throw new Error('生成被中断');
        const auto = cleanPageMarkdown(result.lastText ?? '');
        if (!auto.trim()) throw new Error(`页面「${page.title}」没有返回内容`);
        const manual = existingText ? parsePage(existingText).manual : '';
        this.store.writePageText(ctx.project, page.id, composePage(auto, manual));
        const updatedAt = Date.now();
        const metaPage: StoredPage = {
          id: page.id,
          title: page.title,
          kind: page.kind,
          ...(page.module ? { module: page.module } : {}),
          files: page.files,
          ...(ctx.head ? { commit: ctx.head } : {}),
          updatedAt,
          chars: auto.length + manual.length,
        };
        meta.pages = [...meta.pages.filter((item) => item.id !== page.id), metaPage];
        meta.updatedAt = updatedAt;
        this.store.writeMeta(ctx.project, meta);
        job.done += 1;
        job.inputTokens = Math.max(0, rec.usage.inputTokens - startingInput);
        job.outputTokens = Math.max(0, rec.usage.outputTokens - startingOutput);
        job.costUsd = this.costOf(rec, job);
        this.broadcastJob(job);
        this.broadcastUpdated(ctx.project);
        if (ctx.maxCostUsd && ctx.maxCostUsd > 0 && (job.costUsd ?? 0) >= ctx.maxCostUsd) {
          job.leftover = ctx.plan.slice(job.done).map((item) => item.id);
          break;
        }
      }
      if (!job.leftover?.length) {
        // 全部计划页面成功后才推进基准 commit；半途失败/超预算时下次仍能从旧基准补齐。
        if (ctx.head) meta.commit = ctx.head;
        meta.updatedAt = Date.now();
        this.store.writeMeta(ctx.project, meta);
      }
      job.status = job.leftover?.length ? 'error' : 'done';
      if (job.leftover?.length) job.error = `已达到预算上限（$${ctx.maxCostUsd}），剩余 ${job.leftover.length} 页未生成`;
    } finally {
      job.endedAt = Date.now();
      job.inputTokens = rec.usage.inputTokens;
      job.outputTokens = rec.usage.outputTokens;
      job.costUsd = this.costOf(rec, job);
      delete job.current;
      this.jobs.delete(job.id);
      this.host.store.delete(rec.id);
      this.broadcastJob(job);
      this.broadcastUpdated(ctx.project);
    }
  }

  private createReadOnlySession(active: ActiveJob, project: string, name: string): SessionRecord {
    const { job } = active;
    const now = Date.now();
    const session: SessionRecord = {
      id: randomUUID(),
      title: `Wiki：${name}`,
      cwd: project,
      profileId: job.profileId ?? '',
      ...(job.groupId ? { groupId: job.groupId } : {}),
      model: job.model ?? '',
      // 自动路由的 Wiki 生成默认走快速档（depth=1 让路由把本会话视为子代理）
      ...(job.model ? {} : { autoRoute: true }),
      permissionMode: 'default',
      delegation: 'none',
      depth: 1,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [],
      todos: [],
      allowedTools: [],
      toolWhitelist: ['Read', 'Glob', 'Grep'],
      systemPromptExtra:
        '你是项目 Wiki 生成子会话，只能读取代码（Read/Glob/Grep），不要修改文件或运行命令。' +
        '阅读少量关键文件后，按用户要求输出一页完整 Markdown。',
      wikiRun: { project, jobId: job.id },
    };
    this.host.store.add(session);
    return session;
  }

  private costOf(rec: SessionRecord, job: WikiJob): number {
    const profile = job.profileId ? this.host.profileFor(job.profileId, job.groupId) : undefined;
    const price = priceForModel(profile, job.model ?? '');
    if (!price) return 0;
    return costOfUsage(price, rec.usage, profile?.kind ?? 'openai-compatible');
  }

  cancel(id: string): boolean {
    const active = this.jobs.get(id);
    if (!active) return false;
    active.abort.abort();
    if (active.sessionId) this.host.interrupt(active.sessionId);
    active.job.status = 'cancelled';
    this.broadcastJob(active.job);
    return true;
  }

  private fail(active: ActiveJob, message: string): void {
    const { job } = active;
    if (job.status === 'done' || job.status === 'cancelled') return;
    job.status = job.error?.includes('预算') ? 'error' : 'error';
    job.error = message;
    job.endedAt = Date.now();
    this.jobs.delete(job.id);
    this.broadcastJob(job);
    this.broadcastUpdated(job.project);
  }

  jobsFor(cwd: string): WikiJob[] {
    const { project } = this.projectOf(cwd);
    const live = [...this.jobs.values()]
      .map((entry) => entry.job)
      .filter((job) => job.project === project);
    const history = this.jobHistory.filter((job) => job.project === project).slice(0, 8);
    const seen = new Set(live.map((job) => job.id));
    return [...live, ...history.filter((job) => !seen.has(job.id))].map((job) => ({ ...job }));
  }

  /** 每天更新：优先复用该项目的 wiki 定时任务，没有则新建。 */
  ensureDailySchedule(cwd: string): Schedule {
    const { project } = this.projectOf(cwd);
    const existing = this.host.schedules
      .list()
      .find((schedule) => schedule.target.kind === 'wiki' && path.resolve(schedule.cwd) === project);
    if (existing) return existing;
    const saved = this.host.schedules.upsert({
      name: `每天更新 Wiki：${path.basename(project)}`,
      cron: '0 4 * * *',
      enabled: true,
      target: { kind: 'wiki' },
      cwd: project,
      permissionMode: 'default',
      prompt: '更新项目 Wiki',
    });
    return saved;
  }

  private broadcastUpdated(project: string): void {
    this.host.hub.broadcastAll({ type: 'wiki_updated', project });
  }

  private broadcastJob(job: WikiJob): void {
    this.host.hub.broadcastAll({ type: 'wiki_job', job: { ...job } });
    const entry = this.jobHistory.find((item) => item.id === job.id);
    if (entry) Object.assign(entry, job);
    else this.jobHistory.unshift({ ...job });
  }

  dispose(): void {
    for (const active of this.jobs.values()) {
      active.abort.abort();
      if (active.sessionId) this.host.interrupt(active.sessionId);
    }
    this.jobs.clear();
  }
}
