// 工作站上的执行器主机：每台已登记的执行器对应一个远端 Host 上下文。
// 上下文就是普通的 Host（会话、agent 循环、模型代理照常），数据在 <工作站数据目录>/remote-hosts/<hostId>/，
// 工具经 RemoteHostEnv 在执行器上运行。上下文经本机回环隧道接入工作站，客户端仍走 /h/<hostId>（端到端加密，与其他主机一致）。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AccountsStore } from '../accounts/store.js';
import { readJson } from '../config.js';
import type { Host } from '../host.js';
import type { WorkstationTunnelDeps } from '../server.js';
import { ExecutorConn, type ExecutorAuth } from './conn.js';
import { RemoteHostEnv } from './remote-env.js';
import { unb64, type KeyPair } from './wire.js';

interface ExecutorRecord {
  hostId: string;
  name: string;
  platform: string;
  /** 执行器 Ed25519 公钥，base64。 */
  execPub: string;
  enrolledAt: number;
}

interface RemoteContext {
  host: Host;
  app: FastifyInstance;
  deps?: WorkstationTunnelDeps;
  /** 当前已连接的执行器；断开后为 undefined，主机离线。 */
  conn?: ExecutorConn;
}

export interface ExecutorHubOptions {
  /** 工作站数据目录。 */
  home: string;
  store: AccountsStore;
  /** 工作站在本机回环上的地址；远端主机上下文经它接入工作站。 */
  selfUrl: () => string;
}

export class ExecutorHub {
  private readonly root: string;
  private readonly records = new Map<string, ExecutorRecord>();
  private readonly contexts = new Map<string, RemoteContext>();
  readonly auth: ExecutorAuth;

  constructor(private readonly options: ExecutorHubOptions) {
    this.root = path.join(options.home, 'remote-hosts');
    this.auth = {
      get identity(): KeyPair {
        const id = options.store.centerIdentity();
        if (!id) throw new Error('工作站尚未初始化');
        return { priv: id.priv, pub: id.pub };
      },
      execPubOf: (hostId) => {
        const record = this.records.get(hostId);
        return record ? unb64(record.execPub) : undefined;
      },
      enroll: (req) => this.enroll(req),
    };
  }

  /** 工作站启动后调用：为每台已登记的执行器重建远端主机上下文（不等执行器连接）。 */
  async restore(): Promise<void> {
    const saved = readJson<ExecutorRecord[]>(path.join(this.root, 'executors.json')) ?? [];
    for (const record of saved) {
      try {
        const ctx = await this.open(record.hostId, this.options.selfUrl());
        this.records.set(record.hostId, record);
        this.contexts.set(record.hostId, ctx);
      } catch (err) {
        console.warn(`[workstation] 远端主机 ${record.name} 启动失败:`, (err as Error).message);
      }
    }
  }

  async close(): Promise<void> {
    for (const ctx of this.contexts.values()) await ctx.app.close().catch(() => undefined);
    this.contexts.clear();
  }

  /** 执行器握手完成前的 WebSocket（/executor/ws）。 */
  accept(sock: WebSocket): void {
    ExecutorConn.accept(sock, this.auth)
      .then((conn) => this.attach(conn))
      .catch(() => undefined);
  }

  /** 非远端主机恒为 true；远端主机只有执行器连着时为 true。 */
  isLive(hostId: string): boolean {
    const ctx = this.contexts.get(hostId);
    return !ctx || !!ctx.conn;
  }

  private async attach(conn: ExecutorConn): Promise<void> {
    const ctx = this.contexts.get(conn.hostId);
    if (!ctx) {
      conn.close();
      return;
    }
    let env: RemoteHostEnv;
    try {
      env = await RemoteHostEnv.open(conn);
    } catch {
      conn.close();
      return;
    }
    ctx.host.env = env;
    ctx.conn = conn;
    this.options.store.markHostOnline(conn.hostId, true);
    conn.onClose(() => {
      if (ctx.conn !== conn) return;
      ctx.conn = undefined;
      this.options.store.markHostOnline(conn.hostId, false);
    });
  }

  private async enroll(req: { token: string; execPub: Buffer; name: string; platform: string }): Promise<string> {
    const hostId = randomUUID();
    const home = path.join(this.root, hostId);
    const selfUrl = this.options.selfUrl();
    const ctx = await this.open(hostId, selfUrl);
    try {
      // 令牌即绑定码，由工作站校验并登记这台远端主机。
      await ctx.host.accounts.registerAsHost(
        selfUrl,
        { id: hostId, name: req.name || hostId.slice(0, 8), urls: [], platform: req.platform },
        req.token,
      );
    } catch (err) {
      await ctx.app.close().catch(() => undefined);
      fs.rmSync(home, { recursive: true, force: true });
      throw err;
    }
    ctx.deps?.start(selfUrl);
    void ctx.host.enableWorkstationProfiles();
    this.records.set(hostId, {
      hostId,
      name: req.name || hostId.slice(0, 8),
      platform: req.platform,
      execPub: req.execPub.toString('base64'),
      enrolledAt: Date.now(),
    });
    this.contexts.set(hostId, ctx);
    this.save();
    return hostId;
  }

  private async open(hostId: string, selfUrl: string): Promise<RemoteContext> {
    const { Host } = await import('../host.js');
    const { createApp } = await import('../server.js');
    const home = path.join(this.root, hostId);
    fs.mkdirSync(home, { recursive: true });
    // loadHostConfig 沿用目录里已有的 hostId，首次登记前先写入。
    if (!fs.existsSync(path.join(home, 'config.json'))) {
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ hostId }), { mode: 0o600 });
    }
    const host = new Host(undefined, home, { remote: true });
    host.accounts.retargetWorkstation(selfUrl);
    let deps: WorkstationTunnelDeps | undefined;
    const app = await createApp(host, {
      demoHost: true,
      onWorkstationDeps: (next) => {
        deps = next;
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    return { host, app, deps };
  }

  private save(): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(path.join(this.root, 'executors.json'), JSON.stringify([...this.records.values()], null, 2), {
      mode: 0o600,
    });
  }
}
