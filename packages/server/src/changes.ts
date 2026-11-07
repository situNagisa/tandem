// 改动审阅：基于会话 cwd 所在 git 仓库的状态、diff、丢弃与提交。
// 所有 git 调用都用 execFile 参数数组，绝不拼 shell 字符串。
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ChangesResult, DiffEmptyReason, FileChange } from '@tandem/protocol';
import { walkFiles } from './util/fs-walk.js';
import { isSubPath, toPosix } from './util/path.js';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 统一执行 git 子命令；失败不抛错，由调用方按 exit code 判断。
 * -c core.quotepath=false：中文 / 特殊字符路径不被转义成 \344\275\240 形式。
 * 所有调用都以仓库根为 cwd（调用方保证），返回的路径都是仓库相对 posix 路径。
 */
async function runGit(cwd: string, args: string[]): Promise<GitRun> {
  try {
    const { stdout, stderr } = await exec('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.message ?? ''),
    };
  }
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'git 命令执行失败');
  }
  return result.stdout;
}

/** cwd 所在仓库根目录；非仓库返回 undefined。 */
export async function repoRootOf(cwd: string): Promise<string | undefined> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  const root = result.stdout.trim();
  return result.code === 0 && root ? root : undefined;
}

/** git 输出的路径统一成仓库相对 posix 路径（Windows 上不出现反斜杠）。 */
function gitPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 校验路径在仓库内，返回 posix 相对路径（相对仓库根）。 */
export function repoRelativePath(root: string, input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('path 不能为空');
  const raw = gitPath(input.trim());
  if (path.isAbsolute(raw)) throw new Error(`只接受仓库内相对路径: ${raw}`);
  const abs = path.resolve(root, raw);
  if (!isSubPath(root, abs)) throw new Error(`路径不在仓库内: ${raw}`);
  const rel = toPosix(path.relative(root, abs));
  if (!rel) throw new Error('path 不能指向仓库根目录');
  return rel;
}

interface StatusEntry {
  path: string;
  oldPath?: string;
  status: FileChange['status'];
}

function classify(x: string, y: string): FileChange['status'] {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || y === 'A') return 'added';
  return 'modified';
}

/** 解析 `git status --porcelain=v1 -z`。 */
async function readStatus(root: string): Promise<StatusEntry[]> {
  const result = await runGit(root, ['status', '--porcelain=v1', '-z']);
  if (result.code !== 0) return [];
  const parts = result.stdout.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record) continue;
    const x = record[0] ?? ' ';
    const y = record[1] ?? ' ';
    const file = gitPath(record.slice(3));
    if (!file) continue;
    let oldPath: string | undefined;
    // 重命名/复制：紧跟一条原路径记录
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = gitPath(parts[++i] || '');
    }
    entries.push({ path: file, ...(oldPath ? { oldPath } : {}), status: classify(x, y) });
  }
  return entries;
}

/** 统计单个文件行数；二进制返回 null。 */
function countLines(file: string): number | null {
  try {
    const buf = readFileSync(file);
    if (buf.includes(0)) return null;
    if (buf.length === 0) return 0;
    let lines = 0;
    for (const byte of buf) if (byte === 10) lines++;
    if (buf[buf.length - 1] !== 10) lines++;
    return lines;
  } catch {
    return null;
  }
}

/** 未跟踪路径的行数：目录递归累加。 */
function countUntracked(abs: string): number {
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return countLines(abs) ?? 0;
  let total = 0;
  for (const file of walkFiles(abs, { maxEntries: 5000 })) {
    total += countLines(file) ?? 0;
  }
  return total;
}

/**
 * `git diff --numstat -z`（工作区）+ `git diff --cached --numstat -z`（暂存区），按路径累加。
 * 重命名记录形如 `add\tdel\t\0old\0new\0`，行数归到新路径。
 */
async function readNumstat(root: string): Promise<Map<string, { additions: number; deletions: number }>> {
  const totals = new Map<string, { additions: number; deletions: number }>();
  for (const args of [
    ['diff', '--numstat', '-z'],
    ['diff', '--cached', '--numstat', '-z'],
  ]) {
    const result = await runGit(root, args);
    if (result.code !== 0) continue;
    const parts = result.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const record = parts[i];
      if (!record) continue;
      const match = record.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
      if (!match) continue;
      let file = gitPath(match[3] ?? '');
      if (!file) {
        const oldPath = parts[++i];
        const newPath = parts[++i];
        file = gitPath(newPath || oldPath || '');
      }
      if (!file) continue;
      const additions = match[1] === '-' ? 0 : Number(match[1]);
      const deletions = match[2] === '-' ? 0 : Number(match[2]);
      const prev = totals.get(file) ?? { additions: 0, deletions: 0 };
      prev.additions += Number.isFinite(additions) ? additions : 0;
      prev.deletions += Number.isFinite(deletions) ? deletions : 0;
      totals.set(file, prev);
    }
  }
  return totals;
}

/** 工作区改动列表；未跟踪目录展开为其中的文件。 */
export async function getChanges(cwd: string): Promise<ChangesResult> {
  const root = await repoRootOf(cwd);
  if (!root) return { isRepo: false, files: [] };

  const branchOut = await runGit(root, ['branch', '--show-current']);
  const branch = branchOut.stdout.trim() || undefined;
  const [entries, numstat] = await Promise.all([readStatus(root), readNumstat(root)]);

  const files: FileChange[] = [];
  for (const entry of entries) {
    if (entry.status === 'untracked' && entry.path.endsWith('/')) {
      // 整个目录未跟踪：逐个文件列出，便于单文件 diff / 丢弃
      const dirAbs = path.resolve(root, entry.path);
      for (const file of walkFiles(dirAbs, { maxEntries: 5000 })) {
        const rel = toPosix(path.relative(root, file));
        if (!rel) continue;
        files.push({ path: rel, status: 'untracked', additions: countLines(file) ?? 0, deletions: 0 });
      }
      continue;
    }
    const counted = numstat.get(entry.path);
    files.push({
      path: entry.path,
      status: entry.status,
      additions: entry.status === 'untracked' ? countUntracked(path.resolve(root, entry.path)) : counted?.additions ?? 0,
      deletions: entry.status === 'untracked' ? 0 : counted?.deletions ?? 0,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
    });
  }
  return { isRepo: true, ...(branch ? { branch } : {}), files };
}

/** 未跟踪文件 diff 的空文件基准：用临时空文件而不是 /dev/null / NUL，Windows 上同样可靠。 */
let emptyBaseline: string | undefined;
function emptyBaselinePath(): string {
  if (!emptyBaseline) {
    emptyBaseline = path.join(mkdtempSync(path.join(os.tmpdir(), 'tandem-diff-')), 'empty');
  }
  writeFileSync(emptyBaseline, '');
  return emptyBaseline;
}

/** 单个文件是否落在某个未跟踪目录下（git status 会把整个目录折叠成一条 `dir/`）。 */
function inUntrackedDir(file: string, entry: StatusEntry): boolean {
  return entry.status === 'untracked' && entry.path.endsWith('/') && file.startsWith(entry.path);
}

/** diff 文本为空时，判断空的原因，供 UI 显示比“没有差异”更准确的信息。 */
async function emptyReason(
  root: string,
  rel: string,
  entry: StatusEntry | undefined,
  additions: number,
  deletions: number,
): Promise<DiffEmptyReason> {
  const [summary, stagedSummary] = await Promise.all([
    runGit(root, ['diff', '--summary', '--', rel]),
    runGit(root, ['diff', '--cached', '--summary', '--', rel]),
  ]);
  const text = `${summary.stdout}${stagedSummary.stdout}`;
  if (/mode change/i.test(text)) return 'mode';
  if (/rename (from|to)/i.test(text)) return 'rename';
  if (additions > 0 || deletions > 0) return 'eol';
  if (entry?.status === 'untracked') return 'none';
  return 'none';
}

const MAX_DIFF_CHARS = 1_000_000;
const MAX_DIFF_LINES = 20_000;

/** 大 diff 截断：只保留前 1MB / 2 万行，避免 16MB 响应拖垮 Host 与前端渲染。 */
function capDiff(diff: string): { diff: string; truncated?: true } {
  if (diff.length <= MAX_DIFF_CHARS) return { diff };
  let text = diff.slice(0, MAX_DIFF_CHARS);
  const newline = text.lastIndexOf('\n');
  if (newline > 0) text = text.slice(0, newline + 1);
  const lines = text.split('\n');
  if (lines.length > MAX_DIFF_LINES) text = `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n`;
  return { diff: text, truncated: true };
}

/** 单文件统一 diff。未跟踪文件（含未跟踪目录里的文件）用 --no-index 与 /dev/null 比较。 */
export async function getFileDiff(
  cwd: string,
  input: string,
): Promise<{ path: string; diff: string; emptyReason?: DiffEmptyReason; truncated?: true }> {
  const root = await repoRootOf(cwd);
  if (!root) throw new Error('当前目录不是 git 仓库');
  const rel = repoRelativePath(root, input);
  const status = await readStatus(root);
  // 精确匹配，或匹配被折叠的未跟踪目录（如 build-lease/ → build-lease/CMakeCache.txt）
  const entry =
    status.find((item) => item.path === rel || item.oldPath === rel) ??
    status.find((item) => inUntrackedDir(rel, item));

  if (entry?.status === 'untracked') {
    const result = await runGit(root, ['diff', '--no-index', '--', emptyBaselinePath(), rel]);
    // --no-index 有差异时退出码为 1，属正常情况
    if (result.code !== 0 && !result.stdout) {
      throw new Error(result.stderr.trim() || '无法生成 diff');
    }
    return result.stdout
      ? { path: rel, ...capDiff(result.stdout) }
      : { path: rel, diff: '', emptyReason: 'none' };
  }

  const [staged, unstaged] = await Promise.all([
    runGit(root, ['diff', '--cached', '--', rel]),
    runGit(root, ['diff', '--', rel]),
  ]);
  const diff = `${staged.stdout}${unstaged.stdout}`;
  // 只有 “old mode / new mode / rename” 这类元信息、没有 hunk 的 diff 对用户等于无内容差异
  if (/(^|\n)@@ /.test(diff)) return { path: rel, ...capDiff(diff) };
  const numstat = await readNumstat(root);
  const counted = numstat.get(rel);
  return {
    path: rel,
    diff,
    emptyReason: await emptyReason(root, rel, entry, counted?.additions ?? 0, counted?.deletions ?? 0),
  };
}

/**
 * 丢弃工作区改动。tracked：先 `git restore --staged` 再 `git checkout --`；
 * untracked：直接删除文件（破坏性，客户端需二次确认）。
 */
export async function revertChanges(cwd: string, paths: string[]): Promise<ChangesResult> {
  const root = await repoRootOf(cwd);
  if (!root) throw new Error('当前目录不是 git 仓库');
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths 不能为空');
  const rels = paths.map((item) => repoRelativePath(root, item));
  const status = await readStatus(root);
  const byPath = new Map(status.map((entry) => [entry.path, entry]));

  for (const rel of rels) {
    const entry = byPath.get(rel);
    const abs = path.resolve(root, rel);
    if (entry?.status === 'untracked') {
      rmSync(abs, { recursive: true, force: true });
      continue;
    }
    // 已暂存的先撤出暂存区，再恢复工作区文件
    await runGit(root, ['restore', '--staged', '--', rel]);
    const restored = await runGit(root, ['checkout', '--', rel]);
    if (restored.code !== 0) {
      if (entry?.status === 'added' || entry?.status === 'renamed') {
        // HEAD 中不存在该路径，checkout 无法恢复：删除工作区副本
        rmSync(abs, { recursive: true, force: true });
      } else if (entry) {
        throw new Error(`无法恢复 ${rel}: ${restored.stderr.trim()}`);
      }
    }
  }
  return getChanges(cwd);
}

export interface CommitResult {
  ok: boolean;
  commit?: string;
  error?: string;
}

/** 提交改动：paths 缺省表示全部改动。 */
export async function commitChanges(
  cwd: string,
  message: unknown,
  paths?: unknown,
): Promise<CommitResult> {
  try {
    const root = await repoRootOf(cwd);
    if (!root) throw new Error('当前目录不是 git 仓库');
    const msg = typeof message === 'string' ? message.trim() : '';
    if (!msg) throw new Error('提交信息不能为空');

    const list = Array.isArray(paths) ? paths.filter((item): item is string => typeof item === 'string') : [];
    if (list.length > 0) {
      const rels = list.map((item) => repoRelativePath(root, item));
      await gitOrThrow(root, ['add', '-A', '--', ...rels]);
    } else {
      await gitOrThrow(root, ['add', '-A']);
    }

    const commit = await runGit(root, ['commit', '-m', msg]);
    if (commit.code !== 0) {
      return { ok: false, error: commit.stderr.trim() || commit.stdout.trim() || 'git commit 失败' };
    }
    const head = await runGit(root, ['rev-parse', 'HEAD']);
    const hash = head.stdout.trim();
    return { ok: true, ...(hash ? { commit: hash } : {}) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
