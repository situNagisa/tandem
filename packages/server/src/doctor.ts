// Host 诊断：逐项检查本机运行环境，帮助定位「为什么用不了」。
// 只访问本机资源；唯一的外部请求是用户在勾选后触发的模型服务商连通性测试。
import { execFile } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DoctorCheck, DoctorReport, DoctorStatus } from '@tandem/protocol';
import type { Host } from './host.js';
import type { StoredProfile, StoredProfileGroup, StoredProfileKey } from './types.js';
import { testProfile } from './providers/index.js';
import { sttCapabilities } from './stt.js';
import { decodeProcessOutput } from './util/encoding.js';
import { errorMessage } from './util/text.js';

export const DOCTOR_CHECK_IDS = [
  'node',
  'dataDir',
  'disk',
  'listen',
  'firewall',
  'profiles',
  'git',
  'gh',
  'glab',
  'rg',
  'adb',
  'browser',
  'whisper',
  'mcp',
  'hooks',
  'external',
  'encoding',
  'clock',
] as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

export interface DoctorOptions {
  /** 要执行的检查项；省略时执行除账号连通性外的全部检查。 */
  checks?: string[];
  /** 监听地址（来自 Fastify 实际绑定或 CLI 参数）。 */
  listen: { host: string; port: number };
  /** 客户端时间，用于计算时钟偏差。 */
  clientTime?: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  notFound?: boolean;
}

function run(bin: string, args: string[], timeout = 10_000, maxBuffer = 8 * 1024 * 1024): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout, windowsHide: true, maxBuffer, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const out = stdout ? decodeProcessOutput(stdout) : '';
        const errOut = stderr ? decodeProcessOutput(stderr) : '';
        if (!err) {
          resolve({ code: 0, stdout: out, stderr: errOut });
          return;
        }
        const e = err as NodeJS.ErrnoException;
        resolve({
          code: typeof e.code === 'number' ? e.code : 1,
          stdout: out,
          stderr: errOut || e.message || '',
          ...(e.code === 'ENOENT' ? { notFound: true } : {}),
        });
      },
    );
  });
}

function check(
  id: string,
  title: string,
  status: DoctorStatus,
  detail: string,
  fix?: string,
): DoctorCheck {
  return { id, title, status, detail, ...(fix ? { fix } : {}) };
}

function collectSecrets(host: Host): string[] {
  const secrets = new Set<string>();
  const add = (value?: string) => {
    if (value && value.length >= 6) secrets.add(value);
  };
  add(host.config.token);
  const addProfile = (profile: StoredProfile) => {
    add(profile.apiKey);
    for (const group of profile.groups ?? []) {
      add(group.apiKey);
      for (const key of group.keys ?? []) add(key.apiKey);
    }
  };
  for (const profile of host.profiles.list()) addProfile(profile);
  return [...secrets].sort((a, b) => b.length - a.length);
}

/** 去掉 Key、token、URL 里的凭据与常见敏感字段，避免报告被转发后泄露。 */
export function redactDoctorText(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('***');
  }
  out = out
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+/gi, '$1 ***')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, 'sk-***')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key|secret|password)=)[^&\s]+/gi, '$1***');
  return out;
}

function formatFree(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 10) return `${gb.toFixed(0)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
}

function isLoopback(host: string): boolean {
  const value = host.trim().toLowerCase();
  return (
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '[::1]' ||
    value === 'localhost' ||
    value === '::ffff:127.0.0.1'
  );
}

function isAllInterfaces(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

async function nodeCheck(): Promise<DoctorCheck> {
  const version = process.versions.node;
  const major = Number(version.split('.')[0]);
  const detail = `Node ${version}（${process.platform}/${process.arch}）`;
  if (major >= 22) return check('node', 'Node 版本', 'ok', detail);
  if (major >= 20) {
    return check(
      'node',
      'Node 版本',
      'warn',
      `${detail}；Tandem 要求 Node 22 及以上，升级后再试。`,
      'winget install --id OpenJS.NodeJS.LTS -e',
    );
  }
  return check(
    'node',
    'Node 版本',
    'fail',
    `${detail}；版本过低，Host 可能无法启动或运行异常。`,
    'winget install --id OpenJS.NodeJS.LTS -e',
  );
}

function dataDirCheck(host: Host): DoctorCheck {
  const probe = path.join(host.home, `.doctor-${process.pid}.tmp`);
  try {
    writeFileSync(probe, 'tandem doctor', { encoding: 'utf8', mode: 0o600 });
    unlinkSync(probe);
    return check('dataDir', '数据目录可写', 'ok', `${host.home} 可写。`);
  } catch (err) {
    return check(
      'dataDir',
      '数据目录可写',
      'fail',
      `无法写入 ${host.home}：${errorMessage(err)}`,
      process.platform === 'win32'
        ? `icacls "${host.home}" /grant %USERNAME%:(OI)(CI)F`
        : `chmod u+rwx "${host.home}"`,
    );
  }
}

function diskCheck(host: Host): DoctorCheck {
  try {
    const stats = statfsSync(host.home);
    const free = stats.bavail * stats.bsize;
    const total = stats.blocks * stats.bsize;
    const detail = `数据目录所在磁盘可用 ${formatFree(free)} / 共 ${formatFree(total)}。`;
    if (free < 100 * 1024 ** 2) {
      return check(
        'disk',
        '磁盘剩余空间',
        'fail',
        detail + ' 空间严重不足，会话与检查点可能写入失败。',
        '清理旧会话、评测快照与检查点（~/.tandem 下 sessions / evals / checkpoints）。',
      );
    }
    if (free < 1024 ** 3) {
      return check(
        'disk',
        '磁盘剩余空间',
        'warn',
        detail + ' 低于 1 GB，长会话和评测可能失败。',
        '清理旧会话、评测快照与检查点（~/.tandem 下 sessions / evals / checkpoints）。',
      );
    }
    return check('disk', '磁盘剩余空间', 'ok', detail);
  } catch (err) {
    return check('disk', '磁盘剩余空间', 'skip', `无法读取磁盘信息：${errorMessage(err)}`);
  }
}

function listenCheck(host: Host, listen: { host: string; port: number }): DoctorCheck {
  const where = `${listen.host}:${listen.port}`;
  if (isLoopback(listen.host)) {
    return check(
      'listen',
      '监听地址',
      'warn',
      `只监听 ${where}：手机、局域网分享与团队功能无法从其他设备访问。`,
      `tandem-host --host 0.0.0.0 --port ${listen.port}`,
    );
  }
  if (isAllInterfaces(listen.host)) {
    return check(
      'listen',
      '监听地址',
      'ok',
      `监听 ${where}，局域网设备可访问（请只在可信内网使用）。`,
    );
  }
  return check('listen', '监听地址', 'ok', `监听 ${where}。`);
}

async function firewallCheck(listen: { host: string; port: number }): Promise<DoctorCheck> {
  if (process.platform !== 'win32') {
    return check('firewall', 'Windows 防火墙', 'skip', '非 Windows 系统，跳过防火墙检查。');
  }
  if (isLoopback(listen.host)) {
    return check('firewall', 'Windows 防火墙', 'skip', 'Host 只监听回环地址，无需放行端口。');
  }
  const result = await run(
    'netsh',
    ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in'],
    12_000,
  );
  if (result.notFound || result.code !== 0) {
    return check('firewall', 'Windows 防火墙', 'skip', '无法读取防火墙规则（netsh 不可用或没有权限）。');
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const ports = [...output.matchAll(/(?:LocalPort|本地端口)\s*:\s*([^\r\n]*)/gi)]
    .flatMap((match) => (match[1] ?? '').split(','))
    .map((item) => item.trim().toLowerCase());
  const port = String(listen.port);
  if (ports.some((item) => item === port || item === 'any' || item === '任意')) {
    return check('firewall', 'Windows 防火墙', 'ok', `已有入站规则放行端口 ${port}。`);
  }
  return check(
    'firewall',
    'Windows 防火墙',
    'warn',
    `未找到放行 TCP ${port} 的入站规则，其他设备可能连不上 Host。`,
    `netsh advfirewall firewall add rule name="Tandem Host ${port}" dir=in action=allow protocol=TCP localport=${port}`,
  );
}

async function testOneProfile(
  profile: StoredProfile,
  title: string,
): Promise<DoctorCheck> {
  const model = profile.defaultModel || profile.models[0] || '';
  if (!profile.apiKey) {
    return check(profile.id, title, 'fail', '未配置 API Key。', '在「账号与模型」中填写 Key 后重新检查。');
  }
  if (!model) {
    return check(profile.id, title, 'fail', '未配置模型。', '在「账号与模型」中添加至少一个模型。');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const started = Date.now();
  try {
    const result = await testProfile(profile, controller.signal);
    if (result.ok) {
      return check(profile.id, title, 'ok', `模型 ${model} 连接正常（${Date.now() - started}ms）。`);
    }
    const error = result.error ?? '未知错误';
    const auth = /401|403|unauthor|invalid.*key|api key|密钥|未授权/i.test(error);
    return check(
      profile.id,
      title,
      'fail',
      `模型 ${model} 连接失败：${error}`,
      auth
        ? 'Key 无效或已过期：在「账号与模型」中更新 Key 后测试连接。'
        : '检查 Host 的网络/代理、账号 Base URL 与服务商状态；确认模型名可用。',
    );
  } catch (err) {
    return check(
      profile.id,
      title,
      'fail',
      `模型 ${model} 连接失败：${errorMessage(err)}`,
      '检查 Host 的网络/代理、账号 Base URL 与服务商状态。',
    );
  } finally {
    clearTimeout(timer);
  }
}

async function profileChecks(host: Host): Promise<DoctorCheck[]> {
  const profiles = host.profiles.list();
  if (profiles.length === 0) {
    return [
      check(
        'profiles',
        '账号连通性',
        'skip',
        '没有配置账号，无法调用模型。',
        '在「账号与模型」中添加账号。',
      ),
    ];
  }
  const checks: DoctorCheck[] = [];
  // 账号级模型账号：Key 只在工作站，主机用进程内 bridge 测试真实连通性。
  const accountClient = host.mirrorProfiles ? host.workstationProfiles() : undefined;
  const accountId = host.accounts.ownerAccountId();
  for (const profile of profiles) {
    const groups: Array<StoredProfileGroup | undefined> = profile.groups?.length
      ? profile.groups
      : [undefined];
    for (const group of groups) {
      const groupTitle = group ? `账号「${profile.name}」· 分组「${group.name}」` : `账号「${profile.name}」`;
      if (accountClient && accountId) {
        const model = profile.defaultModel || profile.models[0] || '';
        const keys: StoredProfileKey[] = group?.keys?.length ? group.keys.filter((key) => !key.disabled) : [{ id: 'base', apiKey: '' }];
        if (keys.length === 0) {
          checks.push(
            check(
              `profile.${profile.id}.${group?.id ?? 'base'}`,
              groupTitle,
              'warn',
              '分组里没有可用的 Key。',
              '在「账号与模型」中启用或补齐 Key。',
            ),
          );
          continue;
        }
        for (const [index, key] of keys.entries()) {
          const label = key.label?.trim() || (keys.length > 1 ? `Key ${index + 1}` : '');
          const title = label ? `${groupTitle} · ${label}` : groupTitle;
          const started = Date.now();
          const result = await accountClient
            .testProfile(accountId, profile.id, group?.id, key.id === 'base' ? undefined : key.id)
            .catch((err: unknown) => ({ ok: false, error: errorMessage(err) }));
          checks.push(
            result.ok
              ? check(
                  `profile.${profile.id}.${group?.id ?? 'base'}.${key.id || index}`,
                  title,
                  'ok',
                  `模型 ${model} 连接正常（${Date.now() - started}ms）。`,
                )
              : check(
                  `profile.${profile.id}.${group?.id ?? 'base'}.${key.id || index}`,
                  title,
                  'fail',
                  `模型 ${model} 连接失败：${result.error ?? '未知错误'}`,
                  '检查账号 Base URL、Key 与服务商状态，确认模型名可用。',
                ),
          );
        }
        continue;
      }
      const keys: StoredProfileKey[] =
        group?.keys?.length
          ? group.keys
          : [{ id: 'base', apiKey: group?.apiKey || profile.apiKey }];
      const disabled = keys.filter((key) => key.disabled).length;
      const active = keys.filter((key) => !key.disabled && key.apiKey);
      if (active.length === 0) {
        checks.push(
          check(
            `profile.${profile.id}.${group?.id ?? 'base'}`,
            groupTitle,
            'warn',
            disabled > 0 ? `${disabled} 个 Key 已全部停用，已跳过测试。` : '分组里没有可用的 Key。',
            '在「账号与模型」中启用或补齐 Key。',
          ),
        );
        continue;
      }
      const effective = host.profileFor(profile.id, group?.id) ?? profile;
      for (const [index, key] of active.entries()) {
        const label = key.label?.trim() || (active.length > 1 ? `Key ${index + 1}` : '');
        const title = label ? `${groupTitle} · ${label}` : groupTitle;
        const result = await testOneProfile(
          { ...effective, apiKey: key.apiKey },
          title,
        );
        checks.push({
          ...result,
          id: `profile.${profile.id}.${group?.id ?? 'base'}.${key.id || index}`,
          ...(disabled > 0
            ? {
                detail: `${result.detail}（已跳过 ${disabled} 个停用 Key）`,
              }
            : {}),
        });
      }
    }
  }
  return checks;
}

async function gitCheck(): Promise<DoctorCheck> {
  const result = await run('git', ['--version'], 5_000);
  if (result.notFound || result.code !== 0) {
    return check(
      'git',
      'Git',
      'warn',
      '未安装 git：改动审阅、检查点与 worktree 功能不可用。',
      'winget install --id Git.Git -e',
    );
  }
  return check('git', 'Git', 'ok', firstLine(result.stdout) || 'git 可用');
}

async function cliCheck(bin: 'gh' | 'glab'): Promise<DoctorCheck> {
  const name = bin === 'gh' ? 'GitHub CLI（gh）' : 'GitLab CLI（glab）';
  const version = await run(bin, ['--version'], 8_000);
  if (version.notFound || version.code !== 0) {
    return check(bin, name, 'warn', `未安装 ${bin}：PR / CI 相关功能不可用。`, bin === 'gh'
      ? 'winget install --id GitHub.cli -e'
      : 'winget install --id glab.glab -e');
  }
  const auth = await run(bin, ['auth', 'status'], 15_000);
  const output = `${auth.stdout}\n${auth.stderr}`;
  const user = output.match(/Logged in to \S+ (?:account|as) (\S+)|已登录到 \S+ (?:账号|账户) (\S+)/i);
  const account = (user?.[1] ?? user?.[2] ?? '').replace(/[(),，。].*$/, '');
  if (auth.notFound) {
    return check(bin, name, 'warn', `无法执行 ${bin} auth status。`, `${bin} auth login`);
  }
  if (auth.code === 0 && account) {
    return check(bin, name, 'ok', `${firstLine(version.stdout) || bin}，已登录 ${account}。`);
  }
  if (auth.code === 0) {
    return check(bin, name, 'ok', `${firstLine(version.stdout) || bin}，登录状态正常。`);
  }
  return check(
    bin,
    name,
    'warn',
    `${bin} 已安装，但未登录或登录已失效：PR / CI 功能不可用。`,
    `${bin} auth login`,
  );
}

async function rgCheck(): Promise<DoctorCheck> {
  const result = await run('rg', ['--version'], 5_000);
  if (result.notFound || result.code !== 0) {
    return check(
      'rg',
      'ripgrep',
      'warn',
      '未安装 ripgrep：Grep 搜索会退回较慢的内置实现。',
      'winget install --id BurntSushi.ripgrep.MSVC -e',
    );
  }
  return check('rg', 'ripgrep', 'ok', firstLine(result.stdout) || 'rg 可用');
}

/** adb 是可选组件：没装只是 ADB 设备不可用，串口与其余功能不受影响。 */
async function adbCheck(host: Host): Promise<DoctorCheck> {
  const bin = process.env.TANDEM_ADB_BIN?.trim() || host.settings().devices?.adbPath?.trim() || 'adb';
  const result = await run(bin, ['version'], 8_000);
  if (result.notFound || result.code !== 0) {
    const missing = result.notFound;
    return check(
      'adb',
      'ADB',
      'warn',
      missing
        ? `未检测到 adb（${bin}）：工作站里的 ADB 设备不可用；串口与其他设备不受影响。`
        : `adb 无法运行（${bin}）：${firstLine(result.stderr || result.stdout) || '未知原因'}。`,
      process.platform === 'win32'
        ? 'winget install --id Google.PlatformTools -e；或在设置里把 devices.adbPath 指向 adb.exe'
        : 'brew install --cask android-platform-tools；或设置 devices.adbPath / TANDEM_ADB_BIN',
    );
  }
  return check('adb', 'ADB', 'ok', firstLine(result.stdout) || 'adb 可用');
}

async function browserCheck(host: Host): Promise<DoctorCheck> {  const status = await host.browser.status();
  if (status.available) {
    return check('browser', '浏览器组件', 'ok', `Playwright 可用：${status.browser ?? 'Chromium'}。`);
  }
  const enabled = host.browser.settings.enabled;
  return check(
    'browser',
    '浏览器组件',
    'warn',
    `${enabled ? '浏览器工具已启用，但' : '浏览器工具未启用，且'}组件不可用：${status.error ?? '未知原因'}`,
    'npm i playwright && npx playwright install chromium',
  );
}

function whisperCheck(host: Host): DoctorCheck {
  const caps = sttCapabilities(host.settings());
  if (caps.available) {
    return check(
      'whisper',
      '语音转写（Whisper）',
      'ok',
      `${caps.engine ?? '本机 Whisper'} 可用（语言 ${caps.language}）。`,
    );
  }
  if (!caps.configured) {
    return check(
      'whisper',
      '语音转写（Whisper）',
      caps.detected.length > 0 ? 'warn' : 'skip',
      caps.detected.length > 0
        ? `检测到 ${caps.detected[0]?.binaryPath}，但还没有选择模型文件。`
        : '未配置本机 Whisper，语音输入不可用（不影响文字会话）。',
      '在设置「语音」里填写 Whisper 可执行文件与模型路径。',
    );
  }
  return check(
    'whisper',
    '语音转写（Whisper）',
    'warn',
    `已配置但不可用：${caps.error ?? '未知原因'}`,
    '检查设置「语音」里的可执行文件与模型路径是否存在。',
  );
}

async function mcpChecks(host: Host): Promise<DoctorCheck[]> {
  // Host 启动时已在后台连接；这里只读状态，不主动访问服务器。
  await new Promise((resolve) => setTimeout(resolve, 800));
  const statuses = host.mcp.status();
  if (statuses.length === 0) {
    return [check('mcp', 'MCP 服务器', 'skip', '未配置 MCP 服务器。')];
  }
  return statuses.map((server, index) => {
    const id = `mcp.${index}`;
    const title = `MCP 服务器「${server.name}」`;
    if (server.status === 'connected') {
      return check(id, title, 'ok', `已连接，提供 ${server.tools.length} 个工具。`);
    }
    if (server.status === 'disabled') {
      return check(id, title, 'skip', '已在配置中停用。');
    }
    if (server.status === 'error') {
      return check(
        id,
        title,
        'fail',
        `连接失败：${server.error ?? '未知错误'}`,
        '在设置「MCP」里检查启动命令/URL、登录环境与依赖是否可用。',
      );
    }
    return check(id, title, 'warn', '仍在连接中（首次连接或远程服务可能较慢）。');
  });
}

function hooksCheck(host: Host): DoctorCheck {
  const settings = host.hooks.settings();
  const existing = settings.sources.filter((source) => source.exists);
  if (existing.length === 0) {
    return check('hooks', 'Hooks 配置', 'skip', '没有 Hooks 配置文件。');
  }
  const problems: string[] = [];
  for (const source of existing) {
    try {
      JSON.parse(readFileSync(source.path, 'utf8'));
    } catch (err) {
      problems.push(`${source.path}：${errorMessage(err)}`);
    }
  }
  if (problems.length > 0) {
    return check(
      'hooks',
      'Hooks 配置',
      'fail',
      `配置文件语法错误，Hooks 不会执行：${problems.join('；')}`,
      '修正 JSON 语法（常见原因：多余逗号、注释、未闭合引号）后重新检查。',
    );
  }
  return check('hooks', 'Hooks 配置', 'ok', `已加载 ${settings.entries.length} 条 Hook。`);
}

function externalCheck(home: string): DoctorCheck {
  const targets = [
    { name: '~/.claude', dir: path.join(home, '.claude') },
    { name: '~/.codex', dir: path.join(home, '.codex') },
  ];
  const existing = targets.filter((item) => existsSync(item.dir));
  if (existing.length === 0) {
    return check('external', '外部会话目录', 'skip', '未找到 ~/.claude 或 ~/.codex，导入功能不可用。');
  }
  const parts: string[] = [];
  let unreadable = 0;
  for (const item of existing) {
    try {
      accessSync(item.dir, constants.R_OK);
      readdirSync(item.dir);
      parts.push(`${item.name} 可读`);
    } catch (err) {
      unreadable += 1;
      parts.push(`${item.name} 不可读（${errorMessage(err)}）`);
    }
  }
  const missing = targets.filter((item) => !existsSync(item.dir)).map((item) => item.name);
  const detail = parts.join('；') + (missing.length ? `；${missing.join('、')} 不存在` : '');
  if (unreadable > 0) {
    return check(
      'external',
      '外部会话目录',
      'warn',
      detail + '。无法导入对应软件的会话。',
      process.platform === 'win32'
        ? 'icacls "%USERPROFILE%\\.claude" /grant %USERNAME%:R'
        : 'chmod u+r ~/.claude ~/.codex',
    );
  }
  return check('external', '外部会话目录', 'ok', detail);
}

async function encodingCheck(): Promise<DoctorCheck> {
  if (process.platform !== 'win32') {
    return check('encoding', '终端编码', 'skip', '非 Windows 系统，使用 UTF-8，无需检查。');
  }
  const result = await run('cmd', ['/d', '/c', 'chcp'], 5_000);
  if (result.code !== 0) {
    return check('encoding', '终端编码', 'skip', '无法读取控制台代码页。');
  }
  const codePage = Number((`${result.stdout} ${result.stderr}`.match(/\b(\d{3,5})\b/) ?? [])[1]);
  if (codePage === 65001) {
    return check('encoding', '终端编码', 'ok', '控制台代码页为 65001（UTF-8）。');
  }
  if (!Number.isFinite(codePage) || codePage === 0) {
    return check('encoding', '终端编码', 'skip', '无法识别控制台代码页。');
  }
  return check(
    'encoding',
    '终端编码',
    'warn',
    `控制台代码页为 ${codePage}（中文系统通常是 936/GBK），命令输出可能乱码。Tandem 会自动回退 GBK，但建议统一为 UTF-8。`,
    'chcp 65001',
  );
}

function clockCheck(clientTime?: number): DoctorCheck {
  if (typeof clientTime !== 'number' || !Number.isFinite(clientTime)) {
    return check('clock', '时钟偏差', 'skip', '客户端未提供时间，无法比较。');
  }
  const skew = clientTime - Date.now();
  const seconds = Math.round(Math.abs(skew) / 1000);
  const direction = skew > 0 ? '客户端比 Host 快' : '客户端比 Host 慢';
  if (seconds <= 60) {
    return check('clock', '时钟偏差', 'ok', `与客户端相差 ${seconds} 秒。`);
  }
  return check(
    'clock',
    '时钟偏差',
    seconds > 300 ? 'fail' : 'warn',
    `${direction} ${seconds} 秒；定时任务、审批超时与日志时间可能不准。`,
    process.platform === 'win32'
      ? 'w32tm /resync'
      : process.platform === 'darwin'
        ? 'sudo sntp -sS time.apple.com'
        : 'sudo timedatectl set-ntp true',
  );
}

function selectChecks(input?: string[]): Set<DoctorCheckId> {
  const known = new Set<string>(DOCTOR_CHECK_IDS);
  if (!input || input.length === 0) {
    return new Set(DOCTOR_CHECK_IDS.filter((id) => id !== 'profiles'));
  }
  return new Set(input.filter((id): id is DoctorCheckId => known.has(id)));
}

const STATUS_WEIGHT: Record<DoctorStatus, number> = { fail: 0, warn: 1, skip: 2, ok: 3 };

export async function runDoctor(host: Host, options: DoctorOptions): Promise<DoctorReport> {
  const selected = selectChecks(options.checks);
  const ran: string[] = [];
  const checks: DoctorCheck[] = [];
  const home = os.homedir();

  const push = async (id: DoctorCheckId, fn: () => DoctorCheck | Promise<DoctorCheck>) => {
    if (!selected.has(id)) return;
    ran.push(id);
    checks.push(await fn());
  };

  await push('node', nodeCheck);
  await push('dataDir', () => dataDirCheck(host));
  await push('disk', () => diskCheck(host));
  await push('listen', () => listenCheck(host, options.listen));
  await push('firewall', () => firewallCheck(options.listen));
  if (selected.has('profiles')) {
    ran.push('profiles');
    checks.push(...(await profileChecks(host)));
  } else if (!options.checks || options.checks.length === 0) {
    checks.push(
      check(
        'profiles',
        '账号连通性',
        'skip',
        '未执行：会向模型服务商发送一次最小请求，可能产生少量费用。',
        '勾选「检测账号连通性」后重新检查。',
      ),
    );
  }
  await push('git', gitCheck);
  await push('gh', () => cliCheck('gh'));
  await push('glab', () => cliCheck('glab'));
  await push('rg', rgCheck);
  await push('adb', () => adbCheck(host));
  await push('browser', () => browserCheck(host));
  await push('whisper', () => whisperCheck(host));
  if (selected.has('mcp')) {
    ran.push('mcp');
    checks.push(...(await mcpChecks(host)));
  }
  await push('hooks', () => hooksCheck(host));
  await push('external', () => externalCheck(home));
  await push('encoding', encodingCheck);
  await push('clock', () => clockCheck(options.clientTime));

  const secrets = collectSecrets(host);
  const sanitized = checks
    .map((item) => ({
      ...item,
      detail: redactDoctorText(item.detail, secrets),
      ...(item.fix ? { fix: redactDoctorText(item.fix, secrets) } : {}),
    }))
    .sort((a, b) => STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status]);

  const info = host.info();
  const report: DoctorReport = {
    generatedAt: Date.now(),
    host: {
      id: info.id,
      name: info.name,
      platform: info.platform,
      version: info.version,
    },
    listen: options.listen,
    checks: sanitized,
    text: '',
    textHidden: '',
    ran,
  };
  report.text = formatDoctorReport(report);
  report.textHidden = formatDoctorReport(report, home);
  return report;
}

const STATUS_LABEL: Record<DoctorStatus, string> = {
  ok: '正常',
  warn: '警告',
  fail: '失败',
  skip: '跳过',
};

function localTime(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 生成可直接贴给维护者的纯文本报告；hideHome 时把主目录替换为 ~。 */
export function formatDoctorReport(report: DoctorReport, hideHome?: string): string {
  const hide = hideHome ? [hideHome, hideHome.replace(/\\/g, '/')] : [];
  const clean = (text: string) => {
    let out = text;
    for (const value of hide) {
      if (!value) continue;
      out = out.split(value).join('~');
    }
    return out;
  };
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const item of report.checks) counts[item.status] += 1;
  const lines: string[] = [
    'Tandem Host 诊断报告',
    `生成时间：${localTime(report.generatedAt)}`,
    `Host：${clean(report.host.name)}（${report.host.id}）`,
    `系统：${report.host.platform} · Tandem ${report.host.version}`,
    `监听：${report.listen.host}:${report.listen.port}`,
    `结果：正常 ${counts.ok} · 警告 ${counts.warn} · 失败 ${counts.fail} · 跳过 ${counts.skip}`,
    '',
  ];
  for (const item of report.checks) {
    lines.push(`[${STATUS_LABEL[item.status]}] ${clean(item.title)}`);
    lines.push(`  ${clean(item.detail)}`);
    if (item.fix) lines.push(`  修复建议：${clean(item.fix)}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}
