// hostId 所有权登记：首次注册绑定 Ed25519 公钥，之后只有同一公钥才能接管。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface Entry {
  pub: string;
  createdAt: number;
  lastSeen: number;
}

export type BindResult = 'new' | 'same' | 'conflict';

export class Registry {
  private hosts = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'registry.json');
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { hosts?: Record<string, Entry> };
        for (const [id, entry] of Object.entries(raw.hosts ?? {})) this.hosts.set(id, entry);
      } catch (err) {
        throw new Error(`无法解析 ${this.file}：${(err as Error).message}`);
      }
    }
  }

  get size(): number {
    return this.hosts.size;
  }

  has(hostId: string): boolean {
    return this.hosts.has(hostId);
  }

  /** 公钥已验证（签名通过）后调用。 */
  bind(hostId: string, pub: string): BindResult {
    const existing = this.hosts.get(hostId);
    const now = Date.now();
    if (!existing) {
      this.hosts.set(hostId, { pub, createdAt: now, lastSeen: now });
      this.scheduleSave();
      return 'new';
    }
    if (existing.pub !== pub) return 'conflict';
    existing.lastSeen = now;
    this.scheduleSave();
    return 'same';
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ hosts: Object.fromEntries(this.hosts) }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    this.timer.unref();
  }
}
