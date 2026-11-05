// 路径工具：~ 展开、相对路径解析、分隔符统一。
import os from 'node:os';
import path from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolvePath(cwd: string, p: string): string {
  return path.resolve(cwd, expandHome(p));
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
