// 文件系统浏览 / 补全 / 预览。
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FsEntry } from '@tandem/protocol';
import { walkFilesAsync } from '../util/fs-walk.js';
import { readForPreview, readImage, revealFile } from '../util/file-preview.js';
import { expandHome, resolveHostPath, toPosix } from '../util/path.js';
import { bad, str, type RouteDeps } from './common.js';
import { memberCanAccessPath, principalOf } from '../team/access.js';

/** @文件补全的模糊匹配打分；不匹配返回 null。 */
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) {
    // 越靠前、越短越优先
    return 1000 - direct * 3 - t.length * 0.1;
  }
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += prev === ti - 1 ? 8 : 2;
      prev = ti;
      qi++;
    }
  }
  return qi === q.length ? score - t.length * 0.1 : null;
}

export function registerFsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/fs/list', async (req, reply) => {
    const query = req.query as { path?: string; files?: string };
    const principal = principalOf(req);
    const fallback = principal.kind === 'member' ? principal.projectDirs[0] : os.homedir();
    const raw = str(query.path) || fallback || os.homedir();
    const dir = resolveHostPath(expandHome(raw));
    if (!memberCanAccessPath(principal, dir)) {
      return bad(reply, '只能浏览自己被授权的项目目录', 403);
    }
    const includeFiles = str(query.files) === '1';
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      return bad(reply, `目录不存在: ${dir}`);
    }
    if (!stat.isDirectory()) return bad(reply, `不是目录: ${dir}`);

    const entries: FsEntry[] = [];
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return bad(reply, `无法读取目录: ${(err as Error).message}`);
    }
    for (const entry of dirents) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
      }
      if (includeFiles || isDir) {
        entries.push({ name: entry.name, path: full, isDir });
      }
    }
    entries.sort((a, b) =>
      includeFiles && a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
    );
    return entries;
  });

  app.get('/api/fs/complete', async (req, reply) => {
    const query = req.query as { cwd?: string; q?: string };
    const cwdRaw = str(query.cwd) || process.cwd();
    const cwd = path.resolve(expandHome(cwdRaw));
    if (!memberCanAccessPath(principalOf(req), cwd)) {
      return bad(reply, '只能在自己被授权的项目目录里搜索', 403);
    }
    const q = str(query.q);
    if (!q) return [] as string[];
    try {
      if (!statSync(cwd).isDirectory()) return bad(reply, `不是目录: ${cwd}`);
    } catch {
      return bad(reply, `目录不存在: ${cwd}`);
    }

    // 缓存 2s：连续输入时不再每敲一个字符都重新遍历整棵仓库
    const files = await walkFilesAsync(cwd, { maxEntries: 20_000, cacheMs: 2_000 });
    const scored: Array<{ rel: string; score: number }> = [];
    for (const file of files) {
      const rel = toPosix(path.relative(cwd, file));
      if (rel.startsWith('..')) continue;
      const score = fuzzyScore(q, rel);
      if (score !== null) scored.push({ rel, score });
    }
    scored.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
    return scored.slice(0, 50).map((item) => item.rel);
  });

  /** 文件链接的路径：绝对路径直接用，相对路径以 cwd（默认进程 cwd）为基准。 */
  function resolvePreviewPath(rawPath: string, cwdRaw: string): string {
    const cwd = cwdRaw ? resolveHostPath(expandHome(cwdRaw)) : undefined;
    return resolveHostPath(expandHome(rawPath), cwd);
  }

  app.get('/api/fs/read', async (req, reply) => {
    const query = req.query as { path?: string; cwd?: string };
    const raw = str(query.path);
    if (!raw) return bad(reply, 'path 不能为空');
    const abs = resolvePreviewPath(raw, str(query.cwd));
    if (!memberCanAccessPath(principalOf(req), abs)) {
      return bad(reply, '只能读取自己被授权项目里的文件', 403);
    }
    try {
      return await readForPreview(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return bad(reply, `文件不存在: ${abs}`, 404);
      if (code === 'EACCES') return bad(reply, `没有权限读取: ${abs}`, 403);
      return bad(reply, (err as Error).message);
    }
  });

  app.get('/api/fs/raw', async (req, reply) => {
    const query = req.query as { path?: string; cwd?: string };
    const raw = str(query.path);
    if (!raw) return bad(reply, 'path 不能为空');
    const abs = resolvePreviewPath(raw, str(query.cwd));
    if (!memberCanAccessPath(principalOf(req), abs)) {
      return bad(reply, '只能读取自己被授权项目里的文件', 403);
    }
    try {
      const image = await readImage(abs);
      return reply
        .type(image.mime)
        .header('Cache-Control', 'no-store')
        .send(image.data);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return bad(reply, `文件不存在: ${abs}`, 404);
      return bad(reply, (err as Error).message);
    }
  });

  app.post('/api/fs/reveal', async (req, reply) => {
    const body = (req.body ?? {}) as { path?: unknown; cwd?: unknown };
    const raw = str(body.path);
    if (!raw) return bad(reply, 'path 不能为空');
    const abs = resolvePreviewPath(raw, str(body.cwd));
    let isDir: boolean;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      return { ok: false, error: `文件不存在: ${abs}` };
    }
    return revealFile(abs, isDir);
  });
}
