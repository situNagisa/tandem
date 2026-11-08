// 把本机 Host 的构建产物 + 生产依赖打成可上传的 tar 包。
// 只使用本机已有的 node_modules，不访问网络（远端缺 Node 时不自动下载）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(HERE, '../..');
export const REPO_ROOT = path.resolve(SERVER_DIR, '../..');

interface PkgJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readPkg(dir: string): Promise<PkgJson | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as PkgJson;
  } catch {
    return undefined;
  }
}

/** 从 fromDir 向上按 Node 解析规则找依赖包目录。 */
function resolvePackage(name: string, fromDir: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface HostPackage {
  file: string;
  size: number;
  version: string;
}

let cached: HostPackage | undefined;

/** 生产依赖闭包：从 @tandem/server 的 dependencies 递归解析并复制到暂存目录。 */
async function stageModules(stage: string, serverDir: string): Promise<void> {
  const serverPkg = await readPkg(serverDir);
  if (!serverPkg?.dependencies) throw new Error('找不到 @tandem/server 的 package.json');
  const placed = new Map<string, { version: string; target: string }>();
  const seen = new Set<string>();

  const visit = async (
    name: string,
    fromDir: string,
    parentTarget: string,
    optional: boolean,
  ): Promise<void> => {
    const workspace = name.startsWith('@tandem/')
      ? path.join(REPO_ROOT, 'packages', name.slice('@tandem/'.length))
      : undefined;
    const source =
      resolvePackage(name, fromDir) ??
      (workspace && existsSync(path.join(workspace, 'package.json')) ? workspace : undefined);
    if (!source) {
      if (optional) return;
      throw new Error(`本机缺少生产依赖 ${name}，无法打包`);
    }
    const pkg = await readPkg(source);
    const version = pkg?.version ?? '0.0.0';
    // 顶层已有同名同版本则复用；版本冲突时放到依赖方的 node_modules 下。
    let target = `node_modules/${name}`;
    const top = placed.get(name);
    if (top) {
      if (top.version === version && top.target === target) {
        const key = `${source}->${target}`;
        if (seen.has(key)) return;
        seen.add(key);
      } else {
        target = `${parentTarget}/node_modules/${name}`;
      }
    } else {
      placed.set(name, { version, target });
    }
    const key = `${source}->${target}`;
    if (seen.has(key)) return;
    seen.add(key);

    const dest = path.join(stage, target);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(source, dest, {
      recursive: true,
      dereference: true,
      filter: (src) => path.basename(src) !== 'node_modules',
    });

    const childPkg = await readPkg(source);
    const optionalDeps = childPkg?.optionalDependencies ?? {};
    for (const dep of Object.keys(childPkg?.dependencies ?? {}).sort()) {
      await visit(dep, source, target, !!optionalDeps[dep]);
    }
    for (const dep of Object.keys(optionalDeps).sort()) {
      await visit(dep, source, target, true);
    }
  };

  for (const dep of Object.keys(serverPkg.dependencies).sort()) {
    await visit(dep, serverDir, 'node_modules', false);
  }
}

/** 准备 app 目录：server/dist、web/dist、node_modules、根 package.json(type=module)。 */
async function stageApp(stage: string): Promise<string> {
  await mkdir(stage, { recursive: true });
  const serverDist = path.join(SERVER_DIR, 'dist');
  const webDist = path.join(REPO_ROOT, 'packages/web/dist');
  if (!existsSync(path.join(serverDist, 'cli.js'))) throw new Error('Host 尚未构建（缺少 packages/server/dist）');
  await cp(serverDist, path.join(stage, 'server/dist'), { recursive: true });
  if (existsSync(webDist)) {
    await cp(webDist, path.join(stage, 'web/dist'), { recursive: true });
  }
  await stageModules(stage, SERVER_DIR);
  const version = (await readPkg(SERVER_DIR))?.version ?? '0.0.0';
  await writeFile(
    path.join(stage, 'package.json'),
    JSON.stringify({ name: 'tandem-remote-host', private: true, type: 'module', version }, null, 2),
  );
  return version;
}

export async function buildHostPackage(): Promise<HostPackage> {
  if (cached && existsSync(cached.file)) return cached;
  const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-host-pkg-'));
  try {
    const stage = path.join(root, 'stage');
    const version = await stageApp(stage);
    const file = path.join(root, 'tandem-host.tar.gz');
    await execFileAsync(
      'tar',
      ['-czf', file, '-C', stage, 'server', 'web', 'node_modules', 'package.json'],
      { timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
    );
    const info = await stat(file);
    // 缓存放在独立目录，避免 tmp 清理时把 root 一起删掉。
    const cacheDir = path.join(os.tmpdir(), 'tandem-host-cache');
    await mkdir(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, `tandem-host-${version}-${Date.now()}.tar.gz`);
    await cp(file, cacheFile);
    cached = { file: cacheFile, size: info.size, version };
    return cached;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 本机 Node 是否可上传到远端（必须同为 Linux 且架构一致）。 */
export function nodeUploadInfo(remotePlatform?: string, remoteArch?: string): {
  available: boolean;
  version?: string;
  platform?: string;
  arch?: string;
  reason?: string;
} {
  const local = { platform: process.platform, arch: normArch(process.arch), version: process.version };
  const remote = { platform: normPlatform(remotePlatform), arch: normArch(remoteArch) };
  if (!remotePlatform || !remoteArch) {
    return { available: false, ...local, reason: '尚未探测远端系统' };
  }
  if (local.platform !== 'linux' || remote.platform !== 'linux') {
    return {
      available: false,
      ...local,
      reason: '只能上传本机的 Linux Node 二进制；请在远端自行安装 Node ≥ 22',
    };
  }
  if (local.arch !== remote.arch) {
    return { available: false, ...local, reason: `架构不一致（本机 ${local.arch}，远端 ${remote.arch}）` };
  }
  return { available: true, ...local };
}

export function normArch(value?: string): string {
  const arch = String(value ?? '').toLowerCase();
  if (arch === 'x86_64' || arch === 'amd64' || arch === 'x64') return 'x64';
  if (arch === 'aarch64' || arch === 'arm64') return 'arm64';
  return arch;
}

function normPlatform(value?: string): string {
  const platform = String(value ?? '').toLowerCase();
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin' || platform === 'macos' || platform === 'mac') return 'darwin';
  if (platform === 'mingw64_nt' || platform === 'msys_nt' || platform === 'cygwin_nt') return 'win32';
  return platform;
}

/** 把本机 Node 可执行文件打成 tar（远端解压到 ~/.tandem-host/node/bin/node）。 */
export async function buildNodePackage(): Promise<string> {
  const real = await realpath(process.execPath);
  const root = await mkdtemp(path.join(os.tmpdir(), 'tandem-node-pkg-'));
  try {
    const dir = path.join(root, 'node/bin');
    await mkdir(dir, { recursive: true });
    await cp(real, path.join(dir, 'node'));
    const file = path.join(root, 'node.tar.gz');
    await execFileAsync('tar', ['-czf', file, '-C', path.join(root, 'node'), 'bin'], {
      timeout: 5 * 60 * 1000,
    });
    const cacheDir = path.join(os.tmpdir(), 'tandem-host-cache');
    await mkdir(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, `node-${process.version}-${process.arch}.tar.gz`);
    await cp(file, cached);
    return cached;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function realpath(file: string): Promise<string> {
  const { realpath: rp } = await import('node:fs/promises');
  return rp(file);
}
