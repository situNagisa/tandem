#!/usr/bin/env node
// Tandem Host 守护进程入口。
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { Host } from './host.js';
import { createApp, type WorkstationTunnelDeps } from './server.js';
import { loadHostConfig, tandemHome } from './config.js';
import { runDoctor } from './doctor.js';
import { createWorkstation } from './workstation/server.js';
import { readVersion } from './host/helpers.js';
import { buildServicePlan, executeServicePlan, redactToken } from './service/install.js';
import { explainJoinFailure } from './workstation/joinFailure.js';
import { joinWorkstation } from './workstation/join.js';

interface CliOptions {
  port: number;
  host: string;
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
  console.log(`用法: tandem-host [--port 7878] [--host 127.0.0.1]
        tandem-host workstation [--port 8481] [--host 0.0.0.0]
        tandem-host join <工作站地址> --token <绑定码> [--name 主机名] [--service] [--dry-run]
        tandem-host doctor [--checks node,git,profiles] [--port 7878] [--host 127.0.0.1]

    workstation  只运行工作站服务（账号、主机登记、授权、连接转发；不跑 agent）
    join         把本机登记为某账号的主机，前台保持到工作站的出站连接（关闭窗口即断开）
                 数据目录取 TANDEM_HOME；--service 另外设置开机自启（下次登录生效，失败只提示）
                 也可用 --username/--password 代替 --token（会向工作站登录一次）
                 --code 是 --token 的别名；--dry-run 只打印计划，不做任何改动

选项:
  -p, --port <端口>   监听端口（Host 默认 7878；workstation 默认 8481）
      --host <地址>   监听地址（默认 127.0.0.1；局域网访问用 0.0.0.0）
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

interface JoinOptions {
  workstationUrl?: string;
  token: string;
  username: string;
  password: string;
  name: string;
  service: boolean;
  dryRun: boolean;
}

function parseJoinArgs(argv: string[]): JoinOptions {
  const options: JoinOptions = {
    token: '',
    username: '',
    password: '',
    name: '',
    service: false,
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
    } else if (arg === '--service') {
      options.service = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  options.workstationUrl = positional[0];
  return options;
}

/** 当前 CLI 入口（开机自启复用同一个 dist/cli.js）。 */
function resolveCliPath(): string {
  const argvPath = process.argv[1];
  if (argvPath && argvPath.endsWith('.js')) return path.resolve(argvPath);
  return fileURLToPath(import.meta.url);
}

function maskedToken(token: string): string {
  return token ? redactToken(token) : '(未提供)';
}

function servicePlanFor(home: string) {
  return buildServicePlan({
    platform: process.platform,
    nodePath: process.execPath,
    cliPath: resolveCliPath(),
    home,
    logFile: path.join(home, 'host.log'),
    userHome: os.homedir(),
  });
}

function printJoinPlan(options: JoinOptions, home: string): void {
  console.log('将执行以下步骤（--dry-run，不做任何网络请求、不启动进程、不写文件）：');
  console.log(`  1. 在数据目录 ${home} 启动本机主机（监听 127.0.0.1 的随机端口）`);
  console.log(`  2. 向 ${options.workstationUrl} 登记本机（令牌 ${maskedToken(options.token)}）`);
  if (options.name) console.log(`     主机名：${options.name}`);
  console.log('     已加入同一工作站时跳过登记，直接连接');
  console.log('  3. 前台保持到工作站的出站连接；关闭窗口或 Ctrl+C 即断开');
  if (options.service) {
    const plan = servicePlanFor(home);
    console.log('  4. 设置开机自启，写入文件：');
    for (const file of plan.files) {
      console.log(`\n     ${file.path}`);
      for (const line of file.content.replace(/\n$/, '').split('\n')) console.log(`       ${line}`);
    }
    console.log('\n     执行命令：');
    for (const step of plan.commands) {
      console.log(`       ${redactToken([step.cmd, ...step.args].join(' '))}${step.optional ? '（失败可忽略）' : ''}`);
    }
    if (plan.note) console.log(`     说明：${plan.note}`);
  }
}

async function closeHost(app: FastifyInstance, host: Host): Promise<void> {
  await app.close().catch(() => undefined);
  host.store.flush();
  await host.shutdown();
}

/** 本机 Host 常驻：续跑中断的会话，收到退出信号时收尾。 */
function serveHost(app: FastifyInstance, host: Host): void {
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
    await closeHost(app, host);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function joinError(err: unknown, workstationUrl: string): Error {
  const raw = (err as Error).message;
  const explained = explainJoinFailure({
    status: (err as { statusCode?: number }).statusCode ?? 0,
    message: raw,
    workstationUrl,
  });
  // 文案已经就是标题时不要重复（「绑定码无效、已使用或已过期：绑定码无效、已使用或已过期」）。
  const head = raw.includes(explained.title) ? raw : `${explained.title}：${raw}`;
  return new Error([head, ...explained.hints.map((line) => `  ${line}`)].join('\n'));
}

async function waitForTunnel(tunnel: WorkstationTunnelDeps): Promise<void> {
  while (!tunnel.status().connected) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function installAutostart(home: string): void {
  try {
    executeServicePlan(servicePlanFor(home));
    console.log('已设置开机自启：下次登录后自动连接工作站；当前窗口保持连接。');
  } catch (err) {
    console.warn(`[tandem] 开机自启设置失败，不影响本次连接：${(err as Error).message}`);
  }
}

/** 登记并前台连接：主机进程自己用令牌登记、自己建立出站隧道，不再通过本机 HTTP 登记。 */
async function joinMain(argv: string[]): Promise<void> {
  const options = parseJoinArgs(argv);
  if (!options.workstationUrl) throw new Error('用法: tandem-host join <工作站地址> --token <绑定码>');
  const workstationUrl = options.workstationUrl;
  const home = tandemHome();
  if (options.dryRun) {
    printJoinPlan(options, home);
    return;
  }

  const host = new Host(loadHostConfig(home), home);
  const holder: { tunnel?: WorkstationTunnelDeps } = {};
  const app = await createApp(host, {
    onWorkstationDeps: (deps) => {
      holder.tunnel = deps;
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = address && typeof address === 'object' ? address.port : 0;

  let workspaceName: string;
  try {
    const status = await joinWorkstation(host, holder.tunnel!, {
      workstationUrl,
      ...(options.token ? { code: options.token } : {}),
      ...(options.username ? { username: options.username, password: options.password } : {}),
      name: options.name || os.hostname(),
      urls: [`http://127.0.0.1:${port}`],
    });
    workspaceName = status.workspace?.name ?? workstationUrl;
  } catch (err) {
    await closeHost(app, host);
    throw joinError(err, workstationUrl);
  }

  console.log(`已加入工作站「${workspaceName}」，正在建立出站连接…`);
  await waitForTunnel(holder.tunnel!);
  if (options.service) installAutostart(home);
  console.log(`已连接工作站「${workspaceName}」，主机名 ${options.name || os.hostname()}；关闭此窗口即断开。`);
  serveHost(app, host);
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
  const host = new Host(config, home);
  const app = await createApp(host);

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
  console.log('');

  serveHost(app, host);
}

main().catch((err) => {
  console.error(`[tandem] ${(err as Error).message}`);
  // 不用 process.exit：Windows + Node 22+（实测 v26.4.0）上，带着 fetch 留下的 keep-alive
  // 连接硬退出会撞 libuv 断言（async.c:94 → 0xC0000409 / 退出码 -1073740791），
  // 把真正的错误盖成「登记失败（退出码 -1073740791）」。让事件循环自然排空后按 exitCode 退出。
  process.exitCode = 1;
});
