#!/usr/bin/env node
// Tandem Host 守护进程入口。
import { closeSync, mkdirSync, openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Host } from './host.js';
import { createApp } from './server.js';
import { loadHostConfig, saveRelayConfig, tandemHome } from './config.js';
import { runDoctor } from './doctor.js';
import { RelayAgent } from './relay/agent.js';
import { generateHostKey } from './relay/e2e.js';
import { createWorkstation } from './workstation/server.js';
import { readVersion } from './host/helpers.js';
import { buildServicePlan, executeServicePlan, redactToken } from './service/install.js';

interface CliOptions {
  port: number;
  host: string;
  relay?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { port: 7878, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} 缺少参数`);
      i++;
      return value;
    };
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--port' || arg === '-p') {
      options.port = Number(next());
    } else if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice('--port='.length));
    } else if (arg === '--host') {
      options.host = next();
    } else if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length);
    } else if (arg === '--relay') {
      options.relay = next();
    } else if (arg.startsWith('--relay=')) {
      options.relay = arg.slice('--relay='.length);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`端口无效: ${options.port}`);
  }
  return options;
}

function printHelp(): void {
  console.log(`用法: tandem-host [--port 7878] [--host 127.0.0.1] [--relay wss://relay.example.com]
      tandem-host workstation [--port 8481] [--host 0.0.0.0]
      tandem-host join <工作站地址> --token <绑定码> [--service|--no-service] [--name 主机名] [--port 7878] [--dry-run]
      tandem-host doctor [--checks node,git,profiles] [--port 7878] [--host 127.0.0.1]

  workstation  只运行工作站服务（账号、主机登记、授权、连接转发；不跑 agent）
  join         把本机登记为某账号的主机，并建立到工作站的出站隧道
               未运行时默认起后台进程；--service 安装为开机自启服务，--no-service 只起后台进程
               也可用 --username/--password 代替 --token（会向工作站登录一次）
               --code 是 --token 的别名；--dry-run 只打印计划，不做任何改动

选项:
  -p, --port <端口>   监听端口（Host 默认 7878；workstation 默认 8481）
      --host <地址>   监听地址（默认 127.0.0.1；局域网访问用 0.0.0.0）
      --relay <URL>   经中继服务让异地客户端连入（写入 config.json 的 relay，之后无需再传）
  -h, --help          显示帮助

doctor 选项:
  --checks <列表>     只执行指定检查（逗号分隔），如 node,git,profiles
                      profiles 会向已配置的模型服务商发送最小请求，可能产生少量费用
  --json              输出 JSON（供脚本处理）

环境变量:
  TANDEM_HOME         数据目录（默认 ~/.tandem）`);
}

async function doctorMain(argv: string[]): Promise<void> {
  let checks: string[] | undefined;
  let port = 7878;
  let host = '127.0.0.1';
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} 缺少参数`);
      i++;
      return value;
    };
    if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    }
    if (arg === '--json') {
      json = true;
    } else if (arg === '--checks' || arg.startsWith('--checks=')) {
      const value = arg.includes('=') ? arg.slice('--checks='.length) : next();
      checks = value.split(',').map((item) => item.trim()).filter(Boolean);
    } else if (arg === '--port' || arg === '-p' || arg.startsWith('--port=')) {
      port = Number(arg.includes('=') ? arg.slice('--port='.length) : next());
    } else if (arg === '--host' || arg.startsWith('--host=')) {
      host = arg.includes('=') ? arg.slice('--host='.length) : next();
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`端口无效: ${port}`);
  const home = tandemHome();
  const config = loadHostConfig(home);
  const doctorHost = new Host(config, home);
  try {
    const report = await runDoctor(doctorHost, {
      ...(checks && checks.length > 0 ? { checks } : {}),
      listen: { host, port },
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('');
      console.log(report.text.trimEnd());
      console.log('');
    }
    process.exitCode = report.checks.some((item) => item.status === 'fail') ? 1 : 0;
  } finally {
    await doctorHost.shutdown();
  }
}

async function workstationMain(argv: string[]): Promise<void> {
  let port = 8481;
  let host = '127.0.0.1';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} 缺少参数`);
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    }
    if (arg === '--port' || arg === '-p' || arg.startsWith('--port=')) {
      port = Number(arg.includes('=') ? arg.slice('--port='.length) : next());
    } else if (arg === '--host' || arg.startsWith('--host=')) {
      host = arg.includes('=') ? arg.slice('--host='.length) : next();
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`端口无效: ${port}`);
  const home = tandemHome();
  const handle = createWorkstation({ home, version: readVersion() });
  const info = await handle.listen(port, host);
  console.log('');
  console.log('Tandem 工作站已启动');
  console.log(`  访问:     ${info.urls[0]}`);
  for (const url of info.urls.slice(1)) console.log(`  局域网:   ${url}`);
  console.log(`  监听:     ${host}:${info.port}`);
  console.log(`  数据目录: ${home}`);
  console.log('  首次打开页面可创建管理员账号；内网用户可直接注册。');
  console.log('');
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n[workstation] 收到 ${signal}，正在退出…`);
    await handle.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

type JoinStartMode = 'auto' | 'service' | 'background';

interface JoinOptions {
  workstationUrl?: string;
  token: string;
  username: string;
  password: string;
  name: string;
  port: number;
  mode: JoinStartMode;
  dryRun: boolean;
}

function parseJoinArgs(argv: string[]): JoinOptions {
  const options: JoinOptions = {
    token: '',
    username: '',
    password: '',
    name: '',
    port: 7878,
    mode: 'auto',
    dryRun: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} 缺少参数`);
      i += 1;
      return value;
    };
    const inline = () => (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : next());
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--token' || arg === '--code' || arg.startsWith('--token=') || arg.startsWith('--code=')) {
      options.token = inline();
    } else if (arg === '--username' || arg === '--user' || arg.startsWith('--username=') || arg.startsWith('--user=')) {
      options.username = inline();
    } else if (arg === '--password' || arg.startsWith('--password=')) {
      options.password = inline();
    } else if (arg === '--name' || arg.startsWith('--name=')) {
      options.name = inline();
    } else if (arg === '--port' || arg === '-p' || arg.startsWith('--port=')) {
      options.port = Number(inline());
    } else if (arg === '--service') {
      options.mode = 'service';
    } else if (arg === '--no-service') {
      options.mode = 'background';
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  options.workstationUrl = positional[0];
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`端口无效: ${options.port}`);
  }
  return options;
}

/** 当前 CLI 入口（后台进程/系统服务复用同一个 dist/cli.js）。 */
function resolveCliPath(): string {
  const argvPath = process.argv[1];
  if (argvPath && argvPath.endsWith('.js')) return path.resolve(argvPath);
  return fileURLToPath(import.meta.url);
}

function maskedToken(token: string): string {
  return token ? redactToken(token) : '(未提供)';
}

function servicePlanFor(options: JoinOptions, home: string) {
  return buildServicePlan({
    platform: process.platform,
    nodePath: process.execPath,
    cliPath: resolveCliPath(),
    home,
    port: options.port,
    logFile: path.join(home, 'host.log'),
    userHome: os.homedir(),
    ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
  });
}

async function hostIsRunning(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/accounts/status`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const data = (await res.json()) as { mode?: unknown };
    return typeof data.mode === 'string';
  } catch {
    return false;
  }
}

async function waitForHost(base: string, home: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/accounts/status`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = (await res.json()) as { mode?: unknown };
        if (typeof data.mode === 'string') return;
        last = '响应不是 Tandem Host';
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待本机 Host（${base}）就绪超时：${last}；请查看日志 ${path.join(home, 'host.log')}`);
}

/** 未装系统服务时起一个脱离终端的 Host 进程，日志写 TANDEM_HOME/host.log。 */
function startBackgroundHost(home: string, port: number): void {
  mkdirSync(home, { recursive: true });
  const logFile = path.join(home, 'host.log');
  // 日志里有启动 URL（含本机 token），按私有文件创建。
  const fd = openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [resolveCliPath(), '--port', String(port), '--host', '127.0.0.1'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: home,
      env: { ...process.env, TANDEM_HOME: home },
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  console.log(`本机 Host 已在后台启动（日志 ${logFile}）。`);
}

function printJoinPlan(options: JoinOptions, home: string): void {
  const url = options.workstationUrl!;
  console.log('将执行以下步骤（--dry-run，不做任何网络请求、不启动进程、不写文件）：');
  console.log(`  1. 检查本机 Host：http://127.0.0.1:${options.port}`);
  if (options.mode === 'service') {
    const plan = servicePlanFor(options, home);
    console.log('     未运行时安装系统服务，写入文件：');
    for (const file of plan.files) {
      console.log(`\n     ${file.path}`);
      for (const line of file.content.replace(/\n$/, '').split('\n')) console.log(`       ${line}`);
    }
    console.log('\n     执行命令：');
    for (const step of plan.commands) {
      console.log(`       ${redactToken([step.cmd, ...step.args].join(' '))}${step.optional ? '（失败可忽略）' : ''}`);
    }
    if (plan.note) console.log(`     说明：${plan.note}`);
  } else if (options.mode === 'background') {
    console.log(`     未运行时起后台进程：${process.execPath} ${resolveCliPath()} --port ${options.port} --host 127.0.0.1`);
    console.log(`     日志：${path.join(home, 'host.log')}（不安装系统服务；重启后需重新运行）`);
  } else {
    console.log('     未运行时起后台进程（不安装系统服务），并提示「重启后需再运行」。');
    console.log('     加 --service 则改为安装系统服务（开机自启、断线自动重连）。');
  }
  console.log(`  2. 等待 Host 就绪，然后向 ${url} 登记本机（令牌 ${maskedToken(options.token)}）。`);
  if (options.name) console.log(`     主机名：${options.name}`);
}

async function joinMain(argv: string[]): Promise<void> {
  const options = parseJoinArgs(argv);
  if (!options.workstationUrl) throw new Error('用法: tandem-host join <工作站地址> --token <绑定码>');
  const home = tandemHome();
  const base = `http://127.0.0.1:${options.port}`;
  if (options.dryRun) {
    printJoinPlan(options, home);
    return;
  }

  const config = loadHostConfig(home);
  if (!(await hostIsRunning(base))) {
    if (options.mode === 'service') {
      const plan = servicePlanFor(options, home);
      try {
        executeServicePlan(plan);
        console.log('已安装系统服务 tandem-host（开机自启、断线自动重连）。');
      } catch (err) {
        console.warn(`[tandem] 系统服务安装失败：${(err as Error).message}`);
        console.warn('[tandem] 已改为后台进程；系统重启后需要重新运行 tandem-host join。');
        startBackgroundHost(home, options.port);
      }
    } else {
      startBackgroundHost(home, options.port);
      console.log('未安装为后台服务，重启后需再运行 tandem-host join（加 --service 可安装开机自启服务）。');
    }
    await waitForHost(base, home);
  }

  let res: Response;
  try {
    res = await fetch(`${base}/api/workstation/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({
        workstationUrl: options.workstationUrl,
        ...(options.token ? { code: options.token } : {}),
        ...(!options.token && options.username ? { username: options.username, password: options.password } : {}),
        ...(options.name ? { name: options.name } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`无法连接本机 Host（${base}）：${(err as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as { workspace?: { name?: string }; error?: string };
  if (!res.ok) throw new Error(data.error ?? `加入失败：HTTP ${res.status}`);
  console.log(`已加入工作站「${data.workspace?.name ?? options.workstationUrl}」；本机将主动建立出站隧道。`);
}

async function main(): Promise<void> {
  if (process.argv[2] === 'doctor') {
    await doctorMain(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'workstation') {
    await workstationMain(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'join') {
    await joinMain(process.argv.slice(3));
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const home = tandemHome();
  const config = loadHostConfig(home);
  // 启用中继：--relay 写入 config.json（hostKey 首次自动生成），之后无需再传
  const relayUrl = options.relay ?? config.relay?.url;
  if (relayUrl) {
    const hostKey = config.relay?.hostKey ?? generateHostKey();
    if (relayUrl !== config.relay?.url || hostKey !== config.relay?.hostKey) {
      saveRelayConfig(home, { ...config.relay, url: relayUrl, hostKey });
    }
    config.relay = { ...config.relay, url: relayUrl, hostKey };
  }
  let relayAgent: RelayAgent | undefined;
  const host = new Host(config, home);
  const app = await createApp(host, { relay: { pairInfo: () => relayAgent?.pairInfo() } });

  try {
    await app.listen({ port: options.port, host: options.host });
  } catch (err) {
    console.error(`[tandem] 启动失败: ${(err as Error).message}`);
    process.exit(1);
  }

  const address = app.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : options.port;
  const displayHost =
    options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;

  console.log('');
  console.log('Tandem Host 已启动');
  console.log(`  访问:     http://${displayHost}:${actualPort}/?token=${config.token}`);
  console.log(`  监听:     ${options.host}:${actualPort}`);
  console.log(`  数据目录: ${home}`);
  console.log(`  Host ID:  ${config.hostId}`);
  if (config.relay?.hostKey) {
    relayAgent = new RelayAgent({ ...config.relay, hostKey: config.relay.hostKey }, config.hostId, actualPort);
    relayAgent.start();
    const info = relayAgent.pairInfo();
    console.log(`  中继:     ${info.url}${info.requireE2E ? '（仅加密）' : ''}`);
    console.log(`  公钥指纹: ${info.fingerprint.match(/.{8}/g)!.join(' ')}`);
    console.log('            （客户端用加密通道连接时需核对此指纹）');
  }
  console.log('');

  // Host 重启恢复：续跑中断的会话（或按设置暂停），并提示丢失的后台任务
  void host
    .recoverAfterRestart()
    .catch((err) => {
      console.warn(`[tandem] 重启恢复失败:`, (err as Error).message);
    })
    .finally(() => host.boards.start());

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n[tandem] 收到 ${signal}，正在退出…`);
    relayAgent?.stop();
    try {
      await app.close();
    } catch {
      // ignore
    }
    host.store.flush();
    await host.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[tandem] ${(err as Error).message}`);
  process.exit(1);
});
