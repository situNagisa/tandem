// 目录遍历：跳过 node_modules/.git，限制数量与深度，避免大仓库卡死。
import { readdirSync, statSync } from 'node:fs';
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
