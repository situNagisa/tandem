// SSH 执行层：所有远程命令都走参数数组，不拼本地 shell；远程脚本通过 stdin 交给 sh -s。
// 密码只在本函数栈与子进程环境中出现，不写日志、不落盘。
import { chmodSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { SshAuthInput, SshHostKeyInfo, SshTarget } from '@tandem/protocol';

export interface SshAuth {
  kind: SshAuthInput['kind'];
  keyPath?: string;
  password?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 测试用：通过 TANDEM_SSH_BIN 指定假 ssh/scp/ssh-keyscan/ssh-keygen 所在目录。 */
export function sshBinary(name: 'ssh' | 'scp' | 'ssh-keyscan' | 'ssh-keygen'): string {
  const dir = process.env.TANDEM_SSH_BIN?.trim();
  return dir ? path.join(dir, name) : name;
}

export class SshError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'SshError';
    this.code = code;
  }
}

/** 远程脚本里的单引号安全引用。 */
export function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function normalizeTarget(input: SshTarget): Required<SshTarget> {
  const user = String(input.user ?? '').trim();
  const host = String(input.host ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) throw new SshError('SSH 用户名不合法');
  if (!/^[A-Za-z0-9._-]{1,253}$/.test(host)) throw new SshError('SSH 主机名不合法（只支持域名 / IPv4）');
  const port = input.port === undefined ? 22 : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SshError('SSH 端口无效');
  return { user, host, port };
}

export function targetLabel(target: Required<SshTarget>): string {
  return `${target.user}@${target.host}:${target.port}`;
}

function commonArgs(target: Required<SshTarget>, knownHosts: string, auth: SshAuth): string[] {
  const args = [
    '-p',
    String(target.port),
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'LogLevel=ERROR',
  ];
  if (auth.kind === 'key') {
    if (!auth.keyPath) throw new SshError('未指定私钥文件');
    const keyPath = auth.keyPath.replace(/^~(?=$|\/)/, os.homedir());
    args.push('-i', keyPath, '-o', 'IdentitiesOnly=yes');
  } else if (auth.kind === 'password') {
    args.push(
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'NumberOfPasswordPrompts=1',
    );
  }
  return args;
}

interface Askpass {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function askpassEnv(password: string | undefined): Askpass | undefined {
  if (password === undefined) return undefined;
  const dir = path.join(os.tmpdir(), `tandem-askpass-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sh = path.join(dir, 'askpass.sh');
  const cmd = path.join(dir, 'askpass.cmd');
  writeFileSync(sh, '#!/bin/sh\nprintf \'%s\\n\' "$TANDEM_SSH_PASSWORD"\n', { mode: 0o700 });
  chmodSync(sh, 0o700);
  writeFileSync(cmd, '@echo off\r\necho %TANDEM_SSH_PASSWORD%\r\n', { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TANDEM_SSH_PASSWORD: password,
    SSH_ASKPASS: process.platform === 'win32' ? cmd : sh,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || ':0',
  };
  return {
    env,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    },
  };
}

interface SpawnOptions {
  timeoutMs?: number;
  input?: string;
}

function spawnCapture(
  command: string,
  args: string[],
  opts: SpawnOptions & { env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: opts.env ?? process.env,
        windowsHide: true,
      });
    } catch (err) {
      reject(new SshError(err instanceof Error ? err.message : '无法启动 SSH 命令'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* 忽略 */
      }
      reject(new SshError(`命令超时（${Math.round((opts.timeoutMs ?? 60000) / 1000)}s）`));
    }, opts.timeoutMs ?? 60000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new SshError(
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `未找到 ${command} 命令（Windows 请在「设置 → 应用 → 可选功能」启用 OpenSSH 客户端）`
            : err.message,
        ),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

export async function runSsh(
  target: Required<SshTarget>,
  auth: SshAuth,
  knownHosts: string,
  script: string,
  opts: SpawnOptions = {},
): Promise<RunResult> {
  const ask = askpassEnv(auth.password);
  try {
    const args = [...commonArgs(target, knownHosts, auth), `${target.user}@${target.host}`, '--', 'sh', '-s'];
    const result = await spawnCapture(sshBinary('ssh'), args, {
      ...opts,
      input: script,
      env: ask?.env ?? process.env,
    });
    if (result.code !== 0) {
      const reason = result.stderr.trim().split('\n').filter(Boolean).slice(-3).join('；');
      throw new SshError(reason || `SSH 命令失败（退出码 ${result.code}）`, result.code);
    }
    return result;
  } finally {
    ask?.cleanup();
  }
}

export async function runScp(
  target: Required<SshTarget>,
  auth: SshAuth,
  knownHosts: string,
  localFile: string,
  remotePath: string,
  opts: SpawnOptions = {},
): Promise<void> {
  const ask = askpassEnv(auth.password);
  try {
    const args = [
      '-q',
      ...commonArgs({ ...target, port: target.port }, knownHosts, auth).filter((arg, i, all) => {
        // scp 用 -P 指定端口；把 ssh 的 -p 挪过去。
        if (arg === '-p') return false;
        if (i > 0 && all[i - 1] === '-p') return false;
        return true;
      }),
      '-P',
      String(target.port),
      localFile,
      `${target.user}@${target.host}:${remotePath}`,
    ];
    const result = await spawnCapture(sshBinary('scp'), args, {
      ...opts,
      env: ask?.env ?? process.env,
    });
    if (result.code !== 0) {
      const reason = result.stderr.trim().split('\n').filter(Boolean).slice(-3).join('；');
      throw new SshError(reason || `scp 失败（退出码 ${result.code}）`, result.code);
    }
  } finally {
    ask?.cleanup();
  }
}

export interface TunnelProcess {
  child: import('node:child_process').ChildProcess;
  cleanup: () => void;
}

/** 启动 `ssh -N -L` 隧道；调用方负责在退出时 kill 子进程。 */
export function startTunnelProcess(
  target: Required<SshTarget>,
  auth: SshAuth,
  knownHosts: string,
  localPort: number,
  remotePort: number,
): TunnelProcess {
  const ask = askpassEnv(auth.password);
  const args = [
    ...commonArgs(target, knownHosts, auth),
    '-N',
    '-T',
    '-o',
    'ExitOnForwardFailure=yes',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    `${target.user}@${target.host}`,
  ];
  const child = spawn(sshBinary('ssh'), args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: ask?.env ?? process.env,
    windowsHide: true,
  });
  return { child, cleanup: () => ask?.cleanup() };
}

/** 用 ssh-keyscan 读取主机公钥并计算 SHA256 指纹；不需要登录。 */
export async function scanHostKey(
  target: Required<SshTarget>,
  knownHosts: string,
): Promise<SshHostKeyInfo> {
  // 每次只扫描一种类型：部分 sshd 会对短时间内的多次无认证连接做惩罚。
  let lines: string[] = [];
  let lastError = '';
  for (const type of ['ed25519', 'ecdsa', 'rsa'] as const) {
    const scan = await spawnCapture(
      sshBinary('ssh-keyscan'),
      ['-T', '10', '-t', type, '-p', String(target.port), target.host],
      { timeoutMs: 20000 },
    );
    lastError = scan.stderr.trim() || lastError;
    lines = scan.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes(' ssh-'));
    if (lines.length > 0) break;
  }
  if (lines.length === 0) {
    throw new SshError(lastError || '无法读取 SSH 主机公钥（主机不可达或端口不对）');
  }
  const rank = (line: string) =>
    line.includes(' ssh-ed25519 ') ? 0 : line.includes(' ecdsa-sha2-') ? 1 : 2;
  lines.sort((a, b) => rank(a) - rank(b));
  const keyLine = lines[0]!;
  const keyType = keyLine.split(' ')[1] ?? 'unknown';
  const fingerprint = await fingerprintOf(keyLine);
  const known = await knownFingerprint(target, knownHosts, keyType);
  return {
    fingerprint,
    keyType,
    host: target.host,
    port: target.port,
    known: !!known,
    changed: !!known && known !== fingerprint,
  };
}

async function fingerprintOf(keyLine: string): Promise<string> {
  const result = await spawnCapture(sshBinary('ssh-keygen'), ['-lf', '-', '-E', 'sha256'], {
    input: `${keyLine}\n`,
    timeoutMs: 10000,
  });
  const match = result.stdout.match(/SHA256:[A-Za-z0-9+/=]+/);
  if (!match) throw new SshError('无法解析 SSH 主机公钥指纹');
  return match[0];
}

async function knownFingerprint(
  target: Required<SshTarget>,
  knownHosts: string,
  keyType: string,
): Promise<string | undefined> {
  if (!existsSync(knownHosts)) return undefined;
  const hostKey = target.port === 22 ? target.host : `[${target.host}]:${target.port}`;
  const result = await spawnCapture(sshBinary('ssh-keygen'), ['-F', hostKey, '-f', knownHosts], {
    timeoutMs: 10000,
  });
  if (result.code !== 0) return undefined;
  const keyLine = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes(` ${keyType} `));
  if (!keyLine) return undefined;
  const parts = keyLine.split(' ');
  const normalized = `${parts[0]} ${parts[1]} ${parts[2] ?? ''}`.trim();
  try {
    return await fingerprintOf(normalized);
  } catch {
    return undefined;
  }
}
