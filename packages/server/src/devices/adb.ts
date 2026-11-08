// ADB：只在本机执行 adb 命令；跨 Host 由会话 Host 代理到设备 Host。
// 可执行文件来自 TANDEM_ADB_BIN 或设置里的 devices.adbPath，缺省 PATH 中的 adb。
import { spawn } from 'node:child_process';
import { decodeProcessOutput } from '../util/encoding.js';

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
}

export interface AdbResult {
  code: number;
  output: string;
}

export function parseAdbDevices(text: string): AdbDevice[] {
  const list: AdbDevice[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [serial, state, ...rest] = parts;
    if (!serial || !state) continue;
    const meta: Record<string, string> = {};
    for (const item of rest) {
      const idx = item.indexOf(':');
      if (idx > 0) meta[item.slice(0, idx)] = item.slice(idx + 1);
    }
    list.push({
      serial,
      state,
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.product ? { product: meta.product } : {}),
      ...(meta.device ? { device: meta.device } : {}),
      ...(meta.transport_id ? { transportId: meta.transport_id } : {}),
    });
  }
  return list;
}

export class AdbRunner {
  constructor(private readonly bin: () => string) {}

  path(): string {
    return this.bin();
  }

  async list(): Promise<AdbDevice[]> {
    const res = await this.run(['devices', '-l'], 8000);
    if (res.code !== 0 && !/List of devices/.test(res.output)) {
      throw new Error(res.output.trim() || 'adb devices 失败');
    }
    return parseAdbDevices(res.output);
  }

  run(args: string[], timeoutMs = 120_000): Promise<AdbResult> {
    return new Promise((resolve) => {
      const child = spawn(this.bin(), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let timedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // 进程已退出
        }
      }, Math.max(1000, Math.min(timeoutMs, 600_000)));
      const collect = (chunk: Buffer) => {
        if (bytes >= 2_000_000) return;
        chunks.push(chunk);
        bytes += chunk.length;
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, output: `无法执行 ${this.bin()}：${err.message}` });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = decodeProcessOutput(Buffer.concat(chunks));
        resolve({
          code: timedOut ? -1 : code ?? -1,
          output: timedOut ? `${output}\n[超时] adb 命令超过 ${Math.round(timeoutMs / 1000)}s，已终止` : output,
        });
      });
    });
  }
}
