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

/** Host 平台的路径实现：Windows 用 win32，其余用 posix。 */
export function hostPathOf(platform: NodeJS.Platform | string = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export const HOST_PATH = hostPathOf();

/**
 * 归一化客户端传来的路径：
 * - 解析 file:/// 链接；
 * - win32 接受正斜杠与反斜杠，去掉盘符前多余的 `/`（`/D:/a` → `D:\a`）；
 * - posix 上保持原样（反斜杠是合法文件名字符）。
 */
export function normalizeIncomingPath(raw: string, platform: string = process.platform): string {
  let value = raw.trim();
  if (/^file:/i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      value = value.replace(/^file:\/\//i, '');
    }
  }
  if (platform === 'win32') {
    value = value.replace(/\//g, '\\');
    if (/^\\[A-Za-z]:/.test(value)) value = value.slice(1);
    return path.win32.normalize(value);
  }
  return value;
}

/** 以 cwd 为基准解析客户端路径（相对路径）；绝对路径直接归一化。 */
export function resolveHostPath(
  raw: string,
  cwd?: string,
  platform: string = process.platform,
): string {
  const api = hostPathOf(platform);
  const value = normalizeIncomingPath(raw, platform);
  if (api.isAbsolute(value)) return api.normalize(value);
  return api.resolve(cwd ?? process.cwd(), value);
}
