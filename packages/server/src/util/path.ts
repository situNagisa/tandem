// 路径工具：~ 展开、相对路径解析、分隔符统一。
// 可选的 env 指定路径所在机器的 home 与路径语义，缺省为本机。
import path from 'node:path';
import { localHostEnv, type HostEnv } from '../host-env.js';

type PathEnv = Pick<HostEnv, 'home' | 'path'>;

export function expandHome(p: string, env: PathEnv = localHostEnv): string {
  if (p === '~') return env.home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return env.path.join(env.home, p.slice(2));
  return p;
}

export function resolvePath(cwd: string, p: string, env: PathEnv = localHostEnv): string {
  return env.path.resolve(cwd, expandHome(p, env));
}

export function toPosix(p: string, env: PathEnv = localHostEnv): string {
  return p.split(env.path.sep).join('/');
}

export function isSubPath(parent: string, child: string, env: PathEnv = localHostEnv): boolean {
  const rel = env.path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !env.path.isAbsolute(rel));
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
