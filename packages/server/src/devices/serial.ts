// 串口传输层：v1 提供内置虚拟串口（回归）与真实 serialport（可选依赖）。
// serialport 未安装时不阻塞 Host 启动：列端口返回空并给出可读错误。
export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface SerialConnection {
  path: string;
  onData(cb: (text: string) => void): () => void;
  write(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface SerialTransport {
  kind: 'mock' | 'node';
  list(): Promise<SerialPortInfo[]>;
  open(path: string, baud: number): Promise<SerialConnection>;
}

function bootLines(port: string, baud: number): string[] {
  return [
    `[mock] ${port} opened @ ${baud}`,
    '[board] Tandem virtual serial ready',
    '[board] firmware 1.0.0 (mock)',
    '[board] waiting for command',
  ];
}

class MockConnection implements SerialConnection {
  readonly path: string;
  private listeners = new Set<(text: string) => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private closed = false;
  private tick = 0;

  constructor(path: string, private readonly baud: number) {
    this.path = path;
    // 等调用方 attach onData 后再发启动日志。
    setTimeout(() => {
      if (this.closed) return;
      for (const line of bootLines(path, baud)) this.emit(`${line}\n`);
    }, 10);
    const heartbeat = setInterval(() => {
      if (this.closed) return;
      this.tick += 1;
      this.emit(`[board] tick ${this.tick}\n`);
    }, 3000);
    heartbeat.unref?.();
    this.timers.push(heartbeat);
  }

  onData(cb: (text: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(text: string): void {
    for (const cb of this.listeners) cb(text);
  }

  async write(text: string): Promise<void> {
    if (this.closed) throw new Error('串口已关闭');
    const command = text.trim();
    if (/^reset$/i.test(command)) {
      this.emit('[board] reset requested\n');
      for (const line of bootLines(this.path, this.baud)) this.emit(`${line}\n`);
      return;
    }
    this.emit(`[echo] ${text.endsWith('\n') ? text : `${text}\n`}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.listeners.clear();
  }
}

export class MockSerialTransport implements SerialTransport {
  readonly kind = 'mock' as const;
  async list(): Promise<SerialPortInfo[]> {
    return [{ path: 'mock://ttyUSB0', manufacturer: 'Tandem Mock', serialNumber: 'MOCK-USB0' }];
  }
  async open(port: string, baud: number): Promise<SerialConnection> {
    if (!port.startsWith('mock://')) throw new Error('不是虚拟串口');
    return new MockConnection(port, baud);
  }
}

interface SerialPortInstance {
  open(cb: (err?: Error | null) => void): void;
  on(event: 'data', cb: (data: Buffer) => void): void;
  off(event: 'data', cb: (data: Buffer) => void): void;
  write(data: string, cb: (err?: Error | null) => void): void;
  close(cb: (err?: Error | null) => void): void;
  isOpen: boolean;
}
type SerialPortCtor = (new (opts: { path: string; baudRate: number; autoOpen: boolean }) => SerialPortInstance) & {
  list?: () => Promise<Array<Record<string, string | undefined>>>;
};
type SerialPortModule = { SerialPort: SerialPortCtor };

// 避免 TypeScript 在未安装可选依赖时解析模块；运行时再尝试加载。
const loadModule = new Function('name', 'return import(name)') as (name: string) => Promise<unknown>;

class NodeSerialTransport implements SerialTransport {
  readonly kind = 'node' as const;
  private modulePromise?: Promise<SerialPortModule>;

  private load(): Promise<SerialPortModule> {
    this.modulePromise ??= loadModule('serialport').then((mod) => {
      const m = mod as SerialPortModule & { SerialPort?: unknown };
      if (!m?.SerialPort) throw new Error('serialport 模块格式异常');
      return m;
    });
    return this.modulePromise;
  }

  async list(): Promise<SerialPortInfo[]> {
    try {
      const mod = await this.load();
      const list = await (mod.SerialPort as unknown as { list?: () => Promise<Array<Record<string, string | undefined>>> }).list?.();
      return (list ?? [])
        .filter((item) => typeof item.path === 'string' && item.path)
        .map((item) => ({
          path: item.path!,
          ...(item.manufacturer ? { manufacturer: item.manufacturer } : {}),
          ...(item.serialNumber ? { serialNumber: item.serialNumber } : {}),
          ...(item.vendorId ? { vendorId: item.vendorId } : {}),
          ...(item.productId ? { productId: item.productId } : {}),
        }));
    } catch (err) {
      throw new Error(`serialport 不可用：${(err as Error).message}（可设置 TANDEM_MOCK_SERIAL=1 使用虚拟串口）`);
    }
  }

  async open(port: string, baud: number): Promise<SerialConnection> {
    const mod = await this.load();
    const sp = new mod.SerialPort({ path: port, baudRate: baud, autoOpen: false });
    await new Promise<void>((resolve, reject) => {
      sp.open((err) => (err ? reject(new Error(`打开 ${port} 失败：${err.message}`)) : resolve()));
    });
    return {
      path: port,
      onData: (cb) => {
        const handler = (data: Buffer) => cb(data.toString('utf8'));
        sp.on('data', handler);
        return () => sp.off('data', handler);
      },
      write: (text) =>
        new Promise<void>((resolve, reject) => {
          sp.write(text, (err) => (err ? reject(new Error(`写入失败：${err.message}`)) : resolve()));
        }),
      close: () =>
        new Promise<void>((resolve) => {
          if (!sp.isOpen) return resolve();
          sp.close(() => resolve());
        }),
    };
  }
}

export function createSerialTransport(opts: { mock: boolean }): SerialTransport {
  return opts.mock ? new MockSerialTransport() : new NodeSerialTransport();
}
