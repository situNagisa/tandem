// 演示设备：只在演示工作区存在时出现，不依赖真实 adb / serialport。
// 输出是固定剧本（带轻微随机抖动），用于体验工作站、挂载、串口终端与设备工具。
import type { DeviceInfo, DeviceOperationResult } from '@tandem/protocol';
import type { SerialConnection } from './serial.js';

export const DEMO_ADB_ID = 'adb:demo-pixel-8';
export const DEMO_SERIAL_ID = 'serial:demo-board';

const DEMO_IDS = new Set([DEMO_ADB_ID, DEMO_SERIAL_ID]);

export function isDemoDevice(deviceId: string): boolean {
  return DEMO_IDS.has(deviceId);
}

export function demoDeviceInfos(): DeviceInfo[] {
  return [
    {
      id: DEMO_ADB_ID,
      kind: 'adb',
      name: 'Pixel 8（演示）',
      detail: 'demo-pixel-8 · device',
      state: 'online',
      demo: true,
      meta: { serial: 'demo-pixel-8', state: 'device', model: 'Pixel 8', product: 'demo', device: 'demo' },
    },
    {
      id: DEMO_SERIAL_ID,
      kind: 'serial',
      name: '演示串口板（ESP32）',
      detail: 'demo://ttyBOARD0',
      state: 'online',
      demo: true,
      meta: { path: 'demo://ttyBOARD0', manufacturer: 'Tandem Demo Board', baud: '115200' },
    },
  ];
}

function demoBattery(): number {
  return 70 + Math.floor(Math.random() * 20);
}

export function runDemoAdb(
  kind: 'shell' | 'install',
  params: { command?: string; apkPath?: string },
): DeviceOperationResult {
  if (kind === 'install') {
    const apk = params.apkPath?.trim() || 'app.apk';
    return { ok: true, output: `Performing Streamed Install\nSuccess\n（演示设备：未真正安装 ${apk}）`, exitCode: 0 };
  }
  const command = (params.command ?? '').trim();
  const lines = (() => {
    switch (command) {
      case 'getprop ro.product.model':
        return ['Pixel 8'];
      case 'getprop ro.build.version.release':
        return ['15'];
      case 'getprop ro.serialno':
        return ['demo-pixel-8'];
      case 'pm list packages':
        return [
          'package:com.android.settings',
          'package:com.tandem.demo',
          'package:com.android.chrome',
          'package:com.example.notes',
        ];
      case 'ls /sdcard':
      case 'ls -l /sdcard':
        return ['Android', 'Download', 'DCIM', 'Documents'];
      case 'dumpsys battery':
        return ['Current Battery Service state:', '  AC powered: false', '  USB powered: true', `  level: ${demoBattery()}`];
      case 'wm size':
        return ['Physical size: 1080x2400'];
      default:
        return [`[demo-adb] shell: ${command || '(空命令)'}`];
    }
  })();
  return { ok: true, output: `${lines.join('\n')}\n`, exitCode: 0 };
}

export function demoLogcatLine(n: number): string {
  const level = n % 7 === 0 ? 'I' : n % 5 === 0 ? 'W' : 'D';
  const tag = ['DemoApp', 'ActivityManager', 'Choreographer', 'DemoNet'][n % 4]!;
  const message = [
    'frame rendered in 6ms',
    'network request completed: /api/demo',
    'tick from demo provider',
    'cache hit: demo-entry',
  ][n % 4]!;
  return `11-08 12:00:${String(n % 60).padStart(2, '0')}.000  1234  1234 ${level} ${tag}: ${message} (#${n})\n`;
}

const BOARD_BOOT = [
  '[board] ESP32 demo board 1.4.0',
  '[board] wifi: connected (demo-ap)',
  '[board] sensors: ready',
  '[board] type `help` for commands',
];

/** 演示串口板：启动日志 + 周期性传感器输出；help/reboot/status 有回显。 */
class DemoBoardConnection implements SerialConnection {
  readonly path: string;
  private listeners = new Set<(text: string) => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private closed = false;
  private tick = 0;

  constructor(path: string, private readonly baud: number) {
    this.path = path;
    setTimeout(() => {
      if (this.closed) return;
      this.emit(`${BOARD_BOOT.join('\n')}\n[board] listening @ ${baud}\n`);
    }, 10);
    const heartbeat = setInterval(() => {
      if (this.closed) return;
      this.tick += 1;
      const temp = (31 + Math.random() * 3).toFixed(1);
      this.emit(`[board] tick ${this.tick} · temp=${temp}C · heap=${40000 - this.tick * 7}B\n`);
    }, 2000);
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
    const command = text.trim().toLowerCase();
    if (command === 'help') {
      this.emit('[board] commands: help · status · reboot · read <sensor> · set <key> <value>\n');
      return;
    }
    if (command === 'status') {
      this.emit(`[board] uptime=${this.tick * 2}s temp=${(31 + Math.random() * 3).toFixed(1)}C wifi=connected\n`);
      return;
    }
    if (command === 'reboot') {
      this.emit('[board] rebooting…\n');
      setTimeout(() => {
        if (!this.closed) this.emit(`${BOARD_BOOT.join('\n')}\n`);
      }, 600);
      return;
    }
    const read = /^read\s+(\w+)$/.exec(command);
    if (read) {
      this.emit(`[board] ${read[1]}=${(Math.random() * 100).toFixed(2)}\n`);
      return;
    }
    this.emit(`[board] echo: ${text.endsWith('\n') ? text : `${text}\n`}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.listeners.clear();
  }
}

export function createDemoBoardConnection(path: string, baud: number): SerialConnection {
  return new DemoBoardConnection(path, baud);
}
