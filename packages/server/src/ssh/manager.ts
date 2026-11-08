// 远程主机（SSH 一键接入）：部署、隧道保活、重启/升级/日志/卸载。
// 只使用本机 ssh / scp / ssh-keyscan / ssh-keygen；不访问公网下载任何东西。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  RemoteSshHost,
  SshAuthInput,
  SshDeployResult,
  SshHostInput,
  SshHostKeyInfo,
  SshHostState,
  SshJob,
  SshProbeResult,
  SshStep,
  SshStepStatus,
} from '@tandem/protocol';
import {
  SshError,
  normalizeTarget,
  runScp,
  runSsh,
  scanHostKey,
  startTunnelProcess,
  targetLabel,
  type SshAuth,
  type TunnelProcess,
} from './exec.js';
import { buildHostPackage, buildNodePackage, nodeUploadInfo, normArch } from './package.js';
import {
  installServiceScript,
  logsScript,
  prepareScript,
  probeScript,
  restartScript,
  uninstallScript,
  verifyNodeScript,
} from './remote.js';

interface StoredSshHost {
  id: string;
  name: string;
  user: string;
  host: string;
  port: number;
  authKind: SshAuthInput['kind'];
  keyPath?: string;
  nodePath?: string;
  remotePort: number;
  listenLan: boolean;
  localPort: number;
  token: string;
  hostName: string;
  service?: 'systemd' | 'nohup';
  installedAt: number;
  lastConnectedAt?: number;
  remoteVersion?: string;
  lastError?: string;
  system?: { platform: string; arch: string; hostname: string; homeDir: string; nodeVersion?: string };
}

interface Runtime {
  child?: ReturnType<typeof spawn>;
  tunnel?: TunnelProcess;
  password?: string;
  needsPassword: boolean;
  state: SshHostState;
  wanted: boolean;
  latencyMs?: number;
  remoteVersion?: string;
  lastError?: string;
  reconnect?: NodeJS.Timeout;
  stderr: string;
}

const DEPLOY_STEPS: Array<{ id: string; title: string }> = [
  { id: 'verify', title: '校验主机指纹' },
  { id: 'probe', title: '检测远程系统与 Node' },
  { id: 'package', title: '打包本机 Host' },
  { id: 'upload', title: '上传到 ~/.tandem-host' },
  { id: 'config', title: '解压并写入配置' },
  { id: 'service', title: '安装并启动服务' },
  { id: 'tunnel', title: '建立 SSH 隧道' },
  { id: 'verify-host', title: '验证远程 Host' },
];

function normFp(value: string): string {
  const text = String(value ?? '').trim();
  if (!/^sha256:/i.test(text)) throw new SshError('缺少 SHA256 主机公钥指纹');
  return `SHA256:${text.slice(7)}`;
}

function parseProbe(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    if (key.startsWith('TANDEM_')) out[key] = line.slice(idx + 1);
  }
  return out;
}

function majorOf(version?: string): number {
  const match = String(version ?? '').match(/^v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('无法分配本地端口'))));
    });
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export class SshRemoteManager {
  private home: string;
  private localVersion: string;
  private file: string;
  private knownHosts: string;
  private records = new Map<string, StoredSshHost>();
  private runtimes = new Map<string, Runtime>();
  private jobs = new Map<string, SshJob>();
  private keyCache = new Map<string, { at: number; key: SshHostKeyInfo }>();
  private healthTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(home: string, localVersion: string) {
    this.home = home;
    this.localVersion = localVersion;
    this.file = path.join(home, 'ssh-hosts.json');
    this.knownHosts = path.join(home, 'ssh_known_hosts');
    mkdirSync(home, { recursive: true });
    mkdirSync(path.dirname(this.knownHosts), { recursive: true });
    this.load();
    this.healthTimer = setInterval(() => void this.tick(), 15_000);
    this.healthTimer.unref?.();
    setTimeout(() => {
      if (this.closed) return;
      for (const rec of this.records.values()) void this.resume(rec);
    }, 400).unref?.();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as { hosts?: StoredSshHost[] };
      for (const rec of data.hosts ?? []) {
        if (!rec?.id || !rec.user || !rec.host || !rec.token) continue;
        this.records.set(rec.id, rec);
        this.runtimes.set(rec.id, {
          needsPassword: rec.authKind === 'password',
          state: 'offline',
          wanted: true,
          remoteVersion: rec.remoteVersion,
          stderr: '',
        });
      }
    } catch (err) {
      console.warn('[tandem] 读取 ssh-hosts.json 失败:', (err as Error).message);
    }
  }

  private save(): void {
    const hosts = [...this.records.values()];
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, hosts }, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* Windows 忽略 */
    }
  }

  private rt(id: string): Runtime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = { needsPassword: false, state: 'offline', wanted: true, stderr: '' };
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  private authOf(rec: StoredSshHost, rt: Runtime): SshAuth {
    return {
      kind: rec.authKind,
      ...(rec.keyPath ? { keyPath: rec.keyPath } : {}),
      ...(rt.password !== undefined ? { password: rt.password } : {}),
    };
  }

  private targetOf(rec: StoredSshHost) {
    return normalizeTarget({ user: rec.user, host: rec.host, port: rec.port });
  }

  private view(rec: StoredSshHost): RemoteSshHost {
    const rt = this.rt(rec.id);
    return {
      id: rec.id,
      name: rec.name,
      target: { user: rec.user, host: rec.host, port: rec.port },
      authKind: rec.authKind,
      ...(rec.keyPath ? { keyPath: rec.keyPath } : {}),
      ...(rt.needsPassword ? { needsPassword: true } : {}),
      state: rt.state,
      remotePort: rec.remotePort,
      listenLan: rec.listenLan,
      localPort: rec.localPort,
      localUrl: `http://127.0.0.1:${rec.localPort}`,
      token: rec.token,
      hostName: rec.hostName,
      ...(rec.service ? { service: rec.service } : {}),
      ...(rt.remoteVersion || rec.remoteVersion ? { remoteVersion: rt.remoteVersion ?? rec.remoteVersion } : {}),
      localVersion: this.localVersion,
      upgradeAvailable: !!(rt.remoteVersion ?? rec.remoteVersion) &&
        (rt.remoteVersion ?? rec.remoteVersion) !== this.localVersion,
      ...(rt.latencyMs !== undefined ? { latencyMs: rt.latencyMs } : {}),
      installedAt: rec.installedAt,
      ...(rec.lastConnectedAt ? { lastConnectedAt: rec.lastConnectedAt } : {}),
      ...(rt.lastError || rec.lastError ? { lastError: rt.lastError ?? rec.lastError } : {}),
      ...(rec.system ? { system: rec.system } : {}),
    };
  }

  list(): RemoteSshHost[] {
    return [...this.records.values()]
      .sort((a, b) => a.installedAt - b.installedAt)
      .map((rec) => this.view(rec));
  }

  job(id: string): SshJob | undefined {
    return this.jobs.get(id);
  }

  async scanKey(input: { target: SshHostInput['target'] }): Promise<SshHostKeyInfo> {
    const target = normalizeTarget(input.target);
    const cacheKey = targetLabel(target);
    const cached = this.keyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 120_000) return cached.key;
    const key = await scanHostKey(target, this.knownHosts);
    this.keyCache.set(cacheKey, { at: Date.now(), key });
    return key;
  }

  async probe(input: { target: SshHostInput['target']; auth: SshAuthInput; fingerprint: string }): Promise<SshProbeResult> {
    const target = normalizeTarget(input.target);
    const key = await this.scanKey({ target });
    if (key.changed) {
      return {
        key,
        authOk: false,
        error: '主机公钥与上次记录不一致，已阻止连接。请确认是否重装过系统或存在中间人。',
      };
    }
    const expected = normFp(input.fingerprint);
    if (key.fingerprint !== expected) {
      return { key, authOk: false, error: '主机公钥指纹与刚才检测到的不一致，请重新检测并确认。' };
    }
    const auth = authFrom(input.auth);
    try {
      const result = await runSsh(target, auth, this.knownHosts, probeScript(), { timeoutMs: 45_000 });
      const info = parseProbe(result.stdout);
      if (!info.TANDEM_PROBE_OK) throw new SshError('远程脚本未正常返回');
      const nodeVersion = info.TANDEM_NODE_VERSION;
      const nodeMajor = majorOf(nodeVersion);
      return {
        key,
        authOk: true,
        ...(info.TANDEM_HOSTNAME ? { hostname: info.TANDEM_HOSTNAME } : {}),
        ...(info.TANDEM_PLATFORM ? { platform: info.TANDEM_PLATFORM } : {}),
        ...(info.TANDEM_ARCH ? { arch: info.TANDEM_ARCH } : {}),
        ...(info.TANDEM_HOME ? { homeDir: info.TANDEM_HOME } : {}),
        ...(info.TANDEM_NODE
          ? { node: { path: info.TANDEM_NODE, version: nodeVersion ?? '', major: nodeMajor, ok: nodeMajor >= 22 } }
          : { node: { path: '', version: '', major: 0, ok: false } }),
        systemd: info.TANDEM_SYSTEMD === '1',
        nodeUpload: nodeUploadInfo(info.TANDEM_PLATFORM, info.TANDEM_ARCH),
      };
    } catch (err) {
      return { key, authOk: false, error: (err as Error).message };
    }
  }

  deploy(input: SshHostInput): SshJob {
    const target = normalizeTarget(input.target);
    const auth = authFrom(input.auth);
    if (auth.kind === 'password' && !auth.password) throw new SshError('密码认证需要输入密码');
    if (!input.fingerprint) throw new SshError('请先检测并确认主机公钥指纹');
    const remotePort = input.remotePort ?? 7878;
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw new SshError('远程 Host 端口无效');
    }
    const job = this.newJob('deploy', DEPLOY_STEPS);
    void this.runDeploy(job, target, auth, input);
    return job;
  }

  private async runDeploy(
    job: SshJob,
    target: ReturnType<typeof normalizeTarget>,
    auth: SshAuth,
    input: SshHostInput,
  ): Promise<void> {
    let rec: StoredSshHost | undefined;
    try {
      this.step(job, 'verify', 'running');
      const key = await this.scanKey({ target });
      if (key.changed) throw new SshError('主机公钥与 known_hosts 不一致，已停止部署');
      if (key.fingerprint !== normFp(input.fingerprint)) throw new SshError('主机公钥指纹与确认值不一致');
      this.step(job, 'verify', 'ok', `${key.keyType} ${key.fingerprint}`);

      this.step(job, 'probe', 'running');
      const probe = await runSsh(target, auth, this.knownHosts, probeScript(), { timeoutMs: 45_000 });
      const info = parseProbe(probe.stdout);
      if (!info.TANDEM_PROBE_OK) throw new SshError('远程探测失败');
      if (info.TANDEM_TAR !== '1') throw new SshError('远程缺少 tar 命令，无法解压 Host 包');
      let nodePath = input.nodePath?.trim() || info.TANDEM_NODE || '';
      let nodeVersion = info.TANDEM_NODE_VERSION ?? '';
      let nodeMajor = majorOf(nodeVersion);
      this.step(job, 'probe', 'ok', `${info.TANDEM_PLATFORM}/${info.TANDEM_ARCH} · Node ${nodeVersion || '未安装'}`);

      if (nodeMajor < 22) {
        const upload = nodeUploadInfo(info.TANDEM_PLATFORM, info.TANDEM_ARCH);
        if (!input.uploadNode) {
          throw new SshError(
            upload.available
              ? `远程 Node ${nodeVersion || '未安装'}，低于 22。可勾选「从本机上传 Node」或先在远程安装 Node ≥ 22。`
              : `远程 Node ${nodeVersion || '未安装'}，低于 22。${upload.reason ?? '请先在远程安装 Node ≥ 22（不会从公网自动下载）。'}`,
          );
        }
        if (!upload.available) throw new SshError(upload.reason ?? '本机 Node 与远端平台不匹配，无法上传');

        this.step(job, 'package', 'running');
        const [hostPkg, nodePkg] = await Promise.all([buildHostPackage(), buildNodePackage()]);
        this.step(job, 'package', 'ok', `${(hostPkg.size / 1024 / 1024).toFixed(1)} MB`);

        this.step(job, 'upload', 'running');
        await runSsh(target, auth, this.knownHosts, `mkdir -p "$HOME/.tandem-host"\n`, { timeoutMs: 30_000 });
        await runScp(target, auth, this.knownHosts, nodePkg, `${info.TANDEM_HOME}/.tandem-host/node.tar.gz`, { timeoutMs: 10 * 60_000 });
        this.step(job, 'upload', 'running', '已上传 Node，正在解压');
        await runSsh(
          target,
          auth,
          this.knownHosts,
          `set -e\nmkdir -p "$HOME/.tandem-host/node"\ntar -xzf "$HOME/.tandem-host/node.tar.gz" -C "$HOME/.tandem-host/node"\nrm -f "$HOME/.tandem-host/node.tar.gz"\nchmod +x "$HOME/.tandem-host/node/bin/node"\n`,
          { timeoutMs: 60_000 },
        );
        nodePath = `${info.TANDEM_HOME}/.tandem-host/node/bin/node`;
        const check = await runSsh(target, auth, this.knownHosts, verifyNodeScript(nodePath));
        const checked = parseProbe(check.stdout);
        nodeVersion = checked.TANDEM_NODE_VERSION ?? '';
        nodeMajor = majorOf(nodeVersion);
        if (nodeMajor < 22) throw new SshError(`上传的 Node 版本不可用（${nodeVersion || '未知'}）`);
        await runScp(target, auth, this.knownHosts, hostPkg.file, `${info.TANDEM_HOME}/.tandem-host/pkg.tar.gz`, { timeoutMs: 10 * 60_000 });
        this.step(job, 'upload', 'ok', `Node ${nodeVersion} + Host 包`);
      } else {
        this.step(job, 'package', 'running');
        const hostPkg = await buildHostPackage();
        this.step(job, 'package', 'ok', `${(hostPkg.size / 1024 / 1024).toFixed(1)} MB`);
        this.step(job, 'upload', 'running');
        await runSsh(target, auth, this.knownHosts, `mkdir -p "$HOME/.tandem-host"\n`, { timeoutMs: 30_000 });
        await runScp(target, auth, this.knownHosts, hostPkg.file, `${info.TANDEM_HOME}/.tandem-host/pkg.tar.gz`, { timeoutMs: 10 * 60_000 });
        this.step(job, 'upload', 'ok');
      }

      this.step(job, 'config', 'running');
      const token = randomBytes(24).toString('hex');
      const hostId = randomUUID();
      const prepared = await runSsh(target, auth, this.knownHosts, prepareScript(token, hostId), { timeoutMs: 120_000 });
      const preparedInfo = parseProbe(prepared.stdout);
      if (preparedInfo.TANDEM_CONFIG_ERROR) throw new SshError(`远程配置无效：${preparedInfo.TANDEM_CONFIG_ERROR}`);
      const remoteToken = preparedInfo.TANDEM_REMOTE_TOKEN || token;

      const service: 'systemd' | 'nohup' =
        input.service === 'systemd' || input.service === 'nohup'
          ? input.service
          : info.TANDEM_SYSTEMD === '1'
            ? 'systemd'
            : 'nohup';
      if (service === 'systemd' && info.TANDEM_SYSTEMD !== '1') {
        throw new SshError('远程没有可用的 systemd --user；请把服务方式改为「nohup + 定时检查」');
      }
      const localPort = await freePort();
      rec = {
        id: randomUUID(),
        name: input.name?.trim() || `${target.user}@${target.host}`,
        user: target.user,
        host: target.host,
        port: target.port,
        authKind: auth.kind,
        ...(auth.kind === 'key' && auth.keyPath ? { keyPath: auth.keyPath } : {}),
        nodePath,
        remotePort: input.remotePort ?? 7878,
        listenLan: !!input.listenLan,
        localPort,
        token: remoteToken,
        hostName: info.TANDEM_HOSTNAME || target.host,
        service,
        installedAt: Date.now(),
        system: {
          platform: info.TANDEM_PLATFORM ?? '',
          arch: info.TANDEM_ARCH ?? '',
          hostname: info.TANDEM_HOSTNAME ?? '',
          homeDir: info.TANDEM_HOME ?? '',
          nodeVersion,
        },
      };
      this.records.set(rec.id, rec);
      const rt = this.rt(rec.id);
      rt.password = auth.password;
      rt.needsPassword = false;
      rt.state = 'deploying';
      rt.wanted = true;
      this.save();
      this.step(job, 'config', 'ok');

      this.step(job, 'service', 'running');
      const install = await runSsh(
        target,
        auth,
        this.knownHosts,
        installServiceScript({
          nodePath,
          remotePort: rec.remotePort,
          listenHost: rec.listenLan ? '0.0.0.0' : '127.0.0.1',
          home: info.TANDEM_HOME ?? '',
          id: rec.id,
          service,
        }),
        { timeoutMs: 120_000 },
      );
      const serviceInfo = parseProbe(install.stdout);
      if (serviceInfo.TANDEM_CRON_WARN === '1' && service === 'nohup') {
        this.step(job, 'service', 'ok', '已用 nohup 启动；远程没有 crontab，进程不会自动拉起');
      } else if (service === 'systemd' && serviceInfo.TANDEM_LINGER_WARN === '1') {
        this.step(
          job,
          'service',
          'ok',
          '已用 systemd --user 启动；无法开启 linger，SSH 退出后可能停止。请在远程执行 sudo loginctl enable-linger $USER，或改用 nohup。',
        );
      } else {
        this.step(job, 'service', 'ok', service === 'systemd' ? 'systemd --user' : 'nohup + cron');
      }

      this.step(job, 'tunnel', 'running');
      await this.startTunnel(rec);
      this.step(job, 'tunnel', 'ok', `127.0.0.1:${rec.localPort} → 远程 ${rec.remotePort}`);

      this.step(job, 'verify-host', 'running');
      const ok = await this.waitHealthy(rec, 30);
      if (!ok) throw new SshError('远程 Host 未在预期时间内响应；请查看日志排查');
      this.step(job, 'verify-host', 'ok', `版本 ${rt.remoteVersion ?? 'unknown'}`);
      job.status = 'ok';
      job.result = this.deployResult(rec);
    } catch (err) {
      job.status = 'fail';
      job.error = (err as Error).message;
      const current = job.steps.find((step) => step.status === 'running');
      if (current) current.status = 'fail';
      if (rec) {
        rec.lastError = job.error;
        const rt = this.rt(rec.id);
        rt.lastError = job.error;
        rt.state = 'error';
        this.save();
      }
    } finally {
      job.endedAt = Date.now();
    }
  }

  private deployResult(rec: StoredSshHost): SshDeployResult {
    return {
      host: this.view(rec),
      client: {
        name: rec.name,
        url: `http://127.0.0.1:${rec.localPort}`,
        token: rec.token,
      },
    };
  }

  restart(id: string): SshJob {
    const rec = this.require(id);
    const job = this.newJob('restart', [
      { id: 'restart', title: '重启远程 Host' },
      { id: 'tunnel', title: '确认 SSH 隧道' },
      { id: 'verify', title: '验证连接' },
    ], id);
    void (async () => {
      try {
        this.step(job, 'restart', 'running');
        if (!rec.service) throw new SshError('缺少服务信息，请重新部署');
        const auth = this.authFor(rec);
        await runSsh(
          this.targetOf(rec),
          auth,
          this.knownHosts,
          restartScript(rec.service, rec.system?.homeDir ?? ''),
          { timeoutMs: 60_000 },
        );
        this.step(job, 'restart', 'ok');
        this.step(job, 'tunnel', 'running');
        await this.startTunnel(rec);
        this.step(job, 'tunnel', 'ok');
        this.step(job, 'verify', 'running');
        const ok = await this.waitHealthy(rec, 30);
        if (!ok) throw new SshError('远程 Host 未响应');
        this.step(job, 'verify', 'ok');
        job.status = 'ok';
      } catch (err) {
        this.fail(job, err);
      } finally {
        job.endedAt = Date.now();
      }
    })();
    return job;
  }

  upgrade(id: string): SshJob {
    const rec = this.require(id);
    const job = this.newJob('upgrade', [
      { id: 'probe', title: '检测远程环境' },
      { id: 'package', title: '打包当前版本' },
      { id: 'upload', title: '上传新版本' },
      { id: 'config', title: '替换程序（保留数据）' },
      { id: 'restart', title: '重启服务' },
      { id: 'verify', title: '验证版本' },
    ], id);
    void (async () => {
      try {
        const auth = this.authFor(rec);
        this.step(job, 'probe', 'running');
        const probe = await runSsh(this.targetOf(rec), auth, this.knownHosts, probeScript(), { timeoutMs: 45_000 });
        const info = parseProbe(probe.stdout);
        if (!info.TANDEM_PROBE_OK) throw new SshError('远程探测失败');
        const nodePath = info.TANDEM_NODE || rec.nodePath || '';
        if (majorOf(info.TANDEM_NODE_VERSION) < 22) throw new SshError('远程 Node 低于 22，无法升级');
        rec.nodePath = nodePath;
        rec.system = {
          platform: info.TANDEM_PLATFORM ?? rec.system?.platform ?? '',
          arch: info.TANDEM_ARCH ?? rec.system?.arch ?? '',
          hostname: info.TANDEM_HOSTNAME ?? rec.system?.hostname ?? '',
          homeDir: info.TANDEM_HOME ?? rec.system?.homeDir ?? '',
          nodeVersion: info.TANDEM_NODE_VERSION,
        };
        this.step(job, 'probe', 'ok', `Node ${info.TANDEM_NODE_VERSION}`);

        this.step(job, 'package', 'running');
        const pkg = await buildHostPackage();
        this.step(job, 'package', 'ok', `${(pkg.size / 1024 / 1024).toFixed(1)} MB`);
        this.step(job, 'upload', 'running');
        await runScp(this.targetOf(rec), auth, this.knownHosts, pkg.file, `${rec.system?.homeDir ?? ''}/.tandem-host/pkg.tar.gz`, {
          timeoutMs: 10 * 60_000,
        });
        this.step(job, 'upload', 'ok');

        this.step(job, 'config', 'running');
        const prepared = await runSsh(
          this.targetOf(rec),
          auth,
          this.knownHosts,
          prepareScript(rec.token, randomUUID()),
          { timeoutMs: 120_000 },
        );
        const preparedInfo = parseProbe(prepared.stdout);
        if (preparedInfo.TANDEM_REMOTE_TOKEN) rec.token = preparedInfo.TANDEM_REMOTE_TOKEN;
        this.save();
        this.step(job, 'config', 'ok');

        this.step(job, 'restart', 'running');
        if (!rec.service) throw new SshError('缺少服务信息，请重新部署');
        await runSsh(
          this.targetOf(rec),
          auth,
          this.knownHosts,
          restartScript(rec.service, rec.system?.homeDir ?? ''),
          { timeoutMs: 60_000 },
        );
        this.step(job, 'restart', 'ok');

        this.step(job, 'verify', 'running');
        const ok = await this.waitHealthy(rec, 30);
        if (!ok) throw new SshError('升级后远程 Host 未响应，请查看日志');
        this.step(job, 'verify', 'ok', `版本 ${this.rt(rec.id).remoteVersion ?? 'unknown'}`);
        job.status = 'ok';
      } catch (err) {
        this.fail(job, err);
      } finally {
        job.endedAt = Date.now();
      }
    })();
    return job;
  }

  async logs(id: string, lines = 200): Promise<string[]> {
    const rec = this.require(id);
    if (!rec.service) throw new SshError('缺少服务信息');
    const auth = this.authFor(rec);
    const result = await runSsh(
      this.targetOf(rec),
      auth,
      this.knownHosts,
      logsScript(rec.service, rec.system?.homeDir ?? '', lines),
      { timeoutMs: 45_000 },
    );
    return result.stdout
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(-Math.max(10, Math.min(2000, lines)));
  }

  uninstall(id: string, keepData: boolean): SshJob {
    const rec = this.require(id);
    const job = this.newJob('uninstall', [
      { id: 'stop', title: '停止远程服务' },
      { id: 'remove', title: '删除远程程序' },
      { id: 'tunnel', title: '关闭本地隧道' },
    ], id);
    void (async () => {
      try {
        const auth = this.authFor(rec);
        this.step(job, 'stop', 'running');
        this.step(job, 'remove', 'running');
        const result = await runSsh(
          this.targetOf(rec),
          auth,
          this.knownHosts,
          uninstallScript(rec.service, rec.system?.homeDir ?? '', rec.id, keepData),
          { timeoutMs: 60_000 },
        );
        if (!result.stdout.includes('TANDEM_UNINSTALLED=1')) throw new SshError('远程卸载脚本未完成');
        this.step(job, 'stop', 'ok');
        this.step(job, 'remove', 'ok', keepData ? '已保留 ~/.tandem 数据' : '已同时删除 ~/.tandem 数据');
        this.step(job, 'tunnel', 'running');
        this.closeTunnel(rec.id);
        this.records.delete(rec.id);
        this.runtimes.delete(rec.id);
        this.save();
        this.step(job, 'tunnel', 'ok');
        job.status = 'ok';
      } catch (err) {
        this.fail(job, err);
      } finally {
        job.endedAt = Date.now();
      }
    })();
    return job;
  }

  async setPassword(id: string, password: string): Promise<void> {
    const rec = this.require(id);
    if (rec.authKind !== 'password') throw new SshError('该主机不使用密码认证');
    if (!password) throw new SshError('密码不能为空');
    const rt = this.rt(id);
    rt.password = password;
    rt.needsPassword = false;
    rt.lastError = undefined;
    rt.state = 'offline';
    await this.startTunnel(rec);
  }

  private newJob(
    kind: SshJob['kind'],
    steps: Array<{ id: string; title: string }>,
    hostId?: string,
  ): SshJob {
    const job: SshJob = {
      id: randomUUID(),
      ...(hostId ? { hostId } : {}),
      kind,
      status: 'running',
      steps: steps.map((step) => ({ ...step, status: 'pending' as SshStepStatus })),
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 60) {
      const oldest = [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest && oldest.status !== 'running') this.jobs.delete(oldest.id);
    }
    return job;
  }

  private step(job: SshJob, id: string, status: SshStepStatus, detail?: string): void {
    const step = job.steps.find((item) => item.id === id);
    if (!step) return;
    step.status = status;
    if (detail !== undefined) step.detail = detail;
  }

  private fail(job: SshJob, err: unknown): void {
    job.status = 'fail';
    job.error = (err as Error).message;
    const running = job.steps.find((item) => item.status === 'running');
    if (running) running.status = 'fail';
  }

  private require(id: string): StoredSshHost {
    const rec = this.records.get(id);
    if (!rec) throw new SshError('远程主机不存在');
    return rec;
  }

  private authFor(rec: StoredSshHost): SshAuth {
    const rt = this.rt(rec.id);
    const auth = this.authOf(rec, rt);
    if (auth.kind === 'password' && !auth.password) throw new SshError('需要重新输入 SSH 密码');
    return auth;
  }

  private async resume(rec: StoredSshHost): Promise<void> {
    const rt = this.rt(rec.id);
    if (rec.authKind === 'password' && !rt.password) {
      rt.needsPassword = true;
      rt.state = 'offline';
      return;
    }
    await this.startTunnel(rec);
  }

  private async startTunnel(rec: StoredSshHost): Promise<void> {
    const rt = this.rt(rec.id);
    rt.wanted = true;
    if (rt.child) return;
    if (rec.authKind === 'password' && !rt.password) {
      rt.needsPassword = true;
      rt.state = 'offline';
      return;
    }
    try {
      const target = this.targetOf(rec);
      if (!(await portFree(rec.localPort))) {
        rec.localPort = await freePort();
        this.save();
      }
      const auth = this.authOf(rec, rt);
      const tunnel = startTunnelProcess(target, auth, this.knownHosts, rec.localPort, rec.remotePort);
      rt.child = tunnel.child;
      rt.tunnel = tunnel;
      rt.stderr = '';
      tunnel.child.stderr?.on('data', (chunk: Buffer) => {
        rt.stderr = (rt.stderr + chunk.toString('utf8')).slice(-2000);
      });
      tunnel.child.once('exit', () => {
        tunnel.cleanup();
        rt.child = undefined;
        rt.tunnel = undefined;
        rt.latencyMs = undefined;
        if (!this.closed && rt.wanted) {
          rt.state = 'offline';
          rt.lastError = rt.lastError || rt.stderr.trim().split('\n').slice(-2).join('；') || 'SSH 隧道已断开';
          this.scheduleReconnect(rec);
        } else {
          rt.state = 'stopped';
        }
      });
      // 隧道进程启动后等端口可用；健康检查会确认远端 Host。
      rt.state = 'offline';
    } catch (err) {
      rt.state = 'error';
      rt.lastError = (err as Error).message;
      this.scheduleReconnect(rec);
    }
  }

  private scheduleReconnect(rec: StoredSshHost): void {
    const rt = this.rt(rec.id);
    if (this.closed || !rt.wanted || rt.reconnect) return;
    rt.reconnect = setTimeout(() => {
      rt.reconnect = undefined;
      if (this.closed || !rt.wanted) return;
      void this.resume(rec);
    }, 5000);
    rt.reconnect.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    for (const rec of this.records.values()) {
      const rt = this.rt(rec.id);
      if (!rt.child) {
        if (rt.wanted && rec.authKind !== 'password') this.scheduleReconnect(rec);
        continue;
      }
      await this.checkHealth(rec);
    }
  }

  private async checkHealth(rec: StoredSshHost): Promise<boolean> {
    const rt = this.rt(rec.id);
    const started = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${rec.localPort}/api/host`, {
        headers: { Authorization: `Bearer ${rec.token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const info = (await response.json()) as { version?: string };
      rt.latencyMs = Date.now() - started;
      rt.state = 'online';
      rt.lastError = undefined;
      rt.needsPassword = false;
      rec.lastConnectedAt = Date.now();
      rec.lastError = undefined;
      const version = typeof info.version === 'string' ? info.version : '';
      if (version && (version !== rt.remoteVersion || version !== rec.remoteVersion)) {
        rt.remoteVersion = version;
        rec.remoteVersion = version;
        this.save();
      }
      return true;
    } catch (err) {
      rt.state = rt.child ? 'offline' : 'offline';
      rt.lastError = rt.stderr.trim().split('\n').slice(-2).join('；') ||
        (err instanceof Error ? err.message : '远程 Host 未响应');
      return false;
    }
  }

  private async waitHealthy(rec: StoredSshHost, attempts: number): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (this.closed) return false;
      if (await this.checkHealth(rec)) return true;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return false;
  }

  private closeTunnel(id: string): void {
    const rt = this.rt(id);
    rt.wanted = false;
    if (rt.reconnect) {
      clearTimeout(rt.reconnect);
      rt.reconnect = undefined;
    }
    const child = rt.child;
    rt.child = undefined;
    rt.tunnel?.cleanup();
    rt.tunnel = undefined;
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 忽略 */
      }
    }
    rt.state = 'stopped';
  }

  stop(): void {
    this.closed = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    for (const id of this.records.keys()) this.closeTunnel(id);
  }
}

function authFrom(input: SshAuthInput): SshAuth {
  if (!input || (input.kind !== 'agent' && input.kind !== 'key' && input.kind !== 'password')) {
    throw new SshError('认证方式无效');
  }
  if (input.kind === 'key' && !input.keyPath?.trim()) throw new SshError('请填写私钥文件路径');
  return {
    kind: input.kind,
    ...(input.keyPath?.trim() ? { keyPath: input.keyPath.trim() } : {}),
    ...(input.password !== undefined ? { password: input.password } : {}),
  };
}

export { targetLabel, normArch };
