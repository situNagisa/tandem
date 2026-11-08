// 个人模式：在桌面端 Host 进程内嵌启动工作站服务（独立数据目录）。
import path from 'node:path';
import { createWorkstation, type WorkstationHandle } from './server.js';

interface Embedded {
  handle: WorkstationHandle;
  urls: string[];
  port: number;
}

const embedded = new Map<string, Embedded>();
const starting = new Map<string, Promise<Embedded>>();

export const WORKSTATION_SUBDIR = 'workstation';

export function embeddedDataDir(home: string): string {
  return path.join(home, WORKSTATION_SUBDIR);
}

export function embeddedStatus(home: string): { running: boolean; urls: string[]; port?: number } {
  const found = embedded.get(path.resolve(home));
  return found ? { running: true, urls: found.urls, port: found.port } : { running: false, urls: [] };
}

/** 启动内嵌工作站；端口从 8481 起，被占用则顺延。可重复调用。 */
export async function startEmbeddedWorkstation(
  home: string,
  bindHost: string,
  version?: string,
): Promise<{ urls: string[]; port: number }> {
  const key = path.resolve(home);
  const existing = embedded.get(key);
  if (existing) return { urls: existing.urls, port: existing.port };
  const pending = starting.get(key);
  if (pending) {
    const done = await pending;
    return { urls: done.urls, port: done.port };
  }
  const task = (async () => {
    const handle = createWorkstation({
      home: embeddedDataDir(key),
      ...(version ? { version } : {}),
    });
    let lastError: unknown;
    for (let port = 8481; port < 8491; port += 1) {
      try {
        const info = await handle.listen(port, bindHost);
        const entry: Embedded = { handle, urls: info.urls, port: info.port };
        embedded.set(key, entry);
        return entry;
      } catch (err) {
        lastError = err;
        if ((err as { code?: string }).code !== 'EADDRINUSE') break;
      }
    }
    await handle.close().catch(() => undefined);
    throw lastError ?? new Error('无法启动内嵌工作站');
  })();
  starting.set(key, task);
  try {
    const done = await task;
    return { urls: done.urls, port: done.port };
  } finally {
    starting.delete(key);
  }
}

export async function stopEmbeddedWorkstations(): Promise<void> {
  for (const [key, entry] of embedded) {
    await entry.handle.close().catch(() => undefined);
    embedded.delete(key);
  }
}
