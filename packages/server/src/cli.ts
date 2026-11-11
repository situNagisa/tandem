#!/usr/bin/env node
// Tandem 工作站服务入口：账号、主机登记、会话、agent 与 Web UI 都在这个进程里。
import { Host } from './host.js';
import { loadHostConfig, tandemHome } from './config.js';
import { runDoctor } from './doctor.js';
import { createWorkstation } from './workstation/server.js';
import { readVersion } from './host/helpers.js';

interface CliOptions {
  port: number;
  host: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { port: 8481, host: '127.0.0.1' };
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
  console.log(`用法: tandem-host [--port 8481] [--host 127.0.0.1]
        tandem-host doctor [--checks node,git,profiles] [--json]

  启动的是工作站服务（账号、主机登记、会话与 agent，以及 Web UI）。
  客户端（浏览器 / 桌面窗口 / 手机）只连工作站；运行工作站的这台机器作为一台主机登记后即可使用。

选项:
  -p, --port <端口>   监听端口（默认 8481）
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
  let port = 0;
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

async function main(): Promise<void> {
  if (process.argv[2] === 'doctor') {
    await doctorMain(process.argv.slice(3));
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const home = tandemHome();
  const handle = createWorkstation({ home, version: readVersion() });
  let info: { port: number; urls: string[] };
  try {
    info = await handle.listen(options.port, options.host);
  } catch (err) {
    console.error(`[tandem] 工作站启动失败: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log('');
  console.log('Tandem 工作站已启动');
  console.log(`  访问:     http://127.0.0.1:${info.port}/`);
  for (const url of info.urls.filter((u) => !u.includes('127.0.0.1'))) console.log(`  局域网:   ${url}`);
  console.log(`  监听:     ${options.host}:${info.port}`);
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

main().catch((err) => {
  console.error(`[tandem] ${(err as Error).message}`);
  // 不用 process.exit：Windows + Node 22+ 上带着 fetch 留下的 keep-alive
  // 连接硬退出会撞 libuv 断言。让事件循环自然排空后按 exitCode 退出。
  process.exitCode = 1;
});
