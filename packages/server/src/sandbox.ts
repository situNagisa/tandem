// 命令沙箱：写保护静态分析、网络白名单、真沙箱（Linux bwrap / macOS sandbox-exec）。
// 静态分析只是启发式检查，绕过方式很多；真正的隔离依赖 bwrap/sandbox-exec。
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  PermissionSandboxNotice,
  SandboxPackageSource,
  SandboxPlatformStatus,
  SandboxSettings,
  SandboxStatus,
} from '@tandem/protocol';
import { readJson, writePrivateFile } from './config.js';
import { isSubPath } from './util/path.js';

export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1', '*.localhost'];

export const PACKAGE_SOURCES: SandboxPackageSource[] = [
  { label: 'npm / pnpm', hosts: ['registry.npmjs.org'] },
  { label: 'Yarn', hosts: ['registry.yarnpkg.com'] },
  { label: 'PyPI', hosts: ['pypi.org', 'files.pythonhosted.org'] },
  { label: 'GitHub', hosts: ['github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com'] },
  { label: 'crates.io', hosts: ['crates.io', 'static.crates.io', 'index.crates.io'] },
  { label: 'Go proxy', hosts: ['proxy.golang.org', 'sum.golang.org'] },
  { label: 'Debian / Ubuntu', hosts: ['deb.debian.org', 'archive.ubuntu.com', 'security.ubuntu.com'] },
  { label: 'Homebrew', hosts: ['formulae.brew.sh', 'ghcr.io'] },
];

export function defaultSandboxSettings(): SandboxSettings {
  return {
    enabled: true,
    network: 'host',
    strict: false,
    allowedHosts: [...DEFAULT_ALLOWED_HOSTS],
  };
}

/** 规范化设置：回环地址始终保留，去重并压缩空白。 */
export function normalizeSandboxSettings(value: unknown): SandboxSettings {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const hosts: string[] = [];
  const add = (item: string) => {
    const host = item.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  if (Array.isArray(raw.allowedHosts)) {
    for (const item of raw.allowedHosts) if (typeof item === 'string') add(item);
  }
  for (const item of DEFAULT_ALLOWED_HOSTS) add(item);
  return {
    enabled: raw.enabled === false ? false : true,
    network: raw.network === 'none' ? 'none' : 'host',
    strict: raw.strict === true,
    allowedHosts: hosts,
  };
}

/** ~/.tandem/sandbox.json：沙箱与网络白名单设置。 */
export class SandboxSettingsStore {
  private file: string;
  private current: SandboxSettings;

  constructor(home: string) {
    this.file = path.join(home, 'sandbox.json');
    this.current = normalizeSandboxSettings(readJson<Partial<SandboxSettings>>(this.file));
  }

  get(): SandboxSettings {
    return {
      ...this.current,
      allowedHosts: [...this.current.allowedHosts],
    };
  }

  set(input: unknown): SandboxSettings {
    this.current = normalizeSandboxSettings(input);
    this.save();
    return this.get();
  }

  addHosts(hostsList: string[]): SandboxSettings {
    return this.set({
      ...this.current,
      allowedHosts: [...this.current.allowedHosts, ...hostsList],
    });
  }

  private save(): void {
    writePrivateFile(this.file, JSON.stringify(this.current, null, 2));
  }
}

export interface SandboxEngine {
  engine: 'bwrap' | 'sandbox-exec';
  binary: string;
}

function findExecutable(name: string): string | undefined {
  const candidates: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, name));
  }
  if (process.platform === 'linux') {
    candidates.push(`/usr/bin/${name}`, `/usr/sbin/${name}`, `/bin/${name}`, `/usr/local/bin/${name}`);
  } else if (process.platform === 'darwin') {
    candidates.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`);
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 继续找
    }
  }
  return undefined;
}

/** 检测本机可用的真沙箱；Windows 永远返回 undefined（仅静态检查）。 */
export function detectSandboxEngine(platform: NodeJS.Platform = process.platform): SandboxEngine | undefined {
  if (platform === 'linux') {
    const binary = findExecutable('bwrap');
    return binary ? { engine: 'bwrap', binary } : undefined;
  }
  if (platform === 'darwin') {
    const binary = findExecutable('sandbox-exec');
    return binary ? { engine: 'sandbox-exec', binary } : undefined;
  }
  return undefined;
}

export function platformStatus(platform: NodeJS.Platform = process.platform): SandboxPlatformStatus {
  const normalized: SandboxPlatformStatus['platform'] =
    platform === 'linux' || platform === 'darwin' || platform === 'win32' ? platform : 'other';
  const engine = detectSandboxEngine(platform);
  if (engine?.engine === 'bwrap') {
    return {
      platform: normalized,
      available: true,
      engine: 'bwrap',
      message: 'bubblewrap 可用：命令在只读根目录下运行，仅工作目录与 /tmp 可写，可选择断网。',
      networkIsolation: true,
    };
  }
  if (engine?.engine === 'sandbox-exec') {
    return {
      platform: normalized,
      available: true,
      engine: 'sandbox-exec',
      message: 'sandbox-exec 可用：命令的文件写入限制在工作目录与临时目录。',
      networkIsolation: false,
    };
  }
  if (platform === 'win32') {
    return {
      platform: normalized,
      available: false,
      engine: '',
      message: 'Windows 上仅静态检查（暂不支持文件系统沙箱）。',
      networkIsolation: false,
    };
  }
  if (platform === 'linux') {
    return {
      platform: normalized,
      available: false,
      engine: '',
      message: '未检测到 bubblewrap（bwrap），仅做静态检查。可安装：sudo apt install bubblewrap',
      networkIsolation: false,
    };
  }
  if (platform === 'darwin') {
    return {
      platform: normalized,
      available: false,
      engine: '',
      message: '未检测到 sandbox-exec，仅做静态检查。',
      networkIsolation: false,
    };
  }
  return {
    platform: normalized,
    available: false,
    engine: '',
    message: '当前平台仅做静态检查。',
    networkIsolation: false,
  };
}

export function sandboxStatus(settings: SandboxSettings, platform: NodeJS.Platform = process.platform): SandboxStatus {
  return {
    platform: platformStatus(platform),
    settings: normalizeSandboxSettings(settings),
    packageSources: PACKAGE_SOURCES.map((source) => ({ ...source, hosts: [...source.hosts] })),
  };
}

export interface SandboxProfile {
  engine: 'bwrap' | 'sandbox-exec';
  binary: string;
  network: 'host' | 'none';
}

/** 当前设置下可用的沙箱配置；未启用或引擎不可用时返回 undefined。 */
export function sandboxProfile(
  settings: SandboxSettings,
  allowNetwork = false,
  platform: NodeJS.Platform = process.platform,
): SandboxProfile | undefined {
  const normalized = normalizeSandboxSettings(settings);
  if (!normalized.enabled) return undefined;
  const engine = detectSandboxEngine(platform);
  if (!engine) return undefined;
  return {
    ...engine,
    network: normalized.network === 'none' && !allowNetwork ? 'none' : 'host',
  };
}

function tempDirs(platform: NodeJS.Platform = process.platform): string[] {
  const list = [os.tmpdir()];
  if (platform === 'linux') list.push('/tmp', '/var/tmp');
  if (platform === 'darwin') list.push('/tmp', '/private/tmp', '/private/var/folders');
  if (platform === 'win32') {
    for (const key of ['TEMP', 'TMP']) {
      const value = process.env[key];
      if (value) list.push(value);
    }
  }
  const out: string[] = [];
  for (const item of list) {
    if (!item) continue;
    const resolved = path.resolve(item);
    if (!out.includes(resolved) && existsSync(resolved)) out.push(resolved);
  }
  return out;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function uniquePaths(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const value = path.resolve(item);
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

export interface SandboxEvalContext {
  settings: SandboxSettings;
  cwd: string;
  /** worktree 会话额外可写的根目录。 */
  worktreePath?: string;
  home?: string;
  tandemHome?: string;
  platform?: NodeJS.Platform;
}

export interface SandboxNetworkTarget {
  tool: string;
  host: string;
  raw: string;
  allowed: boolean;
}

export interface SandboxEvaluation {
  /** 按严重程度排序：受保护路径 → 非白名单主机 → 工作目录外写入 → 严格模式未知写入。 */
  notices: PermissionSandboxNotice[];
  protectedWrite?: { path: string; label: string };
  outsideWrite?: string;
  unknownWrite: boolean;
  network: SandboxNetworkTarget[];
  unknownNetwork: boolean;
  hasNetwork: boolean;
}

interface AnalyzeState {
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  api: path.PlatformPath;
  writes: Array<{ path?: string; raw: string; unknown?: boolean }>;
  unknownWrite: boolean;
  network: Array<{ tool: string; host: string; raw: string }>;
  unknownNetwork: boolean;
  hasNetwork: boolean;
}

/** 工具调用是否写工作目录之外/受保护路径/非白名单网络；用于权限判定与审批卡说明。 */
export function evaluateSandbox(toolName: string, input: unknown, ctx: SandboxEvalContext): SandboxEvaluation {
  const platform = ctx.platform ?? process.platform;
  const api = pathApi(platform);
  const settings = normalizeSandboxSettings(ctx.settings);
  const home = ctx.home ?? os.homedir();
  const tandemHome = ctx.tandemHome ?? path.join(home, '.tandem');
  const cwd = api.resolve(ctx.cwd);
  const roots = uniquePaths([
    cwd,
    ...(ctx.worktreePath ? [api.resolve(ctx.worktreePath)] : []),
    ...tempDirs(platform),
  ]);
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const notices: PermissionSandboxNotice[] = [];
  let protectedWrite: SandboxEvaluation['protectedWrite'];
  let outsideWrite: string | undefined;
  let unknownWrite = false;
  const network: SandboxNetworkTarget[] = [];
  let unknownNetwork = false;
  let hasNetwork = false;

  if (toolName === 'Write' || toolName === 'Edit') {
    const raw = typeof args.file_path === 'string' ? args.file_path.trim() : '';
    if (raw) {
      const expanded =
        raw === '~' ? home : raw.startsWith('~/') || raw.startsWith('~\\') ? api.join(home, raw.slice(2)) : raw;
      const abs = api.resolve(cwd, expanded);
      const label = protectedPathReason(abs, { home, tandemHome, platform });
      if (label) protectedWrite = { path: abs, label };
      else if (!roots.some((root) => isSubPath(root, abs))) outsideWrite = abs;
    }
  } else if (toolName === 'Bash') {
    const command = typeof args.command === 'string' ? args.command : '';
    const analysis = analyzeBash(command, cwd, { home, platform, tandemHome });
    unknownWrite = analysis.unknownWrite;
    hasNetwork = analysis.hasNetwork;
    unknownNetwork = analysis.unknownNetwork;
    for (const item of analysis.writes) {
      const target = item.path;
      if (!target) continue;
      const label = protectedPathReason(target, { home, tandemHome, platform });
      if (label && !protectedWrite) protectedWrite = { path: target, label };
      if (!label && !outsideWrite && !roots.some((root) => isSubPath(root, target))) {
        outsideWrite = target;
      }
    }
    for (const item of analysis.network) {
      network.push({ ...item, allowed: hostAllowed(item.host, settings.allowedHosts) });
    }
  }

  const blockedHosts = [...new Set(network.filter((item) => !item.allowed).map((item) => item.host))];
  if (protectedWrite) {
    notices.push({
      kind: 'protected',
      reason: `受保护路径，写入需要审批：${protectedWrite.path}（${protectedWrite.label}）`,
      target: protectedWrite.path,
    });
  }
  if (blockedHosts.length) {
    notices.push({
      kind: 'network',
      reason: `目标主机不在网络白名单：${blockedHosts.join('、')}`,
      target: blockedHosts[0],
      hosts: blockedHosts,
    });
  }
  if (outsideWrite) {
    notices.push({
      kind: 'write-outside',
      reason: `将写入工作目录之外：${outsideWrite}`,
      target: outsideWrite,
    });
  }
  if (settings.strict && unknownWrite) {
    notices.push({
      kind: 'unknown-write',
      reason: '严格模式：无法静态判断该命令的写入范围',
    });
  }
  if (settings.strict && unknownNetwork && !blockedHosts.length) {
    notices.push({
      kind: 'network',
      reason: '严格模式：无法静态判断联网目标',
    });
  }

  return {
    notices,
    protectedWrite,
    outsideWrite,
    unknownWrite,
    network,
    unknownNetwork,
    hasNetwork,
  };
}

const PROTECTED_HOME_DIRS: Array<{ rel: string; label: string }> = [
  { rel: '.ssh', label: 'SSH 配置与密钥' },
  { rel: '.aws', label: 'AWS 凭据' },
  { rel: '.gnupg', label: 'GPG 密钥' },
  { rel: '.tandem', label: 'Tandem 配置' },
  { rel: '.claude', label: 'Claude Code 配置（只读）' },
  { rel: '.codex', label: 'Codex 配置（只读）' },
];

const POSIX_SYSTEM_DIRS = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/var/lib',
  '/var/spool',
  '/System',
  '/Library',
  '/Applications',
  '/private/etc',
];

const LINUX_PACKAGE_DIRS = ['/var/lib', '/usr/local/bin', '/usr/local/lib'];

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

/** 受保护路径：敏感配置、系统目录、项目 .git/hooks 与 .env*；返回中文原因。 */
export function protectedPathReason(
  abs: string,
  opts: { home: string; tandemHome: string; platform?: NodeJS.Platform },
): string | undefined {
  const platform = opts.platform ?? process.platform;
  const api = pathApi(platform);
  const target = api.resolve(abs);
  const normalized = normalizeSlashes(target);
  const lower = platform === 'win32' ? normalized.toLowerCase() : normalized;

  const homeDirs: Array<{ dir: string; label: string }> = [
    ...PROTECTED_HOME_DIRS.map((item) => ({ dir: path.join(opts.home, item.rel), label: item.label })),
    { dir: opts.tandemHome, label: 'Tandem 配置' },
  ];
  for (const item of homeDirs) {
    if (isSubPath(api.resolve(item.dir), target)) return item.label;
  }

  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    for (const dir of [systemRoot, programFiles, programFilesX86, programData]) {
      if (isSubPath(api.resolve(dir), target)) return '系统目录';
    }
  } else {
    const systemDirs = platform === 'linux' ? [...POSIX_SYSTEM_DIRS, ...LINUX_PACKAGE_DIRS] : POSIX_SYSTEM_DIRS;
    for (const dir of systemDirs) {
      if (isSubPath(api.resolve(dir), target)) return '系统目录';
    }
  }

  if (/(^|\/)\.git\/hooks(\/|$)/.test(lower)) return 'Git hooks';
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (/^\.env/i.test(base)) return '.env 文件';
  return undefined;
}

function isSpecialTarget(abs: string, platform: NodeJS.Platform): boolean {
  const normalized = normalizeSlashes(abs);
  const lower = platform === 'win32' ? normalized.toLowerCase() : normalized;
  if (['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'].includes(lower)) return true;
  if (/^\/dev\/fd\/\d+$/.test(lower)) return true;
  if (/^\/proc\/(self|\d+)\/fd\/\d+$/.test(lower)) return true;
  if (/^(nul|con)$/i.test(lower)) return true;
  return false;
}

function resolveWriteTarget(
  raw: string,
  base: string | undefined,
  state: AnalyzeState,
): { path?: string; unknown?: boolean } {
  let value = raw.trim();
  if (!value || value === '-') return {};
  if (/^&\d+$/.test(value)) return {};
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return {}; // URL，不是本地路径
  if (/^&\d+$/.test(value)) return {};
  if (value.includes('$')) {
    if (/\$(HOME|\{HOME\})/.test(value)) {
      value = value.replace(/\$\{HOME\}/g, state.home).replace(/\$HOME/g, state.home);
    }
    if (value.includes('$')) return { unknown: true };
  }
  if (value.startsWith('~')) {
    if (!/^~(\/|$)/.test(value) && !/^~[\\/]/.test(value)) return { unknown: true };
    value = value === '~' ? state.home : state.api.join(state.home, value.slice(2));
  }
  if (!base) return { unknown: true };
  if (/[*?[]/.test(value)) return { unknown: true };
  if (value.includes('`') || value.includes('$(')) return { unknown: true };
  const abs = state.api.isAbsolute(value) ? state.api.normalize(value) : state.api.resolve(base, value);
  if (isSpecialTarget(abs, state.platform)) return {};
  return { path: abs };
}

type Token = { kind: 'word'; value: string; dynamic: boolean } | { kind: 'op'; op: string };

const SEPARATORS = new Set(['|', '||', '&&', ';', '\n', '&', '(', ')', '{', '}']);

function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let atWordStart = true;
  while (i < command.length) {
    const ch = command[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      atWordStart = true;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      const two = command.slice(i, i + 2);
      let op = ch;
      if (two === '&&' || two === '||' || two === '&>') {
        op = two;
        i++;
      }
      if (ch === '&' && command.slice(i, i + 2) === '>>') {
        op = '&>>';
        i++;
      }
      i++;
      tokens.push({ kind: 'op', op });
      atWordStart = true;
      continue;
    }
    if (ch === '>' || ch === '<') {
      let op = ch;
      const next = command[i + 1];
      if (next === '>' || next === '|' || next === '=' || next === '&') {
        op = ch + next;
        i++;
      }
      if (op === '<<' && command[i + 1] === '<') {
        op = '<<<';
        i++;
      }
      i++;
      tokens.push({ kind: 'op', op });
      atWordStart = true;
      continue;
    }
    if (ch === '#' && atWordStart) {
      while (i < command.length && command[i] !== '\n') i++;
      continue;
    }
    atWordStart = false;
    let value = '';
    let dynamic = false;
    while (i < command.length) {
      const c = command[i] ?? '';
      if (/\s/.test(c) || c === ';' || c === '|' || c === '&' || c === '>' || c === '<' || c === '(' || c === ')') {
        break;
      }
      if (c === "'") {
        i++;
        while (i < command.length && command[i] !== "'") {
          value += command[i];
          i++;
        }
        i++;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < command.length && command[i] !== '"') {
          const q = command[i] ?? '';
          if (q === '\\' && i + 1 < command.length) {
            value += command[i + 1];
            i += 2;
            continue;
          }
          if (q === '`' || (q === '$' && command[i + 1] === '(')) dynamic = true;
          value += q;
          i++;
        }
        i++;
        continue;
      }
      if (c === '\\' && i + 1 < command.length) {
        value += command[i + 1];
        i += 2;
        continue;
      }
      if (c === '`' || (c === '$' && command[i + 1] === '(')) dynamic = true;
      value += c;
      i++;
    }
    if (value.includes('$(') || value.includes('`')) dynamic = true;
    tokens.push({ kind: 'word', value, dynamic });
  }
  return tokens;
}

function splitSegments(tokens: Token[]): Token[][] {
  const segments: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'op' && SEPARATORS.has(token.op)) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length) segments.push(current);
  return segments;
}

function basenameOf(value: string): string {
  const normalized = normalizeSlashes(value);
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

function isWord(token: Token | undefined): token is Extract<Token, { kind: 'word' }> {
  return token?.kind === 'word';
}

/** 常见带值选项：返回该选项是否吞掉下一个参数。 */
function optionTakesValue(cmd: string, arg: string): boolean {
  const valueOptions: Record<string, string[]> = {
    cp: ['-t', '--target-directory', '-S', '--suffix', '--backup'],
    mv: ['-t', '--target-directory', '-S', '--suffix'],
    install: ['-t', '--target-directory', '-m', '--mode', '-o', '--owner', '-g', '--group'],
    ln: ['-t', '--target-directory', '-S', '--suffix'],
    rsync: ['-e', '--rsh', '--exclude', '--include', '--filter', '-T', '--temp-dir', '--partial-dir'],
    mkdir: ['-m', '--mode'],
    touch: ['-d', '--date', '-r', '--reference', '-t'],
    sed: ['-e', '--expression', '-f', '--file', '-l', '--line-length'],
    tar: ['-f', '--file', '-C', '--directory', '-X', '--exclude-from', '--transform'],
    unzip: ['-d', '-x'],
    curl: ['-o', '--output', '-H', '--header', '-d', '--data', '-X', '--request', '-u', '--user', '-x', '--proxy', '-A', '--user-agent'],
    wget: ['-O', '--output-document', '-P', '--directory-prefix', '--header', '-e', '--execute'],
    ssh: ['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D'],
    scp: ['-P', '-i', '-o', '-F', '-J', '-S'],
    sftp: ['-P', '-i', '-o', '-F', '-S'],
    nc: ['-p', '-s', '-w', '-i', '-X', '-x', '-O'],
    ncat: ['-p', '-s', '-w', '-i', '-X', '-x', '-O'],
    dig: ['@', '-p', '-t', '-c', '-b', '-f'],
    ping: ['-c', '-i', '-W', '-w', '-s', '-t', '-I'],
    rsync_remote: [],
    git: [
      '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path',
      '--depth', '--branch', '-b', '--origin', '-o', '--config',
      '--reference', '--separate-git-dir', '--template', '--jobs', '-j',
      '--upload-pack', '--filter', '--shallow-since', '--shallow-exclude',
    ],
    npm: ['--registry', '--prefix', '--cache', '--userconfig'],
    pnpm: ['--registry', '--prefix', '--cache', '--dir'],
    yarn: ['--registry', '--cwd', '--cache-folder'],
    pip: ['-i', '--index-url', '--extra-index-url', '-r', '--requirement', '-c', '--constraint', '-t', '--target', '--prefix', '--root'],
    pip3: ['-i', '--index-url', '--extra-index-url', '-r', '--requirement', '-c', '--constraint', '-t', '--target', '--prefix', '--root'],
    cargo: ['--registry', '--manifest-path', '-Z'],
    go: ['-C', '-modfile'],
    gem: ['-v', '--version', '-i', '--install-dir', '-n', '--bindir'],
    brew: ['--prefix'],
    docker: ['-H', '--host', '--context', '--config'],
    gh: ['-R', '--repo', '--hostname'],
    apt: ['-o', '-t', '--target-release'],
    'apt-get': ['-o', '-t', '--target-release'],
    zip: ['-b', '-n', '-t', '-x', '-P'],
  };
  return (valueOptions[cmd] ?? []).some((item) => arg === item || arg.startsWith(`${item}=`));
}

interface ParsedCommand {
  cmd: string;
  args: string[];
}

function parseCommand(words: Extract<Token, { kind: 'word' }>[]): ParsedCommand | undefined {
  let index = 0;
  while (index < words.length) {
    const value = words[index]?.value ?? '';
    if (!value) {
      index++;
      continue;
    }
    if (/^[A-Za-z_][\w]*=/.test(value) || /^\d+$/.test(value)) {
      index++;
      continue;
    }
    if (value === 'sudo' || value === 'doas' || value === 'command' || value === 'builtin' || value === 'nohup' || value === 'time') {
      index++;
      while (index < words.length && (words[index]?.value ?? '').startsWith('-')) {
        const option = words[index]?.value ?? '';
        index++;
        if ((value === 'sudo' || value === 'doas') && ['-u', '-g', '-U', '-p', '-C', '-h'].includes(option)) index++;
      }
      continue;
    }
    if (value === 'env') {
      index++;
      while (index < words.length) {
        const item = words[index]?.value ?? '';
        if (/^[A-Za-z_][\w]*=/.test(item) || item === '-i' || item === '--ignore-environment') {
          index++;
          continue;
        }
        if (item.startsWith('-')) {
          index++;
          continue;
        }
        break;
      }
      continue;
    }
    if (value === 'timeout') {
      index++;
      while (index < words.length && (words[index]?.value ?? '').startsWith('-')) {
        const option = words[index]?.value ?? '';
        index++;
        if (['-s', '--signal', '-k', '--kill-after'].includes(option)) index++;
      }
      index++; // duration
      continue;
    }
    break;
  }
  const cmd = words[index]?.value;
  if (!cmd) return undefined;
  return { cmd: basenameOf(cmd), args: words.slice(index + 1).map((word) => word.value) };
}

function nonOptionArgs(args: string[], cmd: string): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === '--') continue;
    if (arg.startsWith('-') && arg !== '-') {
      if (optionTakesValue(cmd, arg)) skipNext = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function isRemotePath(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  return /^[^/\\\s:]+:[^/\\]/.test(value);
}

function pushWrite(state: AnalyzeState, raw: string, base = state.cwd): void {
  if (!raw) return;
  const resolved = resolveWriteTarget(raw, base, state);
  if (resolved.unknown) state.unknownWrite = true;
  if (resolved.path) state.writes.push({ path: resolved.path, raw });
}

function pushNetwork(state: AnalyzeState, tool: string, host: string, raw: string): void {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return;
  state.hasNetwork = true;
  const existing = state.network.find((item) => item.host === value && item.tool === tool);
  if (!existing) state.network.push({ tool, host: value, raw });
}

function hostFromValue(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return url.hostname.replace(/^\[|\]$/g, '');
    } catch {
      return undefined;
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(text)) return undefined;
  const scp = text.match(/^(?:[^@\s]+@)?([^:/\s]+):/);
  if (scp?.[1] && !scp[1].includes('$')) return scp[1];
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return text;
  return undefined;
}

function gitDirOf(state: AnalyzeState, args: string[]): { dir: string; rest: string[] } {
  let dir = state.cwd;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '-C' || arg === '--git-dir') {
      const value = args[i + 1];
      i++;
      if (!value) continue;
      if (arg === '-C') {
        const resolved = resolveWriteTarget(value, state.cwd, state);
        if (resolved.path) dir = resolved.path;
        else state.unknownWrite = true;
      }
      continue;
    }
    if (arg === '-c' || arg === '--work-tree' || arg === '--namespace' || arg === '--exec-path') {
      i++;
      continue;
    }
    rest.push(arg);
  }
  return { dir, rest };
}

function gitRemoteFromConfig(dir: string, remote: string): string | undefined {
  let current = dir;
  for (let depth = 0; depth < 12; depth++) {
    try {
      const dotgit = path.join(current, '.git');
      let configPath: string | undefined;
      if (existsSync(dotgit) && statSync(dotgit).isDirectory()) configPath = path.join(dotgit, 'config');
      else if (existsSync(dotgit) && statSync(dotgit).isFile()) {
        const text = readFileSync(dotgit, 'utf8');
        const match = text.match(/^gitdir:\s*(.+)$/m);
        if (match?.[1]) configPath = path.join(path.resolve(current, match[1].trim()), 'config');
      }
      if (configPath && existsSync(configPath)) {
        const text = readFileSync(configPath, 'utf8');
        const blocks = text.split(/^\[/m);
        const wanted = blocks.find((block) => block.toLowerCase().startsWith(`remote "${remote.toLowerCase()}"`));
        const block = wanted ?? blocks.find((item) => item.toLowerCase().startsWith('remote "'));
        const url = block?.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
        if (url) return hostFromValue(url);
      }
    } catch {
      // 读不到就按未知处理
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

const GIT_WRITE_COMMANDS = new Set([
  'add', 'am', 'apply', 'bisect', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit',
  'config', 'fetch', 'filter-branch', 'gc', 'merge', 'mv', 'notes', 'prune', 'pull', 'rebase',
  'repack', 'reset', 'restore', 'revert', 'rm', 'stash', 'submodule', 'switch', 'tag',
  'update-ref', 'worktree',
]);

function analyzeGit(state: AnalyzeState, args: string[], gitCwd: string): void {
  const { dir, rest } = gitDirOf(state, args);
  const subIndex = rest.findIndex((arg) => !arg.startsWith('-'));
  const sub = rest[subIndex]?.toLowerCase() ?? '';
  const subArgs = subIndex >= 0 ? rest.slice(subIndex + 1) : [];
  const writeBase = dir || state.cwd;
  const writeOk = rest.length > 0;

  if (sub === 'clone') {
    const positional = nonOptionArgs(subArgs, 'git');
    const url = positional[0];
    const host = url ? hostFromValue(url) : undefined;
    if (host) pushNetwork(state, 'git clone', host, url ?? '');
    const dest = positional[1];
    if (dest) pushWrite(state, dest, writeBase);
    else if (url) {
      const cleaned = url.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/i, '');
      if (cleaned) pushWrite(state, cleaned, writeBase);
    }
    return;
  }
  if (['fetch', 'pull', 'push', 'ls-remote', 'submodule', 'remote'].includes(sub)) {
    if (['fetch', 'pull', 'push', 'ls-remote', 'submodule'].includes(sub)) state.hasNetwork = true;
    const positional = nonOptionArgs(subArgs, 'git');
    let host: string | undefined;
    let raw = '';
    for (const item of positional) {
      const parsed = hostFromValue(item);
      if (parsed) {
        host = parsed;
        raw = item;
        break;
      }
    }
    if (!host && ['fetch', 'pull', 'push', 'ls-remote', 'submodule'].includes(sub)) {
      const remote = positional[0] || 'origin';
      const remoteName = remote.includes('/') ? remote.split('/')[0] ?? remote : remote;
      host = gitRemoteFromConfig(writeBase, remoteName) ?? gitRemoteFromConfig(writeBase, 'origin');
      raw = remote;
    }
    if (host) pushNetwork(state, `git ${sub}`, host, raw);
    else if (sub !== 'remote') state.unknownNetwork = true;
    if (sub !== 'ls-remote' && sub !== 'remote') pushWrite(state, writeBase, writeBase);
    return;
  }
  if (sub === 'init') {
    const positional = nonOptionArgs(subArgs, 'git');
    pushWrite(state, positional[0] || writeBase, writeBase);
    return;
  }
  if (sub === 'worktree') {
    const action = subArgs.find((arg) => !arg.startsWith('-'))?.toLowerCase();
    if (action === 'add') {
      const positional = nonOptionArgs(subArgs, 'git').slice(1);
      if (positional[0]) pushWrite(state, positional[0], writeBase);
    }
    return;
  }
  if (sub === 'config') {
    const global = subArgs.some((arg) => arg === '--global' || arg === '--system');
    pushWrite(state, global ? path.join(state.home, '.gitconfig') : path.join(writeBase, '.git', 'config'), writeBase);
    return;
  }
  if (writeOk && GIT_WRITE_COMMANDS.has(sub)) {
    pushWrite(state, writeBase, writeBase);
  }
}

function analyzeBashSegment(tokens: Token[], state: AnalyzeState): void {
  const words: Extract<Token, { kind: 'word' }>[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token.kind === 'op') {
      if (['>&', '<&'].includes(token.op)) {
        i++;
        continue;
      }
      if (['>', '>>', '>|', '&>', '&>>'].includes(token.op)) {
        const next = tokens[i + 1];
        i++;
        if (isWord(next)) {
          if (/^&\d+$/.test(next.value)) continue;
          pushWrite(state, next.value);
        } else {
          state.unknownWrite = true;
        }
      } else if (['<', '<<', '<<<', '<>'].includes(token.op)) {
        if (token.op === '<<') state.unknownWrite = true;
        i++;
      }
      continue;
    }
    words.push(token);
  }

  const parsed = parseCommand(words);
  if (!parsed) return;
  const { cmd, args } = parsed;
  if (!cmd) return;
  const positional = nonOptionArgs(args, cmd);

  switch (cmd) {
    case 'cd': {
      const target = positional[0];
      if (!target || target === '-') {
        state.unknownWrite = true;
        break;
      }
      const resolved = resolveWriteTarget(target, state.cwd, state);
      if (resolved.path) state.cwd = resolved.path;
      else state.unknownWrite = true;
      break;
    }
    case 'pushd':
    case 'popd':
      state.unknownWrite = true;
      break;
    case 'cp':
    case 'mv':
    case 'install':
    case 'ln': {
      let dest: string | undefined;
      const targetIndex = args.findIndex((arg) => arg === '-t' || arg === '--target-directory');
      if (targetIndex >= 0) dest = args[targetIndex + 1];
      else if (args.some((arg) => arg.startsWith('--target-directory='))) {
        dest = args.find((arg) => arg.startsWith('--target-directory='))?.split('=')[1];
      } else dest = positional[positional.length - 1];
      if (dest && positional.length >= 2) pushWrite(state, dest);
      else if (cmd === 'install' && dest && positional.length === 1) pushWrite(state, dest);
      break;
    }
    case 'rm':
    case 'rmdir':
    case 'mkdir':
    case 'touch':
    case 'truncate':
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      const targets = cmd === 'chmod' || cmd === 'chown' || cmd === 'chgrp' ? positional.slice(1) : positional;
      for (const target of targets) pushWrite(state, target);
      break;
    }
    case 'tee': {
      for (const target of positional) pushWrite(state, target);
      break;
    }
    case 'sed': {
      const inPlace = args.some((arg) => arg === '--in-place' || /^-i/.test(arg));
      if (!inPlace) break;
      let scriptConsumed = args.some((arg) => arg === '-e' || arg === '--expression' || arg === '-f' || arg === '--file');
      let skipNext = false;
      for (const arg of args) {
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (arg.startsWith('-')) {
          if (optionTakesValue(cmd, arg)) skipNext = true;
          continue;
        }
        if (!scriptConsumed) {
          scriptConsumed = true;
          continue;
        }
        pushWrite(state, arg);
      }
      break;
    }
    case 'dd': {
      for (const arg of args) {
        if (arg.startsWith('of=')) pushWrite(state, arg.slice(3));
      }
      break;
    }
    case 'tar': {
      const dirIndex = args.findIndex((arg) => arg === '-C' || arg === '--directory');
      const dir = dirIndex >= 0 ? args[dirIndex + 1] : undefined;
      const fileIndex = args.findIndex((arg) => arg === '-f' || arg === '--file');
      const file = fileIndex >= 0 ? args[fileIndex + 1] : args.find((arg) => /^--file=/.test(arg))?.split('=')[1];
      const create = args.some((arg) => arg === '-c' || /^-[a-zA-Z]*c/.test(arg) || arg === '--create');
      if (dir) pushWrite(state, dir);
      if (file && create) pushWrite(state, file, dir ? resolveWriteTarget(dir, state.cwd, state).path : state.cwd);
      break;
    }
    case 'unzip': {
      const index = args.findIndex((arg) => arg === '-d');
      if (index >= 0 && args[index + 1]) pushWrite(state, args[index + 1] ?? '');
      else pushWrite(state, state.cwd, state.cwd);
      break;
    }
    case 'zip': {
      const output = positional[0];
      if (output) pushWrite(state, output);
      break;
    }
    case 'curl': {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? '';
        if (arg === '-o' || arg === '--output' || arg === '-P' || arg === '--output-dir') {
          pushWrite(state, args[i + 1] ?? '');
          i++;
          continue;
        }
        if (arg.startsWith('--output=')) pushWrite(state, arg.split('=')[1] ?? '');
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
          const host = hostFromValue(arg);
          if (host) pushNetwork(state, 'curl', host, arg);
        }
      }
      state.hasNetwork = state.hasNetwork || args.some((arg) => /^[a-z][a-z0-9+.-]*:\/\//i.test(arg));
      break;
    }
    case 'wget': {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? '';
        if (arg === '-O' || arg === '--output-document' || arg === '-P' || arg === '--directory-prefix') {
          pushWrite(state, args[i + 1] ?? '');
          i++;
          continue;
        }
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
          const host = hostFromValue(arg);
          if (host) pushNetwork(state, 'wget', host, arg);
        }
      }
      state.hasNetwork = state.hasNetwork || args.some((arg) => /^[a-z][a-z0-9+.-]*:\/\//i.test(arg));
      break;
    }
    case 'git':
      analyzeGit(state, args, state.cwd);
      break;
    case 'npm':
    case 'pnpm':
    case 'yarn': {
      const sub = positional[0]?.toLowerCase() ?? '';
      if (['install', 'i', 'add', 'ci', 'update', 'upgrade', 'publish', 'view', 'info', 'pack'].includes(sub)) {
        let host = cmd === 'yarn' ? 'registry.yarnpkg.com' : 'registry.npmjs.org';
        const registryIndex = args.findIndex((arg) => arg === '--registry');
        const registry = registryIndex >= 0 ? args[registryIndex + 1] : args.find((arg) => arg.startsWith('--registry='))?.split('=')[1];
        const parsed = registry ? hostFromValue(registry) : undefined;
        if (parsed) host = parsed;
        pushNetwork(state, `${cmd} ${sub}`, host, registry ?? '');
      }
      break;
    }
    case 'npx':
    case 'pnpmx': {
      pushNetwork(state, cmd, 'registry.npmjs.org', positional[0] ?? '');
      break;
    }
    case 'pip':
    case 'pip3': {
      const sub = positional[0]?.toLowerCase() ?? '';
      if (['install', 'download'].includes(sub)) {
        const indexIndex = args.findIndex((arg) => arg === '-i' || arg === '--index-url');
        const index = indexIndex >= 0 ? args[indexIndex + 1] : args.find((arg) => arg.startsWith('--index-url='))?.split('=')[1];
        const parsed = index ? hostFromValue(index) : undefined;
        if (parsed) pushNetwork(state, `${cmd} ${sub}`, parsed, index ?? '');
        else {
          pushNetwork(state, `${cmd} ${sub}`, 'pypi.org', '');
          pushNetwork(state, `${cmd} ${sub}`, 'files.pythonhosted.org', '');
        }
      }
      break;
    }
    case 'ssh': {
      state.hasNetwork = true;
      const hostValue = positional[0];
      if (hostValue) {
        const host = hostFromValue(hostValue) ?? hostValue.split('@').pop();
        if (host) pushNetwork(state, 'ssh', host, hostValue);
      }
      break;
    }
    case 'scp':
    case 'sftp': {
      state.hasNetwork = true;
      for (const arg of positional) {
        if (isRemotePath(arg)) {
          const host = hostFromValue(arg);
          if (host) pushNetwork(state, cmd, host, arg);
        } else if (cmd === 'scp' && arg === positional[positional.length - 1]) {
          pushWrite(state, arg);
        }
      }
      break;
    }
    case 'nc':
    case 'ncat': {
      const listen = args.some((arg) => arg === '-l' || arg === '--listen');
      if (!listen) state.hasNetwork = true;
      if (!listen && positional[0]) {
        const host = hostFromValue(positional[0]) ?? positional[0];
        if (host) pushNetwork(state, cmd, host, positional[0]);
      }
      break;
    }
    case 'telnet':
    case 'ftp':
    case 'ping':
    case 'traceroute':
    case 'mtr':
    case 'dig':
    case 'nslookup':
    case 'host': {
      state.hasNetwork = true;
      const hostValue = positional.find((arg) => hostFromValue(arg));
      if (hostValue) {
        const host = hostFromValue(hostValue) ?? hostValue;
        pushNetwork(state, cmd, host, hostValue);
      } else if (positional[0]) {
        pushNetwork(state, cmd, positional[0].replace(/^@/, ''), positional[0]);
      }
      break;
    }
    case 'rsync': {
      for (const arg of positional) {
        if (isRemotePath(arg)) {
          const host = hostFromValue(arg);
          if (host) pushNetwork(state, 'rsync', host, arg);
        }
      }
      const dest = positional[positional.length - 1];
      if (dest && !isRemotePath(dest)) pushWrite(state, dest);
      if (positional.some((arg) => isRemotePath(arg))) state.hasNetwork = true;
      break;
    }
    case 'docker': {
      const sub = positional[0]?.toLowerCase() ?? '';
      if (['pull', 'push', 'login', 'search'].includes(sub)) {
        const image = positional[1] ?? '';
        const registry = image && image.includes('.') ? image.split('/')[0] : 'docker.io';
        if (registry) pushNetwork(state, `docker ${sub}`, registry, image);
      }
      break;
    }
    case 'cargo': {
      const sub = positional[0]?.toLowerCase() ?? '';
      if (['install', 'fetch', 'update', 'publish'].includes(sub)) {
        pushNetwork(state, `cargo ${sub}`, 'crates.io', '');
        pushNetwork(state, `cargo ${sub}`, 'static.crates.io', '');
      }
      break;
    }
    case 'go': {
      const sub = positional[0]?.toLowerCase() ?? '';
      if (['get', 'install'].includes(sub) || (sub === 'mod' && positional[1] === 'download')) {
        pushNetwork(state, `go ${sub}`, 'proxy.golang.org', '');
        pushNetwork(state, `go ${sub}`, 'sum.golang.org', '');
      }
      break;
    }
    case 'gem': {
      const sub = positional[0]?.toLowerCase() ?? '';
      if (['install', 'fetch', 'push'].includes(sub)) pushNetwork(state, `gem ${sub}`, 'rubygems.org', '');
      break;
    }
    case 'brew': {
      const sub = positional[0]?.toLowerCase() ?? '';
      if (['install', 'update', 'upgrade', 'tap', 'fetch'].includes(sub)) {
        pushNetwork(state, `brew ${sub}`, 'formulae.brew.sh', '');
        pushNetwork(state, `brew ${sub}`, 'github.com', '');
      }
      break;
    }
    case 'apt':
    case 'apt-get': {
      const sub = positional[0]?.toLowerCase() ?? '';
      if (['install', 'update', 'upgrade', 'dist-upgrade'].includes(sub)) {
        pushNetwork(state, `${cmd} ${sub}`, 'archive.ubuntu.com', '');
        pushNetwork(state, `${cmd} ${sub}`, 'security.ubuntu.com', '');
        pushNetwork(state, `${cmd} ${sub}`, 'deb.debian.org', '');
      }
      break;
    }
    case 'gh': {
      pushNetwork(state, 'gh', 'api.github.com', '');
      pushNetwork(state, 'gh', 'github.com', '');
      break;
    }
    case 'find': {
      if (args.some((arg) => ['-exec', '-execdir', '-ok', '-okdir'].includes(arg))) {
        state.unknownWrite = true;
      }
      if (args.includes('-delete')) {
        for (const arg of positional) pushWrite(state, arg);
      }
      break;
    }
    case 'xargs':
    case 'eval':
      state.unknownWrite = true;
      break;
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'fish':
    case 'dash': {
      if (args.some((arg) => arg === '-c' || arg.startsWith('-c'))) state.unknownWrite = true;
      else if (positional[0]) state.unknownWrite = true;
      break;
    }
    case 'node':
    case 'python':
    case 'python3':
    case 'perl':
    case 'ruby':
    case 'php': {
      if (args.some((arg) => ['-e', '-c', '--eval', '--exec'].includes(arg))) state.unknownWrite = true;
      else if (positional[0]) state.unknownWrite = true;
      break;
    }
    case 'make':
    case 'cmake':
    case 'ninja':
    case 'gradle':
    case 'mvn':
    case 'tsc':
    case 'vite':
    case 'webpack':
    case 'next':
      state.unknownWrite = true;
      break;
    default:
      break;
  }
}

export interface BashAnalysis {
  writes: Array<{ path?: string; raw: string }>;
  unknownWrite: boolean;
  network: Array<{ tool: string; host: string; raw: string }>;
  unknownNetwork: boolean;
  hasNetwork: boolean;
}

/** 解析 Bash 命令里常见写入形式与联网工具（启发式；无法判断的标记 unknownWrite）。 */
export function analyzeBash(
  command: string,
  cwd: string,
  opts: { home?: string; tandemHome?: string; platform?: NodeJS.Platform } = {},
): BashAnalysis {
  const platform = opts.platform ?? process.platform;
  const state: AnalyzeState = {
    cwd: pathApi(platform).resolve(cwd),
    home: opts.home ?? os.homedir(),
    platform,
    api: pathApi(platform),
    writes: [],
    unknownWrite: false,
    network: [],
    unknownNetwork: false,
    hasNetwork: false,
  };
  for (const segment of splitSegments(tokenize(command))) analyzeBashSegment(segment, state);
  return {
    writes: state.writes,
    unknownWrite: state.unknownWrite,
    network: state.network,
    unknownNetwork: state.unknownNetwork,
    hasNetwork: state.hasNetwork,
  };
}

function ipv4ToInt(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

function ipv4InCidr(host: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const hostInt = ipv4ToInt(host);
  const baseInt = ipv4ToInt(base ?? '');
  if (hostInt === undefined || baseInt === undefined) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (hostInt & mask) === (baseInt & mask);
}

function ipv6Groups(value: string): number[] | undefined {
  let text = value.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(':')) return undefined;
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!group) return [];
      const n = Number.parseInt(group, 16);
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error('bad');
      out.push(n);
    }
    return out;
  };
  try {
    const head = parse(halves[0] ?? '');
    const tail = parse(halves[1] ?? '');
    const missing = 8 - head.length - tail.length;
    if (halves.length === 1 && head.length !== 8) return undefined;
    if (halves.length === 2 && missing < 1) return undefined;
    return [...head, ...Array(Math.max(0, missing)).fill(0), ...tail];
  } catch {
    return undefined;
  }
}

function ipv6InCidr(host: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  const hostGroups = ipv6Groups(host);
  const baseGroups = ipv6Groups(base ?? '');
  if (!hostGroups || !baseGroups) return false;
  let remaining = bits;
  for (let i = 0; i < 8; i++) {
    if (remaining <= 0) return true;
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : ((0xffff << (16 - take)) & 0xffff);
    if (((hostGroups[i] ?? 0) & mask) !== ((baseGroups[i] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

function isLoopbackHost(host: string): boolean {
  const value = host.toLowerCase();
  return (
    value === 'localhost' ||
    value === '::1' ||
    value === '[::1]' ||
    value === '0.0.0.0' ||
    value.startsWith('127.')
  );
}

/** 网络白名单匹配：域名精确、*.example.com、IP/CIDR；回环地址始终放行。 */
export function hostAllowed(host: string, allowedHosts: string[]): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return false;
  if (isLoopbackHost(value)) return true;
  for (const raw of allowedHosts) {
    const entry = raw.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!entry) continue;
    if (entry.includes('/')) {
      if (entry.includes(':') ? ipv6InCidr(value, entry) : ipv4InCidr(value, entry)) return true;
      continue;
    }
    if (isLoopbackHost(entry) && entry === value) return true;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      if (value.endsWith(suffix) && value.length > suffix.length) return true;
      continue;
    }
    if (entry.startsWith('.')) {
      if (value.endsWith(entry)) return true;
      continue;
    }
    if (entry === value) return true;
  }
  return false;
}

function quoteSandboxPath(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 生成真沙箱下的启动命令；profile 未定义时返回 undefined。 */
export function sandboxCommand(
  command: string,
  cwd: string,
  profile: SandboxProfile | undefined,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } | undefined {
  if (!profile) return undefined;
  const resolvedCwd = path.resolve(cwd);
  if (profile.engine === 'bwrap') {
    const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev'];
    const binds = uniquePaths([resolvedCwd, ...tempDirs(platform)]);
    for (const dir of binds) {
      if (dir === '/') continue;
      if (!existsSync(dir)) continue;
      args.push('--bind', dir, dir);
    }
    args.push('--chdir', resolvedCwd);
    if (profile.network === 'none') args.push('--unshare-net');
    args.push('--', '/bin/bash', '-c', command);
    return { file: profile.binary, args };
  }
  const writeDirs = uniquePaths([resolvedCwd, ...tempDirs(platform)]);
  const allow = writeDirs
    .map((dir) => `(subpath "${quoteSandboxPath(dir)}")`)
    .concat(['(literal "/dev/null")', '(literal "/dev/stdout")', '(literal "/dev/stderr")']);
  const profileText = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${allow.join(' ')})`,
  ].join('\n');
  return {
    file: profile.binary,
    args: ['-p', profileText, '/bin/bash', '-c', command],
  };
}

export { tempDirs as sandboxTempDirs };
