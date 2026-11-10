// 开机自启计划：只写配置，下次登录（或开机）时生效；不立即启动，避免和当前前台连接抢同一个主机身份。
// buildServicePlan 是纯函数，只产出「计划」；只有 join --service 且非 dry-run 时才由 CLI 执行。
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface ServicePlanInput {
  platform: NodeJS.Platform;
  nodePath: string;
  cliPath: string;
  home: string;
  logFile: string;
  userHome: string;
  /** Windows 专用；缺省按 userHome\AppData\Local。 */
  localAppData?: string;
}

export interface ServicePlanFile {
  path: string;
  content: string;
  mode?: number;
  /** Windows .vbs 用 UTF-16LE（带 BOM）才能正确读中文路径；默认 utf8。 */
  encoding?: 'utf8' | 'utf16le';
}

export interface ServicePlanCommand {
  cmd: string;
  args: string[];
  /** 尽力而为：失败只提示，不中断（如 loginctl enable-linger）。 */
  optional?: boolean;
}

export interface ServicePlan {
  files: ServicePlanFile[];
  commands: ServicePlanCommand[];
  note?: string;
}

/** 开机自启的主机进程：随机回环端口（工作站隧道不需要固定端口），连接由 TANDEM_HOME 里保存的加入记录决定。 */
const SERVICE_ARGS = ['--port', '0', '--host', '127.0.0.1'];

const TOKEN_PATTERN = /(?:ach|acw|tmm|dvt|tgw)_[A-Za-z0-9_-]{6,}/g;

/** 打印前脱敏：`ach_abcd…` → `ach_****`。 */
export function redactToken(text: string): string {
  return text.replace(TOKEN_PATTERN, (match) => `${match.slice(0, match.indexOf('_') + 1)}****`);
}

/** systemd 单值参数：加引号并转义 `\`、`"` 与 `%`。 */
function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Windows cmd 参数：含空格的路径加双引号（文件名不含 `"`，无需转义）。 */
function cmdQuote(value: string): string {
  return `"${value}"`;
}

/** 用反斜杠拼 Windows 路径（在 Linux 上生成计划时也不能混入 `/`）。 */
function winJoin(...parts: string[]): string {
  return parts
    .filter((part) => !!part)
    .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('\\');
}

function buildLinuxPlan(input: ServicePlanInput): ServicePlan {
  const unitPath = path.join(input.userHome, '.config', 'systemd', 'user', 'tandem-host.service');
  const content = [
    '[Unit]',
    'Description=Tandem Host',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment="TANDEM_HOME=${input.home.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`,
    `ExecStart=${systemdQuote(input.nodePath)} ${systemdQuote(input.cliPath)} ${SERVICE_ARGS.join(' ')}`,
    'Restart=always',
    'RestartSec=5',
    `StandardOutput="append:${input.logFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`,
    `StandardError="append:${input.logFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  return {
    files: [{ path: unitPath, content, mode: 0o644 }],
    commands: [
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', 'tandem-host'] },
      // 不启 linger 时用户退出登录会停掉服务；无权限（容器/无 polkit）时只提示。
      { cmd: 'loginctl', args: ['enable-linger'], optional: true },
    ],
    note: 'Linux 使用 systemd --user：下次开机（linger 开启时）或登录后自动启动。没有 systemd --user 时这一步会失败，前台连接不受影响。',
  };
}

function buildMacPlan(input: ServicePlanInput): ServicePlan {
  const plistPath = path.join(input.userHome, 'Library', 'LaunchAgents', 'dev.tandem.host.plist');
  const args = [input.nodePath, input.cliPath, ...SERVICE_ARGS]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join('\n');
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>dev.tandem.host</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>TANDEM_HOME</key>',
    `    <string>${xmlEscape(input.home)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(input.logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(input.logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  return {
    files: [{ path: plistPath, content, mode: 0o644 }],
    commands: [],
    note: 'macOS 使用 LaunchAgent：写入 ~/Library/LaunchAgents 后，下次登录时由 launchd 加载。',
  };
}

function buildWindowsPlan(input: ServicePlanInput): ServicePlan {
  const localAppData =
    input.localAppData ??
    (input.platform === 'win32' && process.platform === 'win32'
      ? process.env.LOCALAPPDATA
      : undefined) ??
    winJoin(input.userHome, 'AppData', 'Local');
  const dir = winJoin(localAppData, 'Tandem');
  const cmdPath = winJoin(dir, 'tandem-host-run.cmd');
  const vbsPath = winJoin(dir, 'tandem-host-run.vbs');
  const cmdContent = [
    '@echo off',
    // 批处理默认按系统 OEM 代码页读，中文路径会乱码；切到 UTF-8 再解析后续行。
    'chcp 65001 >nul',
    'setlocal',
    `set "TANDEM_HOME=${input.home}"`,
    ':run',
    `${cmdQuote(input.nodePath)} ${cmdQuote(input.cliPath)} ${SERVICE_ARGS.join(' ')} >> ${cmdQuote(input.logFile)} 2>&1`,
    // timeout 在隐藏窗口/输入重定向下会报错，ping 更稳。
    'ping -n 6 127.0.0.1 >nul',
    'goto run',
    '',
  ].join('\r\n');
  const vbsContent = [
    // WScript 按 ANSI 读脚本，中文路径需 UTF-16LE + BOM。
    '\ufeffSet sh = CreateObject("WScript.Shell")',
    // 0 = 隐藏窗口；VBS 字符串里的双引号写成两个，因此命令路径前后各三个引号。
    `sh.Run """${cmdPath}""", 0, False`,
    '',
  ].join('\r\n');
  return {
    files: [
      { path: cmdPath, content: cmdContent },
      { path: vbsPath, content: vbsContent, encoding: 'utf16le' },
    ],
    commands: [
      // 用当前用户的「启动」注册表项做登录自启：不需要管理员。schtasks /SC ONLOGON 在
      // Windows 11 的非管理员会话里会「拒绝访问」（实测），装不成服务。
      {
        cmd: 'reg',
        args: ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'TandemHost', '/t', 'REG_SZ', '/d', `wscript.exe //B ${cmdQuote(vbsPath)}`, '/f'],
      },
    ],
    note: 'Windows 用当前用户的启动项（HKCU\\…\\Run，无需管理员）：下次登录时隐藏窗口启动，进程退出后 5 秒自动重启。',
  };
}

export function buildServicePlan(input: ServicePlanInput): ServicePlan {
  if (input.platform === 'win32') return buildWindowsPlan(input);
  if (input.platform === 'darwin') return buildMacPlan(input);
  return buildLinuxPlan(input);
}

/** 执行计划：写文件 + 逐条执行命令；必需命令失败抛出含输出的错误，可选命令失败只告警。 */
export function executeServicePlan(plan: ServicePlan): void {
  for (const file of plan.files) {
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, { encoding: file.encoding ?? 'utf8' });
    if (file.mode) {
      try {
        chmodSync(file.path, file.mode);
      } catch {
        // Windows 上 chmod 无效，忽略
      }
    }
  }
  for (const step of plan.commands) {
    try {
      execFileSync(step.cmd, step.args, { stdio: 'pipe', timeout: 20_000, encoding: 'utf8' });
    } catch (err) {
      const detail = (err as { stderr?: string; message: string }).stderr?.trim() || (err as Error).message;
      if (step.optional) {
        console.warn(`[service] 可选步骤失败（忽略）：${step.cmd} ${step.args.join(' ')}：${detail}`);
        continue;
      }
      throw new Error(`系统服务命令失败：${step.cmd} ${step.args.join(' ')}：${detail}`);
    }
  }
}
