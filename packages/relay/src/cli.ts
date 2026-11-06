#!/usr/bin/env node
// Tandem relay 入口：一条命令即可自托管。
import os from 'node:os';
import path from 'node:path';
import { createRelay } from './server.js';
import type { RelayLimits } from './limits.js';

interface CliOptions {
  port: number;
  host: string;
  dataDir: string;
  trustProxy: boolean;
  limits: Partial<RelayLimits>;
}

function printHelp(): void {
  console.log(`用法: tandem-relay [--port 7950] [--host 127.0.0.1] [--data <目录>] [--trust-proxy]

选项:
  -p, --port <端口>            监听端口（默认 7950，环境变量 PORT）
      --host <地址>            监听地址（默认 127.0.0.1；直接对外暴露用 0.0.0.0，但务必在前面加 TLS）
      --data <目录>            hostId 公钥登记目录（默认 ~/.tandem-relay，环境变量 RELAY_DATA）
      --trust-proxy            信任 X-Forwarded-For（部署在 nginx / Caddy 后面时开启，用于按来源 IP 限流）
      --max-hosts <n>          最多登记的 Host 数（默认 1000）
      --max-streams <n>        单 Host 并发请求/WS 数（默认 256）
      --max-conns-per-ip <n>   单 IP 并发客户端连接数（默认 128）
      --bandwidth <MB/s>       单 Host 双向带宽上限（默认 16，0 = 不限）
  -h, --help                   显示帮助`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    port: Number(process.env.PORT) || 7950,
    host: '127.0.0.1',
    dataDir: process.env.RELAY_DATA?.trim() || path.join(os.homedir(), '.tandem-relay'),
    trustProxy: false,
    limits: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} 缺少参数`);
      i++;
      return value;
    };
    const num = (): number => {
      const n = Number(next());
      if (!Number.isFinite(n) || n < 0) throw new Error(`${arg} 需要非负数字`);
      return n;
    };
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--port' || arg === '-p') options.port = num();
    else if (arg === '--host') options.host = next();
    else if (arg === '--data') options.dataDir = path.resolve(next());
    else if (arg === '--trust-proxy') options.trustProxy = true;
    else if (arg === '--max-hosts') options.limits.maxHosts = num();
    else if (arg === '--max-streams') options.limits.maxStreamsPerHost = num();
    else if (arg === '--max-conns-per-ip') options.limits.maxConnsPerIp = num();
    else if (arg === '--bandwidth') options.limits.bytesPerSec = num() * 1024 * 1024;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`端口无效: ${options.port}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const relay = await createRelay({
    dataDir: options.dataDir,
    trustProxy: options.trustProxy,
    limits: options.limits,
  });
  try {
    await relay.app.listen({ port: options.port, host: options.host });
  } catch (err) {
    console.error(`[relay] 启动失败: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`Tandem relay 已启动: ${options.host}:${options.port}`);
  console.log(`  数据目录: ${options.dataDir}`);
  console.log(`  Host 隧道: ws(s)://<域名>/_tunnel    客户端入口: http(s)://<域名>/h/<hostId>`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await relay.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(`[relay] ${(err as Error).message}`);
  process.exit(1);
});
