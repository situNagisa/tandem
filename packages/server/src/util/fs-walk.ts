// 目录遍历：跳过 node_modules/.git，限制数量与深度，避免大仓库卡死。
import { readdirSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export interface WalkOptions {
  ignoreDirs?: Set<string>;
  maxEntries?: number;
  maxDepth?: number;
  signal?: AbortSignal;
}

const DEFAULT_IGNORE = new Set(['node_modules', '.git']);

/** 返回文件的绝对路径列表（不跟随目录软链）。 */
export function walkFiles(root: string, options: WalkOptions = {}): string[] {
  const ignore = options.ignoreDirs ?? DEFAULT_IGNORE;
  const maxEntries = options.maxEntries ?? 20_000;
  const maxDepth = options.maxDepth ?? 16;
  const result: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0 && result.length < maxEntries) {
    if (options.signal?.aborted) break;
    const { dir, depth } = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (result.length >= maxEntries) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name) || depth >= maxDepth) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        result.push(full);
      } else if (entry.isSymbolicLink()) {
        try {
          const st = statSync(full);
          if (st.isFile()) result.push(full);
        } catch {
          // 忽略失效链接
        }
      }
    }
  }
  return result;
}

export interface AsyncWalkOptions extends WalkOptions {
  /** >0 时缓存文件列表，单位毫秒；仅用于可容忍短暂陈旧的场景（如 @ 补全）。 */
  cacheMs?: number;
  /** 同时返回目录（路径以 `/` 结尾），用于 @ 补全里选择文件夹。 */
  includeDirs?: boolean;
}

interface WalkCacheEntry {
  at: number;
  files: string[];
}

const walkCache = new Map<string, WalkCacheEntry>();

/** 异步遍历：按批读目录，目录之间让出事件循环，避免大仓库扫描卡住模型流式输出。 */
export async function walkFilesAsync(
  root: string,
  options: AsyncWalkOptions = {},
): Promise<string[]> {
  const ignore = options.ignoreDirs ?? DEFAULT_IGNORE;
  const maxEntries = options.maxEntries ?? 20_000;
  const maxDepth = options.maxDepth ?? 16;
  const cacheMs = options.cacheMs ?? 0;
  const includeDirs = options.includeDirs === true;
  const key = cacheMs
    ? `${root}\0${maxEntries}\0${maxDepth}\0${includeDirs ? 'd' : 'f'}\0${[...ignore].join(',')}`
    : '';
  if (cacheMs) {
    const hit = walkCache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return hit.files;
  }

  const result: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  // 每轮并发读 16 个目录，再同步处理条目：比逐目录 await 少很多调度开销。
  while (stack.length > 0 && result.length < maxEntries) {
    if (options.signal?.aborted) break;
    const batch = stack.splice(Math.max(0, stack.length - 16));
    const listings = await Promise.all(
      batch.map(async (item) => {
        try {
          return { item, entries: await readdir(item.dir, { withFileTypes: true }) };
        } catch {
          return { item, entries: [] as Array<import('node:fs').Dirent> };
        }
      }),
    );
    for (const { item, entries } of listings) {
      for (const entry of entries) {
        if (result.length >= maxEntries) break;
        const full = path.join(item.dir, entry.name);
        if (entry.isDirectory()) {
          if (ignore.has(entry.name) || item.depth >= maxDepth) continue;
          if (includeDirs) result.push(`${full}/`);
          stack.push({ dir: full, depth: item.depth + 1 });
        } else if (entry.isFile()) {
          result.push(full);
        }
      }
    }
  }

  if (cacheMs) {
    if (walkCache.size > 20) {
      const now = Date.now();
      for (const [k, v] of walkCache) if (now - v.at >= cacheMs) walkCache.delete(k);
    }
    walkCache.set(key, { at: Date.now(), files: result });
  }
  return result;
}
