#!/usr/bin/env node
// Tandem Host 守护进程入口。
import { Host } from './host.js';
import { createApp } from './server.js';
import { loadHostConfig, tandemHome } from './config.js';

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

选项:
  -p, --port <端口>   监听端口（默认 7878）
      --host <地址>   监听地址（默认 127.0.0.1；局域网访问用 0.0.0.0）
  -h, --help          显示帮助

环境变量:
  TANDEM_HOME         数据目录（默认 ~/.tandem）`);
}

async function main(): Promise<void> {
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

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n[tandem] 收到 ${signal}，正在退出…`);
    try {
      await app.close();
    } catch {
      // ignore
    }
    host.store.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[tandem] ${(err as Error).message}`);
  process.exit(1);
});
