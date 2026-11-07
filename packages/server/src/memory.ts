// 项目记忆：Tandem 私有的长期事实，与仓库内只读的 AGENTS.md / CLAUDE.md 区分。
// 每个项目（git 仓库根或 cwd）一份 ~/.tandem/memory/<hash>.md；全局记忆为 _global.md。
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { MemoryFile, MemoryListItem, MemoryScope } from '@tandem/protocol';

/** 注入系统提示时每个范围的最大字符数；超出截断并提示。 */
export const MEMORY_PROMPT_LIMIT = 6000;
const MAX_FILE_BYTES = 512 * 1024;
const META_RE = /^<!--\s*tandem-memory\s+(\{.*\})\s*-->\s*$/;

export interface ProjectInfo {
  /** 项目根路径（git 仓库根，否则 cwd）。 */
  project: string;
  /** 项目名（根目录 basename）。 */
  name: string;
}

interface FileMeta {
  project?: string;
  name?: string;
}

/** 向上找 .git，找不到就用 cwd 本身。 */
export function projectInfoOf(cwd: string): ProjectInfo {
  let dir = path.resolve(cwd);
  const start = dir;
  for (let i = 0; i < 30; i++) {
    if (existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) {
      dir = start;
      break;
    }
    dir = parent;
  }
  return { project: dir, name: path.basename(dir) || dir };
}

export function memoryFileName(project: string): string {
  return `${createHash('sha1').update(project).digest('hex').slice(0, 16)}.md`;
}

function metaLine(meta: FileMeta): string {
  return `<!-- tandem-memory ${JSON.stringify(meta)} -->`;
}

function parseMeta(text: string): { meta: FileMeta; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0) {
    const match = META_RE.exec(lines[0] ?? '');
    if (match) {
      try {
        const meta = JSON.parse(match[1]!) as FileMeta;
        return { meta, body: lines.slice(1).join('\n') };
      } catch {
        // 元数据损坏时按普通正文处理
      }
    }
  }
  return { meta: {}, body: text };
}

export function countEntries(body: string): number {
  let count = 0;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*[-*]\s+\S/.test(line)) count++;
  }
  return count;
}

/** 去掉 Tandem 元数据行后的正文。 */
export function bodyOfMemory(text: string): string {
  return trimBody(parseMeta(String(text ?? '')).body);
}

function trimBody(body: string): string {
  return body.replace(/^\s*\n/, '').replace(/\s+$/, '');
}

export class MemoryStore {
  readonly dir: string;

  constructor(home: string) {
    this.dir = path.join(home, 'memory');
  }

  private fileFor(scope: MemoryScope, cwd?: string): { file: string; project?: string; name: string } {
    if (scope === 'global') return { file: path.join(this.dir, '_global.md'), name: '全局' };
    if (!cwd) throw new Error('项目记忆需要 project 参数');
    const info = projectInfoOf(cwd);
    return { file: path.join(this.dir, memoryFileName(info.project)), project: info.project, name: info.name };
  }

  read(scope: MemoryScope, cwd?: string): MemoryFile {
    const target = this.fileFor(scope, cwd);
    let exists = false;
    let updatedAt = 0;
    let size = 0;
    let text = '';
    let body = '';
    let name = target.name;
    let project = target.project;
    try {
      const stat = statSync(target.file);
      exists = true;
      updatedAt = stat.mtimeMs;
      size = stat.size;
      const raw = readFileSync(target.file, 'utf8');
      text = raw;
      const parsed = parseMeta(raw);
      body = trimBody(parsed.body);
      if (parsed.meta.name) name = parsed.meta.name;
      if (parsed.meta.project) project = parsed.meta.project;
    } catch {
      // 不存在：返回空文件
    }
    return {
      scope,
      ...(project ? { project } : {}),
      name,
      text,
      exists,
      updatedAt,
      size,
      entries: countEntries(body),
    };
  }

  write(scope: MemoryScope, cwd: string | undefined, text: string): MemoryFile {
    const target = this.fileFor(scope, cwd);
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      throw new Error('记忆内容过大（上限 512KB）');
    }
    // 用户可整篇编辑：若正文已带元数据行则原样保存，否则补一行记录项目路径与名称。
    const hasMeta = META_RE.test(text.split(/\r?\n/)[0] ?? '');
    const content = hasMeta
      ? text
      : `${metaLine({
          ...(target.project ? { project: target.project } : {}),
          name: target.name,
        })}\n${text.trim() ? `${trimBody(text)}\n` : ''}`;
    this.ensureDir();
    const tmp = `${target.file}.${process.pid}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, target.file);
    return this.read(scope, cwd);
  }

  remove(scope: MemoryScope, cwd?: string): boolean {
    const target = this.fileFor(scope, cwd);
    try {
      unlinkSync(target.file);
      return true;
    } catch {
      return false;
    }
  }

  /** 追加一条或多条事实（每行一条），返回更新后的文件。 */
  add(cwd: string, text: string, scope: MemoryScope = 'project'): MemoryFile {
    const lines = normalizeFactLines(text);
    if (lines.length === 0) throw new Error('要记住的内容不能为空');
    const doc = this.read(scope, cwd);
    const body = trimBody(parseMeta(doc.text).body);
    const next = [body, ...lines].filter(Boolean).join('\n');
    return this.writeBody(scope, cwd, doc, next);
  }

  replace(cwd: string, old: string, text: string, scope: MemoryScope = 'project'): MemoryFile {
    const needle = old.trim();
    const replacement = normalizeFactLines(text);
    if (!needle) throw new Error('old 不能为空');
    if (replacement.length === 0) throw new Error('替换后的内容不能为空');
    const doc = this.read(scope, cwd);
    const lines = trimBody(parseMeta(doc.text).body).split(/\r?\n/);
    const index = lines.findIndex((line) => line.trim().includes(needle));
    if (index < 0) throw new Error(`没有找到包含「${needle}」的记忆条目`);
    lines.splice(index, 1, ...replacement);
    return this.writeBody(scope, cwd, doc, lines.join('\n'));
  }

  removeFact(cwd: string, old: string, scope: MemoryScope = 'project'): MemoryFile {
    const needle = old.trim();
    if (!needle) throw new Error('old 不能为空');
    const doc = this.read(scope, cwd);
    const lines = trimBody(parseMeta(doc.text).body).split(/\r?\n/);
    const kept = lines.filter((line) => !line.trim().includes(needle));
    if (kept.length === lines.length) throw new Error(`没有找到包含「${needle}」的记忆条目`);
    return this.writeBody(scope, cwd, doc, kept.join('\n'));
  }

  private writeBody(
    scope: MemoryScope,
    cwd: string | undefined,
    doc: MemoryFile,
    body: string,
  ): MemoryFile {
    const target = this.fileFor(scope, cwd);
    const content = `${metaLine({
      ...(target.project ? { project: target.project } : {}),
      name: target.name,
    })}\n${body.trim() ? `${trimBody(body)}\n` : ''}`;
    this.ensureDir();
    const tmp = `${target.file}.${process.pid}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, target.file);
    return this.read(scope, cwd);
  }

  /** 导入/迁移合并：目标已有内容时追加并标注来源。 */
  merge(
    scope: MemoryScope,
    cwd: string | undefined,
    text: string,
    source: string,
  ): { file: MemoryFile; merged: boolean } {
    const incoming = bodyOfMemory(text).trim();
    const doc = this.read(scope, cwd);
    if (!incoming) return { file: doc, merged: false };
    const existing = bodyOfMemory(doc.text).trim();
    if (existing.includes(incoming)) return { file: doc, merged: false };
    const label = source.trim() || '其它 Host';
    const body = existing ? `${existing}\n\n<!-- 来自 ${label} -->\n${incoming}` : incoming;
    return { file: this.write(scope, cwd, body), merged: true };
  }

  list(): { global: MemoryFile; projects: MemoryFile[] } {
    const global = this.read('global');
    const projects: MemoryFile[] = [];
    if (existsSync(this.dir)) {
      for (const entry of readdirSync(this.dir)) {
        if (!entry.endsWith('.md') || entry === '_global.md') continue;
        const file = path.join(this.dir, entry);
        try {
          const raw = readFileSync(file, 'utf8');
          const parsed = parseMeta(raw);
          const stat = statSync(file);
          projects.push({
            scope: 'project',
            ...(parsed.meta.project ? { project: parsed.meta.project } : {}),
            name: parsed.meta.name || entry.replace(/\.md$/, ''),
            text: raw,
            exists: true,
            updatedAt: stat.mtimeMs,
            size: stat.size,
            entries: countEntries(trimBody(parsed.body)),
          });
        } catch {
          // 跳过不可读文件
        }
      }
    }
    projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return { global, projects };
  }

  listItems(): { global?: MemoryListItem; projects: MemoryListItem[] } {
    const { global, projects } = this.list();
    const toItem = (file: MemoryFile): MemoryListItem => ({
      scope: file.scope,
      ...(file.project ? { project: file.project } : {}),
      name: file.name,
      size: file.size,
      updatedAt: file.updatedAt ?? 0,
      entries: file.entries,
    });
    return {
      ...(global.exists ? { global: toItem(global) } : {}),
      projects: projects.map(toItem),
    };
  }

  /** 系统提示里的记忆段：全局 + 当前项目，超长截断。rule 可在设置-提示词里改写。 */
  promptSection(cwd: string, rule?: string): string {
    const global = this.read('global');
    const project = this.read('project', cwd);
    const globalBody = trimBody(parseMeta(global.text).body);
    const projectBody = trimBody(parseMeta(project.text).body);
    const parts: string[] = [
      '# 项目记忆（Tandem 私有，跨会话保留）',
      '这是用户与 Tandem 长期积累的记忆，与仓库内的 AGENTS.md / CLAUDE.md 不同；它们可由 Memory 工具更新。',
      rule?.trim() ||
        '使用规则：遵守下列约定与偏好；与当前用户指令冲突时以用户当前指令为准。不要主动把它们的全文复述给用户。',
    ];
    let truncated = false;
    const appendScope = (title: string, body: string) => {
      if (!body) return;
      let text = body;
      if (text.length > MEMORY_PROMPT_LIMIT) {
        text = text.slice(0, MEMORY_PROMPT_LIMIT);
        truncated = true;
      }
      parts.push('', `## ${title}`, text);
    };
    appendScope('全局记忆', globalBody);
    appendScope(`项目记忆（${project.name}｜${project.project ?? cwd}）`, projectBody);
    if (truncated) {
      parts.push('', `（记忆超过 ${MEMORY_PROMPT_LIMIT} 字，已截断；可用 Memory view 查看全文。）`);
    }
    if (!globalBody && !projectBody) {
      parts.push('', '当前还没有保存任何记忆。用户说「记住…」或发现长期有效的项目事实/约定/偏好时，用 Memory 工具记录；不要记录临时进度。');
    }
    return parts.join('\n');
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
}

/** 事实文本转条目行：支持多行，每行一条，统一成 "- " 列表。 */
export function normalizeFactLines(text: string): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/^[-*]\s+/.test(line) ? line.replace(/^[*]\s+/, '- ') : `- ${line}`));
}

/** 给工具卡/审批弹窗用的单行摘要。 */
export function memorySummaryOf(input: Record<string, unknown>): string {
  const action = String(input.action ?? '');
  const text = String(input.text ?? input.old ?? '').replace(/\s+/g, ' ').trim();
  const clip = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  if (action === 'view') return '查看记忆';
  return clip || '更新记忆';
}
