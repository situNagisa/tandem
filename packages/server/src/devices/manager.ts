// 设备管理器：本机 ADB / 串口枚举、跨 Host 代理解析、串口锁与租约、logcat 流、审计。
// 设备级令牌（dvt_…）只允许访问 /api/devices，吊销即失效。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type {
  DeviceInfo,
  DeviceKind,
  DeviceListResult,
  DeviceLogcatRead,
  DeviceLogcatStart,
  DeviceMount,
  DeviceMountInput,
  DeviceOperationResult,
  DevicePeerToken,
  DevicePeerTokenIssued,
  DeviceState,
  SerialOpenResult,
  SerialReadResult,
  SessionDevices,
} from '@tandem/protocol';
import type { Host } from '../host.js';
import { readJson, writePrivateFile } from '../config.js';
import { IS_DEBUG_FLAVOR } from '../flavor.js';
import { AdbRunner } from './adb.js';
import {
  createDemoBoardConnection,
  demoDeviceInfos,
  demoLogcatLine,
  isDemoDevice,
  runDemoAdb,
} from './demo.js';
import { createSerialTransport, type SerialConnection, type SerialTransport } from './serial.js';

interface StoredMount extends DeviceMount {
  /** 仅 peer：设备所在 Host 的设备级令牌；不返回给客户端。 */
  peerToken?: string;
}

interface StoredPeerToken {
  id: string;
  label: string;
  hash: string;
  createdAt: number;
  lastUsedAt?: number;
}

interface SerialEntry {
  at: number;
  text: string;
}

interface SerialRuntime {
  leaseId: string;
  ownerKey: string;
  mountId: string;
  deviceId: string;
  port: string;
  baud: number;
  writable: boolean;
  shared: boolean;
  entries: SerialEntry[];
  chars: number;
  startCursor: number;
  cursor: number;
  lastUsed: number;
  alive: boolean;
  conn?: SerialConnection;
  unsubscribe?: () => void;
  remote?: { mount: StoredMount; remoteLease: string; timer?: ReturnType<typeof setTimeout> };
}

interface LogcatRuntime {
  streamId: string;
  deviceId: string;
  child?: ChildProcess;
  /** 演示设备的模拟日志定时器。 */
  timer?: ReturnType<typeof setInterval>;
  entries: SerialEntry[];
  chars: number;
  cursor: number;
  alive: boolean;
  remote?: { mount: StoredMount; remoteStreamId: string; cursor: number; timer?: ReturnType<typeof setTimeout>; taskId: string };
}

const SERIAL_RING = 400_000;
const LEASE_IDLE_MS = 10 * 60_000;
const SERIAL_POLL_MS = 300;
const LOGCAT_POLL_MS = 500;

function now(): number {
  return Date.now();
}

function clampText(text: string, max = 20_000): string {
  return text.length > max ? `${text.slice(0, max)}\n…（截断，共 ${text.length} 字符）` : text;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('设备 Host 地址必须是 http/https');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export class DeviceManager {
  readonly dir: string;
  private mounts: StoredMount[] = [];
  private peers: StoredPeerToken[] = [];
  private serials = new Map<string, SerialRuntime>();
  private logcats = new Map<string, LogcatRuntime>();
  private locks = new Map<string, { leaseId: string; ownerKey: string; shared: boolean }>();
  private ops = new Map<string, { sessionId: string; startedAt: number }>();
  private transports = new Map<'mock' | 'node', SerialTransport>();
  private ticker?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly host: Host, home: string) {
    this.dir = path.join(home, 'devices');
    mkdirSync(this.dir, { recursive: true });
    const mounts = readJson<{ mounts?: StoredMount[] }>(path.join(this.dir, 'mounts.json'));
    if (Array.isArray(mounts?.mounts)) {
      this.mounts = mounts.mounts.filter((m) => m && m.id && m.sessionId && m.deviceId);
    }
    const peers = readJson<{ tokens?: StoredPeerToken[] }>(path.join(this.dir, 'peers.json'));
    if (Array.isArray(peers?.tokens)) {
      this.peers = peers.tokens.filter((t) => t && t.id && t.hash);
    }
    this.ticker = setInterval(() => this.reapLeases(), 60_000);
    this.ticker.unref?.();
  }

  private settings(): { adbPath?: string; serialMock?: boolean; allowPeer?: boolean } {
    return this.host.settings().devices ?? {};
  }

  private adbBin(): string {
    return process.env.TANDEM_ADB_BIN?.trim() || this.settings().adbPath?.trim() || 'adb';
  }

  private mockSerial(): boolean {
    if (!IS_DEBUG_FLAVOR) return false;
    if (process.env.TANDEM_MOCK_SERIAL === '1') return true;
    return this.settings().serialMock === true;
  }

  /** 演示设备只在演示工作区存在时出现。 */
  private demoActive(): boolean {
    try {
      return this.host.demo.get().active;
    } catch {
      return false;
    }
  }

  private transport(): SerialTransport {
    const kind = this.mockSerial() ? 'mock' : 'node';
    let transport = this.transports.get(kind);
    if (!transport) {
      transport = createSerialTransport({ mock: kind === 'mock' });
      this.transports.set(kind, transport);
    }
    return transport;
  }

  private persistMounts(): void {
    writePrivateFile(path.join(this.dir, 'mounts.json'), JSON.stringify({ mounts: this.mounts }, null, 2));
  }

  private persistPeers(): void {
    writePrivateFile(path.join(this.dir, 'peers.json'), JSON.stringify({ tokens: this.peers }, null, 2));
  }

  private audit(sessionId: string, deviceId: string, action: string, detail?: string): void {
    try {
      const line = JSON.stringify({
        at: now(),
        sessionId,
        deviceId,
        action,
        ...(detail ? { detail: clampText(detail, 500) } : {}),
      });
      appendFileSync(path.join(this.dir, 'audit.jsonl'), `${line}\n`, { mode: 0o600 });
      chmodSync(path.join(this.dir, 'audit.jsonl'), 0o600);
    } catch {
      // 审计写失败不影响设备操作
    }
  }

  // ---------- 枚举 ----------

  async listLocal(): Promise<DeviceListResult> {
    const adbRunner = new AdbRunner(() => this.adbBin());
    const devices: DeviceInfo[] = [];
    let adb: DeviceListResult['adb'] = { available: false, path: this.adbBin() };
    try {
      const list = await adbRunner.list();
      adb = { available: true, path: this.adbBin() };
      for (const item of list) {
        const op = this.ops.get(`adb:${item.serial}`);
        devices.push({
          id: `adb:${item.serial}`,
          kind: 'adb',
          name: item.model ? item.model.replace(/_/g, ' ') : item.serial,
          detail: `${item.serial}${item.state !== 'device' ? ` · ${item.state}` : ''}`,
          state: item.state === 'device' ? (op ? 'busy' : 'online') : 'offline',
          ...(op ? { ownerSessionId: op.sessionId, ownerLabel: `会话 ${op.sessionId.slice(0, 8)}` } : {}),
          meta: {
            serial: item.serial,
            state: item.state,
            ...(item.model ? { model: item.model } : {}),
            ...(item.product ? { product: item.product } : {}),
            ...(item.device ? { device: item.device } : {}),
            ...(item.transportId ? { transportId: item.transportId } : {}),
          },
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      // adb 没装是正常状态：客户端显示「未检测到 adb · 如何安装 / 设置路径」，不当作错误。
      const missing = /ENOENT|command not found|不是内部或外部命令|系统找不到指定的文件/i.test(message);
      adb = {
        available: false,
        path: this.adbBin(),
        error: message,
        ...(missing ? { missing: true, hint: '未检测到 adb' } : {}),
      };
    }

    let serial: DeviceListResult['serial'] = { available: false, mock: this.mockSerial() };
    try {
      const ports = await this.transport().list();
      serial = { available: true, mock: this.mockSerial() };
      for (const port of ports) {
        const id = `serial:${port.path}`;
        const lock = this.locks.get(id);
        const runtime = lock
          ? [...this.serials.values()].find((s) => s.leaseId === lock.leaseId)
          : undefined;
        devices.push({
          id,
          kind: 'serial',
          name: port.manufacturer || port.path,
          detail: port.path,
          state: lock ? 'busy' : 'online',
          ...(lock
            ? { ownerSessionId: lock.ownerKey, ownerLabel: `会话 ${lock.ownerKey.slice(0, 8)}` }
            : {}),
          meta: {
            path: port.path,
            ...(port.manufacturer ? { manufacturer: port.manufacturer } : {}),
            ...(port.serialNumber ? { serialNumber: port.serialNumber } : {}),
            ...(runtime ? { baud: String(runtime.baud) } : {}),
          },
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      const missing = /serialport|cannot find package|module not found/i.test(message);
      serial = {
        available: false,
        mock: this.mockSerial(),
        error: message,
        ...(missing ? { missing: true, hint: '未安装 serialport' } : {}),
      };
    }

    if (this.demoActive()) devices.push(...demoDeviceInfos());

    const info = this.host.info();
    return {
      host: { id: info.id, name: info.name },
      devices,
      adb,
      serial,
    };
  }

  private async findLocalDevice(deviceId: string): Promise<DeviceInfo | undefined> {
    const list = await this.listLocal();
    return list.devices.find((d) => d.id === deviceId);
  }

  /** 清除演示工作区时一并摘掉演示设备挂载。 */
  removeDemoMounts(): void {
    const removed = this.mounts.filter((m) => isDemoDevice(m.deviceId));
    if (!removed.length) return;
    for (const mount of removed) {
      for (const runtime of [...this.serials.values()]) {
        if (runtime.mountId === mount.id) void this.closeRuntime(runtime);
      }
    }
    this.mounts = this.mounts.filter((m) => !isDemoDevice(m.deviceId));
    this.persistMounts();
    this.host.hub.broadcastAll({ type: 'devices_updated' });
  }

  // ---------- 设备级令牌 ----------

  listPeerTokens(): DevicePeerToken[] {
    return this.peers.map(({ hash: _hash, ...rest }) => rest);
  }

  issuePeerToken(label?: string): DevicePeerTokenIssued {
    const token = `dvt_${randomBytes(24).toString('hex')}`;
    const record: StoredPeerToken = {
      id: `dpt_${randomUUID().slice(0, 8)}`,
      label: (label ?? '').trim() || '设备对端',
      hash: hashToken(token),
      createdAt: now(),
    };
    this.peers.push(record);
    this.persistPeers();
    return { id: record.id, label: record.label, createdAt: record.createdAt, token };
  }

  revokePeerToken(id: string): boolean {
    const before = this.peers.length;
    this.peers = this.peers.filter((t) => t.id !== id);
    if (this.peers.length === before) return false;
    this.persistPeers();
    return true;
  }

  authenticatePeer(token: string): StoredPeerToken | undefined {
    if (!token.startsWith('dvt_')) return undefined;
    if (this.settings().allowPeer === false) return undefined;
    const hash = hashToken(token);
    const found = this.peers.find((t) => t.hash === hash);
    if (!found) return undefined;
    if (!found.lastUsedAt || now() - found.lastUsedAt > 60_000) {
      found.lastUsedAt = now();
      this.persistPeers();
    }
    return found;
  }

  // ---------- 挂载 ----------

  getMount(sessionId: string, mountId: string): StoredMount | undefined {
    return this.mounts.find((m) => m.sessionId === sessionId && m.id === mountId);
  }

  getMountByDevice(sessionId: string, ref: string): StoredMount | undefined {
    const byMountId = this.getMount(sessionId, ref);
    if (byMountId) return byMountId;
    const matches = this.mounts.filter((m) => m.sessionId === sessionId && m.deviceId === ref);
    if (matches.length > 1) {
      throw new Error(`有 ${matches.length} 个主机上都有设备 ${ref}；请用 DeviceList 里的挂载 id（dm_…）指定`);
    }
    return matches[0];
  }

  mountsFor(sessionId: string): DeviceMount[] {
    return this.mounts.filter((m) => m.sessionId === sessionId).map((m) => this.publicMount(m));
  }

  private publicMount(mount: StoredMount): DeviceMount {
    const { peerToken: _token, ...rest } = mount;
    return { ...rest };
  }

  async sessionDevices(sessionId: string): Promise<SessionDevices> {
    const local = (await this.listLocal()).devices.filter(
      (device) =>
        !this.mounts.some(
          (m) => m.sessionId === sessionId && m.source.kind === 'local' && m.deviceId === device.id,
        ),
    );
    return { mounts: this.mountsFor(sessionId), local };
  }

  async mount(sessionId: string, input: DeviceMountInput): Promise<DeviceMount> {
    const deviceId = input.deviceId.trim();
    if (!deviceId) throw new Error('缺少设备标识');
    const peerUrl = input.peerUrl?.trim();
    let source: DeviceMount['source'];
    let state: DeviceState = 'online';
    let name = input.name?.trim() || deviceId;
    let peerToken: string | undefined;
    let hostHint = '';
    if (peerUrl) {
      const url = normalizeBaseUrl(peerUrl);
      peerToken = input.peerToken?.trim();
      if (!peerToken) throw new Error('跨 Host 挂载需要设备级令牌');
      const remote = await this.peerJson<DeviceListResult>(
        { url, token: peerToken },
        '/api/devices',
        { method: 'GET' },
        15_000,
      );
      const device = remote.devices.find((d) => d.id === deviceId);
      if (!device) throw new Error(`设备 ${deviceId} 不在 ${url} 上`);
      if (device.state === 'offline') state = 'offline';
      name = input.name?.trim() || device.name;
      source = {
        kind: 'peer',
        hostId: remote.host?.id ?? url,
        hostName: remote.host?.name ?? url,
        url,
      };
      hostHint = `来自 ${source.hostName}`;
    } else {
      const device = await this.findLocalDevice(deviceId);
      if (!device) throw new Error(`本机没有设备 ${deviceId}`);
      if (device.state === 'offline') state = 'offline';
      name = input.name?.trim() || device.name;
      const info = this.host.info();
      source = { kind: 'local', hostId: info.id, hostName: info.name };
    }
    const existing = this.mounts.find(
      (m) =>
        m.sessionId === sessionId &&
        m.deviceId === deviceId &&
        m.source.kind === source.kind &&
        (source.kind === 'local' || m.source.url === source.url),
    );
    if (existing) return this.publicMount(existing);
    const mount: StoredMount = {
      id: `dm_${randomUUID().slice(0, 8)}`,
      sessionId,
      deviceId,
      kind: deviceId.startsWith('adb:') ? 'adb' : 'serial',
      name,
      source,
      mountedAt: now(),
      state,
      ...(hostHint ? { busy: hostHint } : {}),
      ...(peerToken ? { peerToken } : {}),
    };
    this.mounts.push(mount);
    this.persistMounts();
    this.audit(sessionId, deviceId, 'mount');
    this.host.hub.broadcastAll({ type: 'devices_updated', sessionId });
    return this.publicMount(mount);
  }

  unmount(sessionId: string, mountId: string): boolean {
    const mount = this.getMount(sessionId, mountId);
    if (!mount) return false;
    for (const runtime of [...this.serials.values()]) {
      if (runtime.ownerKey === sessionId && runtime.mountId === mountId) void this.closeRuntime(runtime);
    }
    this.mounts = this.mounts.filter((m) => m !== mount);
    this.persistMounts();
    this.audit(sessionId, mount.deviceId, 'unmount');
    this.host.hub.broadcastAll({ type: 'devices_updated', sessionId });
    return true;
  }

  /** 会话删除时释放设备。 */
  releaseSession(sessionId: string): void {    for (const runtime of [...this.serials.values()]) {
      if (runtime.ownerKey === sessionId) void this.closeRuntime(runtime);
    }
    const removed = this.mounts.some((m) => m.sessionId === sessionId);
    this.mounts = this.mounts.filter((m) => m.sessionId !== sessionId);
    if (removed) this.persistMounts();
  }

  // ---------- ADB ----------

  async execAdb(
    sessionId: string,
    mount: StoredMount | undefined,
    deviceId: string,
    kind: 'shell' | 'install',
    params: { command?: string; apkPath?: string; timeout?: number },
  ): Promise<DeviceOperationResult> {
    if (!mount) throw new Error(`设备 ${deviceId} 未挂载到本会话；请先在「工作站」里挂载`);
    if (mount.kind !== 'adb') throw new Error(`${deviceId} 不是 ADB 设备`);
    const detail = kind === 'install' ? params.apkPath : params.command;
    this.audit(sessionId, deviceId, kind, detail);
    this.ops.set(deviceId, { sessionId, startedAt: now() });
    try {
      if (mount.source.kind === 'peer') {
        return await this.peerJson<DeviceOperationResult>(
          mount,
          `/api/devices/${encodeURIComponent(deviceId)}/exec`,
          {
            method: 'POST',
            body: JSON.stringify({
              kind,
              command: params.command,
              apkPath: params.apkPath,
              timeout: params.timeout,
              client: sessionId,
            }),
          },
          (params.timeout ?? 120_000) + 30_000,
        );
      }
      if (isDemoDevice(deviceId)) return runDemoAdb(kind, params);
      const serial = deviceId.slice('adb:'.length);
      const args =
        kind === 'install'
          ? ['-s', serial, 'install', '-r', String(params.apkPath ?? '')]
          : ['-s', serial, 'shell', String(params.command ?? '')];
      const res = await new AdbRunner(() => this.adbBin()).run(args, params.timeout ?? 120_000);
      return { ok: res.code === 0, output: clampText(res.output), exitCode: res.code };
    } finally {
      this.ops.delete(deviceId);
      this.host.hub.broadcastAll({ type: 'devices_updated' });
    }
  }

  async execDeviceForClient(
    clientId: string,
    deviceId: string,
    kind: 'shell' | 'install',
    params: { command?: string; apkPath?: string; timeout?: number },
  ): Promise<DeviceOperationResult> {
    const device = await this.findLocalDevice(deviceId);
    if (!device || device.kind !== 'adb') throw new Error(`本机没有 ADB 设备 ${deviceId}`);
    this.audit(clientId, deviceId, `remote:${kind}`, params.command ?? params.apkPath);
    this.ops.set(deviceId, { sessionId: clientId, startedAt: now() });
    try {
      if (isDemoDevice(deviceId)) return runDemoAdb(kind, params);
      const serial = deviceId.slice('adb:'.length);
      const args =
        kind === 'install'
          ? ['-s', serial, 'install', '-r', String(params.apkPath ?? '')]
          : ['-s', serial, 'shell', String(params.command ?? '')];
      const res = await new AdbRunner(() => this.adbBin()).run(args, params.timeout ?? 120_000);
      return { ok: res.code === 0, output: clampText(res.output), exitCode: res.code };
    } finally {
      this.ops.delete(deviceId);
      this.host.hub.broadcastAll({ type: 'devices_updated' });
    }
  }

  // ---------- 串口 ----------

  private runtimeKey(ownerKey: string, mountId: string): string {
    return `${ownerKey}\u0000${mountId}`;
  }

  private appendRuntime(runtime: SerialRuntime, text: string): void {
    if (!text || !runtime.alive) return;
    runtime.entries.push({ at: now(), text });
    runtime.chars += text.length;
    runtime.cursor += text.length;
    while (runtime.chars > SERIAL_RING && runtime.entries.length > 1) {
      const removed = runtime.entries.shift()!;
      runtime.chars -= removed.text.length;
      runtime.startCursor += removed.text.length;
    }
    this.host.hub.broadcastAll({
      type: 'device_output',
      sessionId: runtime.ownerKey,
      mountId: runtime.mountId,
      deviceId: runtime.deviceId,
      chunk: text,
      cursor: runtime.cursor,
      at: now(),
    });
  }

  private serialSlice(
    runtime: SerialRuntime,
    since: number,
    opts: { windowMs?: number; filter?: string; maxBytes?: number } = {},
  ): SerialReadResult {
    const from = Math.max(0, Math.floor(since));
    const start = runtime.startCursor;
    const truncated = from < start;
    const cutoff = opts.windowMs && opts.windowMs > 0 ? now() - opts.windowMs : 0;
    let text = runtime.entries
      .filter((entry) => entry.at >= cutoff)
      .map((entry) => entry.text)
      .join('');
    let prefix = 0;
    if (from > start) prefix = Math.min(from - start, text.length);
    text = text.slice(prefix);
    if (opts.filter) {
      let re: RegExp;
      try {
        re = new RegExp(opts.filter, 'i');
      } catch {
        throw new Error(`过滤表达式不合法：${opts.filter}`);
      }
      text = text
        .split('\n')
        .filter((line) => re.test(line))
        .join('\n');
    }
    const maxBytes = Math.max(256, Math.min(opts.maxBytes ?? 60_000, 400_000));
    if (text.length > maxBytes) {
      text = `${text.slice(0, maxBytes)}\n…（输出较长，已截断）`;
    }
    runtime.lastUsed = now();
    return { data: text, cursor: runtime.cursor, alive: runtime.alive, ...(truncated ? { truncated: true } : {}) };
  }

  private async openRuntime(
    ownerKey: string,
    mountId: string,
    deviceId: string,
    baud: number,
    shared: boolean,
    remote?: { mount: StoredMount; remoteLease: string },
  ): Promise<SerialRuntime> {
    const key = this.runtimeKey(ownerKey, mountId);
    const existing = this.serials.get(key);
    if (existing?.alive) return existing;

    const lock = this.locks.get(deviceId);
    let writable = true;
    if (lock) {
      if (lock.ownerKey !== ownerKey) {
        if (!shared) {
          throw new Error(`串口 ${deviceId} 已被会话 ${lock.ownerKey.slice(0, 8)} 独占；只读共享请使用 shared`);
        }
        writable = false;
      } else {
        writable = true;
      }
    }

    let port = deviceId.startsWith('serial:') ? deviceId.slice('serial:'.length) : '';
    if (!remote) {
      const device = await this.findLocalDevice(deviceId);
      port = device?.meta?.path ?? port;
    }
    if (!port) throw new Error(`找不到串口 ${deviceId}`);

    const runtime: SerialRuntime = {
      leaseId: `sl_${randomUUID().slice(0, 8)}`,
      ownerKey,
      mountId,
      deviceId,
      port,
      baud,
      writable,
      shared,
      entries: [],
      chars: 0,
      startCursor: 0,
      cursor: 0,
      lastUsed: now(),
      alive: true,
      ...(remote ? { remote } : {}),
    };
    this.serials.set(key, runtime);
    try {
      if (remote) {
        this.pollRemoteSerial(runtime);
      } else if (isDemoDevice(deviceId)) {
        const conn = createDemoBoardConnection(port, baud);
        runtime.conn = conn;
        runtime.unsubscribe = conn.onData((text) => this.appendRuntime(runtime, text));
      } else {
        const conn = await this.transport().open(port, baud);
        runtime.conn = conn;
        runtime.unsubscribe = conn.onData((text) => this.appendRuntime(runtime, text));
      }
    } catch (err) {
      runtime.alive = false;
      this.serials.delete(key);
      throw err;
    }
    if (!lock) this.locks.set(deviceId, { leaseId: runtime.leaseId, ownerKey, shared: false });
    this.host.hub.broadcastAll({ type: 'devices_updated', sessionId: ownerKey });
    return runtime;
  }

  async openSessionSerial(
    sessionId: string,
    mountId: string,
    baud: number,
    shared = false,
  ): Promise<SerialOpenResult> {
    const mount = this.getMount(sessionId, mountId);
    if (!mount) throw new Error('设备未挂载到本会话');
    if (mount.kind !== 'serial') throw new Error(`${mount.deviceId} 不是串口`);
    this.audit(sessionId, mount.deviceId, 'serial:open', `baud=${baud}${shared ? ' shared' : ''}`);
    if (mount.source.kind === 'peer') {
      const res = await this.peerJson<SerialOpenResult>(
        mount,
        `/api/devices/${encodeURIComponent(mount.deviceId)}/serial/open`,
        { method: 'POST', body: JSON.stringify({ baud, shared, client: sessionId }) },
        20_000,
      );
      const runtime = await this.openRuntime(sessionId, mountId, mount.deviceId, baud, shared, {
        mount,
        remoteLease: res.leaseId,
      });
      // 第一次镜像轮询到达前先等一拍，避免紧跟其后的 SerialRead 看到空缓冲。
      await new Promise((resolve) => setTimeout(resolve, 550));
      return {
        leaseId: runtime.leaseId,
        deviceId: mount.deviceId,
        baud,
        cursor: runtime.cursor,
        writable: runtime.writable,
        ...(res.note ? { note: res.note } : {}),
      };
    }
    const runtime = await this.openRuntime(sessionId, mountId, mount.deviceId, baud, shared);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      leaseId: runtime.leaseId,
      deviceId: mount.deviceId,
      baud,
      cursor: runtime.cursor,
      writable: runtime.writable,
    };
  }

  async openDeviceSerial(
    clientId: string,
    deviceId: string,
    baud: number,
    shared = false,
  ): Promise<SerialOpenResult> {
    const device = await this.findLocalDevice(deviceId);
    if (!device || device.kind !== 'serial') throw new Error(`本机没有串口 ${deviceId}`);
    this.audit(clientId, deviceId, 'remote:serial:open', `baud=${baud}${shared ? ' shared' : ''}`);
    const runtime = await this.openRuntime(clientId, `peer:${clientId}`, deviceId, baud, shared);
    return {
      leaseId: runtime.leaseId,
      deviceId,
      baud,
      cursor: runtime.cursor,
      writable: runtime.writable,
    };
  }

  private leaseRuntime(leaseId: string): SerialRuntime | undefined {
    for (const runtime of this.serials.values()) {
      if (runtime.leaseId === leaseId && runtime.alive) return runtime;
    }
    return undefined;
  }

  readByLease(
    leaseId: string,
    since: number,
    opts: { windowMs?: number; filter?: string; maxBytes?: number } = {},
  ): SerialReadResult {
    const runtime = this.leaseRuntime(leaseId);
    if (!runtime) return { data: '', cursor: 0, alive: false };
    return this.serialSlice(runtime, since, opts);
  }

  async writeByLease(leaseId: string, data: string): Promise<void> {
    const runtime = this.leaseRuntime(leaseId);
    if (!runtime) throw new Error('串口租约不存在或已关闭');
    if (!runtime.writable) throw new Error('当前是只读共享租约，不能写入');
    runtime.lastUsed = now();
    this.audit(runtime.ownerKey, runtime.deviceId, 'serial:write', data);
    if (runtime.remote) {
      await this.peerJson(
        runtime.remote.mount,
        `/api/devices/${encodeURIComponent(runtime.deviceId)}/serial/${encodeURIComponent(runtime.remote.remoteLease)}/write`,
        { method: 'POST', body: JSON.stringify({ data }) },
        15_000,
      );
      return;
    }
    await runtime.conn?.write(data);
  }

  async closeByLease(leaseId: string): Promise<void> {
    const runtime = this.leaseRuntime(leaseId);
    if (runtime) await this.closeRuntime(runtime);
  }

  async readSessionSerial(
    sessionId: string,
    mountId: string,
    since: number,
    opts: { windowMs?: number; filter?: string; maxBytes?: number } = {},
  ): Promise<SerialReadResult> {
    const mount = this.getMount(sessionId, mountId);
    if (!mount) throw new Error('设备未挂载到本会话');
    const runtime = this.serials.get(this.runtimeKey(sessionId, mountId));
    if (!runtime?.alive) return { data: '', cursor: since, alive: false };
    return this.serialSlice(runtime, since, opts);
  }

  async writeSessionSerial(sessionId: string, mountId: string, data: string): Promise<void> {
    const runtime = this.serials.get(this.runtimeKey(sessionId, mountId));
    if (!runtime?.alive) throw new Error('串口未打开');
    await this.writeByLease(runtime.leaseId, data);
  }

  async closeSessionSerial(sessionId: string, mountId: string): Promise<void> {
    const runtime = this.serials.get(this.runtimeKey(sessionId, mountId));
    if (runtime) await this.closeRuntime(runtime);
  }

  private pollRemoteSerial(runtime: SerialRuntime): void {
    if (!runtime.remote || !runtime.alive) return;
    runtime.remote.timer = setTimeout(async () => {
      if (!runtime.alive || this.disposed) return;
      try {
        const res = await this.peerJson<SerialReadResult>(
          runtime.remote!.mount,
          `/api/devices/${encodeURIComponent(runtime.deviceId)}/serial/${encodeURIComponent(runtime.remote!.remoteLease)}?since=${runtime.cursor}&waitMs=0`,
          { method: 'GET' },
          10_000,
        );
        if (res.data) this.appendRuntime(runtime, res.data);
        if (!res.alive) {
          runtime.alive = false;
          this.host.hub.broadcastAll({ type: 'devices_updated', sessionId: runtime.ownerKey });
          this.releaseLock(runtime);
          return;
        }
      } catch {
        // 网络抖动继续重试；设备 Host 长时间不可达时由租约回收
      }
      if (runtime.alive) this.pollRemoteSerial(runtime);
    }, SERIAL_POLL_MS);
    runtime.remote.timer.unref?.();
  }

  private releaseLock(runtime: SerialRuntime): void {
    const lock = this.locks.get(runtime.deviceId);
    if (lock?.leaseId === runtime.leaseId) this.locks.delete(runtime.deviceId);
  }

  private async closeRuntime(runtime: SerialRuntime): Promise<void> {
    if (!runtime.alive && !runtime.remote && !runtime.conn) return;
    runtime.alive = false;
    if (runtime.remote?.timer) clearTimeout(runtime.remote.timer);
    try {
      runtime.unsubscribe?.();
    } catch {
      // ignore
    }
    try {
      await runtime.conn?.close();
    } catch {
      // ignore
    }
    if (runtime.remote) {
      await this.peerJson(
        runtime.remote.mount,
        `/api/devices/${encodeURIComponent(runtime.deviceId)}/serial/${encodeURIComponent(runtime.remote.remoteLease)}/close`,
        { method: 'POST' },
        10_000,
      ).catch(() => undefined);
    }
    this.releaseLock(runtime);
    this.serials.delete(this.runtimeKey(runtime.ownerKey, runtime.mountId));
    this.host.hub.broadcastAll({ type: 'devices_updated', sessionId: runtime.ownerKey });
  }

  private reapLeases(): void {
    const cutoff = now() - LEASE_IDLE_MS;
    for (const runtime of [...this.serials.values()]) {
      if (runtime.lastUsed < cutoff) void this.closeRuntime(runtime);
    }
  }

  // ---------- logcat ----------

  async startSessionLogcat(
    sessionId: string,
    mountId: string,
    filter?: string,
  ): Promise<DeviceLogcatStart> {
    const mount = this.getMount(sessionId, mountId);
    if (!mount) throw new Error('设备未挂载到本会话');
    if (mount.kind !== 'adb') throw new Error('logcat 只支持 ADB 设备');
    this.audit(sessionId, mount.deviceId, 'logcat:start', filter);
    if (mount.source.kind === 'peer') {
      const remote = await this.peerJson<DeviceLogcatStart>(
        mount,
        `/api/devices/${encodeURIComponent(mount.deviceId)}/logcat/start`,
        { method: 'POST', body: JSON.stringify({ filter }) },
        15_000,
      );
      const started = this.mirrorRemoteLogcat(sessionId, mount, remote, filter);
      await new Promise((resolve) => setTimeout(resolve, 900));
      const initial = this.host.tasks.output(started.streamId, 0)?.content ?? '';
      return { ...started, initial };
    }
    const started = this.startLocalLogcat(sessionId, mount.deviceId, filter);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const initial = this.host.tasks.output(started.streamId, 0)?.content ?? '';
    return { ...started, initial };
  }

  private startLocalLogcat(sessionId: string, deviceId: string, filter?: string): DeviceLogcatStart {
    const serial = deviceId.slice('adb:'.length);
    const args = ['-s', serial, 'logcat', '-v', 'time'];
    if (filter?.trim()) args.push(filter.trim());
    const handle = this.host.tasks.startExternal({
      sessionId,
      command: `adb -s ${serial} logcat${filter ? ` ${filter}` : ''}`,
      description: `设备 logcat · ${deviceId}`,
    });
    if (isDemoDevice(deviceId)) {
      let n = 0;
      const timer = setInterval(() => {
        n += 1;
        handle.push(demoLogcatLine(n));
      }, 500);
      timer.unref?.();
      handle.onKill(() => clearInterval(timer));
      const runtime: LogcatRuntime = {
        streamId: handle.task.id,
        deviceId,
        timer,
        entries: [],
        chars: 0,
        cursor: 0,
        alive: true,
      };
      this.logcats.set(runtime.streamId, runtime);
      return { streamId: handle.task.id, taskId: handle.task.id, cursor: 0, initial: '' };
    }
    const child = spawn(new AdbRunner(() => this.adbBin()).path(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => handle.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => handle.push(chunk.toString('utf8')));
    child.on('error', (err) => {
      handle.push(`\n[logcat 启动失败: ${err.message}]\n`);
      handle.finish(-1);
    });
    child.on('close', (code) => handle.finish(code ?? undefined));
    handle.onKill(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    });
    const runtime: LogcatRuntime = {
      streamId: handle.task.id,
      deviceId,
      child,
      entries: [],
      chars: 0,
      cursor: 0,
      alive: true,
    };
    this.logcats.set(runtime.streamId, runtime);
    void runtime;
    return { streamId: handle.task.id, taskId: handle.task.id, cursor: 0, initial: '' };
  }

  private mirrorRemoteLogcat(
    sessionId: string,
    mount: StoredMount,
    remote: DeviceLogcatStart,
    filter?: string,
  ): DeviceLogcatStart {
    const handle = this.host.tasks.startExternal({
      sessionId,
      command: `adb -s ${mount.deviceId.slice(4)} logcat${filter ? ` ${filter}` : ''}（${mount.source.hostName}）`,
      description: `设备 logcat · ${mount.deviceId}`,
    });
    const runtime: LogcatRuntime = {
      streamId: handle.task.id,
      deviceId: mount.deviceId,
      entries: [],
      chars: 0,
      cursor: remote.cursor,
      alive: true,
      remote: {
        mount,
        remoteStreamId: remote.streamId,
        cursor: remote.cursor,
        taskId: handle.task.id,
      },
    };
    this.logcats.set(runtime.streamId, runtime);
    handle.onKill(() => {
      runtime.alive = false;
      if (runtime.remote?.timer) clearTimeout(runtime.remote.timer);
      void this.peerJson(
        mount,
        `/api/devices/${encodeURIComponent(mount.deviceId)}/logcat/${encodeURIComponent(remote.streamId)}/stop`,
        { method: 'POST' },
        10_000,
      ).catch(() => undefined);
    });
    const poll = () => {
      if (!runtime.alive || this.disposed) return;
      runtime.remote!.timer = setTimeout(async () => {
        try {
          const res = await this.peerJson<DeviceLogcatRead>(
            mount,
            `/api/devices/${encodeURIComponent(mount.deviceId)}/logcat/${encodeURIComponent(remote.streamId)}?since=${runtime.remote!.cursor}`,
            { method: 'GET' },
            10_000,
          );
          if (res.data) handle.push(res.data);
          runtime.remote!.cursor = res.cursor;
          if (!res.alive) {
            runtime.alive = false;
            handle.finish(0);
            return;
          }
        } catch {
          // 网络抖动继续
        }
        poll();
      }, LOGCAT_POLL_MS);
      runtime.remote!.timer.unref?.();
    };
    poll();
    return { streamId: handle.task.id, taskId: handle.task.id, cursor: 0, initial: '' };
  }

  private async startDeviceLogcatForClient(
    clientId: string,
    deviceId: string,
    filter?: string,
  ): Promise<DeviceLogcatStart> {
    const device = await this.findLocalDevice(deviceId);
    if (!device || device.kind !== 'adb') throw new Error(`本机没有 ADB 设备 ${deviceId}`);
    this.audit(clientId, deviceId, 'remote:logcat:start', filter);
    if (isDemoDevice(deviceId)) {
      const runtime: LogcatRuntime = {
        streamId: `lc_${randomUUID().slice(0, 8)}`,
        deviceId,
        entries: [],
        chars: 0,
        cursor: 0,
        alive: true,
      };
      let n = 0;
      const timer = setInterval(() => {
        if (!runtime.alive) return;
        n += 1;
        const text = demoLogcatLine(n);
        runtime.entries.push({ at: now(), text });
        runtime.chars += text.length;
        runtime.cursor += text.length;
      }, 500);
      timer.unref?.();
      runtime.timer = timer;
      this.logcats.set(runtime.streamId, runtime);
      return { streamId: runtime.streamId, cursor: 0, initial: '' };
    }
    const serial = deviceId.slice('adb:'.length);
    const args = ['-s', serial, 'logcat', '-v', 'time'];
    if (filter?.trim()) args.push(filter.trim());
    const child = spawn(new AdbRunner(() => this.adbBin()).path(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runtime: LogcatRuntime = {
      streamId: `lc_${randomUUID().slice(0, 8)}`,
      deviceId,
      child,
      entries: [],
      chars: 0,
      cursor: 0,
      alive: true,
    };
    const append = (text: string) => {
      if (!text || !runtime.alive) return;
      runtime.entries.push({ at: now(), text });
      runtime.chars += text.length;
      runtime.cursor += text.length;
      while (runtime.chars > SERIAL_RING && runtime.entries.length > 1) {
        const removed = runtime.entries.shift()!;
        runtime.chars -= removed.text.length;
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => append(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk.toString('utf8')));
    child.on('error', (err) => {
      append(`\n[logcat 启动失败: ${err.message}]\n`);
      runtime.alive = false;
    });
    child.on('close', () => {
      runtime.alive = false;
    });
    this.logcats.set(runtime.streamId, runtime);
    return { streamId: runtime.streamId, cursor: 0, initial: '' };
  }

  readDeviceLogcat(streamId: string, since: number): DeviceLogcatRead {
    const runtime = this.logcats.get(streamId);
    if (!runtime) return { data: '', cursor: since, alive: false };
    const from = Math.max(0, Math.floor(since));
    const text = runtime.entries.map((e) => e.text).join('');
    const dropped = runtime.cursor - text.length;
    const offset = Math.max(from - dropped, 0);
    return {
      data: text.slice(Math.min(offset, text.length)),
      cursor: runtime.cursor,
      alive: runtime.alive,
    };
  }

  stopDeviceLogcat(streamId: string): boolean {
    const runtime = this.logcats.get(streamId);
    if (!runtime) return false;
    runtime.alive = false;
    if (runtime.timer) clearInterval(runtime.timer);
    try {
      runtime.child?.kill('SIGKILL');
    } catch {
      // ignore
    }
    this.logcats.delete(streamId);
    return true;
  }

  // ---------- 会话侧 logcat 读取 ----------

  readSessionLogcat(sessionId: string, mountId: string, streamId: string, since: number): DeviceLogcatRead {
    const mount = this.getMount(sessionId, mountId);
    if (!mount) throw new Error('设备未挂载到本会话');
    const task = this.host.tasks.output(streamId, since);
    if (!task) throw new Error('logcat 流不存在');
    return { data: task.content, cursor: task.since, alive: task.task.status === 'running' };
  }

  async stopSessionLogcat(sessionId: string, mountId: string, streamId: string): Promise<void> {
    const mount = this.getMount(sessionId, mountId);
    if (!mount) throw new Error('设备未挂载到本会话');
    const runtime = this.logcats.get(streamId);
    if (runtime?.remote?.timer) clearTimeout(runtime.remote.timer);
    if (runtime?.timer) clearInterval(runtime.timer);
    runtime && (runtime.alive = false);
    await this.host.tasks.kill(streamId);
    this.logcats.delete(streamId);
  }

  // ---------- 设备 Host 服务接口（供其他 Host 调用） ----------

  async execForClient(
    clientId: string,
    deviceId: string,
    kind: 'shell' | 'install',
    params: { command?: string; apkPath?: string; timeout?: number },
  ): Promise<DeviceOperationResult> {
    return this.execDeviceForClient(clientId, deviceId, kind, params);
  }

  async startLogcatForClient(clientId: string, deviceId: string, filter?: string): Promise<DeviceLogcatStart> {
    return this.startDeviceLogcatForClient(clientId, deviceId, filter);
  }

  // ---------- peer 请求 ----------

  private async peerJson<T>(
    mount: Pick<StoredMount, 'source' | 'peerToken'> | { url: string; token: string },
    pathname: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<T> {
    const base = 'url' in mount ? mount.url : mount.source.url;
    const token = 'token' in mount ? mount.token : mount.peerToken;
    if (!base || !token) throw new Error('设备对端信息不完整');
    const url = `${base.replace(/\/+$/, '')}${pathname}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-tandem-device-client': 'session',
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // 非 JSON
      }
      throw new Error(`设备 Host 返回 ${res.status}：${message.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  dispose(): void {
    this.disposed = true;
    if (this.ticker) clearInterval(this.ticker);
    for (const runtime of [...this.serials.values()]) void this.closeRuntime(runtime);
    for (const runtime of [...this.logcats.values()]) {
      runtime.alive = false;
      if (runtime.remote?.timer) clearTimeout(runtime.remote.timer);
      if (runtime.timer) clearInterval(runtime.timer);
      try {
        runtime.child?.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }
}
