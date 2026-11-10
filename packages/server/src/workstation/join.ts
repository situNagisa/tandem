// 把本机登记到工作站：本机 HTTP 路由（客户端「添加这台电脑」）与 CLI `tandem-host join` 共用。
import type { WorkspaceStatus } from '@tandem/protocol';
import type { Host } from '../host.js';

export interface WorkstationJoinInput {
  workstationUrl: string;
  code?: string;
  username?: string;
  password?: string;
  totp?: string;
  name: string;
  /** 本机可达地址，登记时上报给工作站。 */
  urls: string[];
}

export interface WorkstationJoinTunnel {
  start(): void;
}

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * 登记本机并启动出站隧道。已加入同一工作站时幂等返回当前状态（重复执行同一条安装命令不报错）；
 * 已加入别的工作站、绑定码或账号无效时抛出带 statusCode 的错误。
 */
export async function joinWorkstation(
  host: Host,
  tunnel: WorkstationJoinTunnel | undefined,
  input: WorkstationJoinInput,
): Promise<WorkspaceStatus> {
  const accounts = host.accounts;
  const target = input.workstationUrl.trim().replace(/\/+$/, '');
  if (!target) throw httpError('请填写工作站地址', 400);
  const existing = accounts.workstationJoin();
  if (existing) {
    if (existing.url.replace(/\/+$/, '').toLowerCase() === target.toLowerCase()) {
      tunnel?.start();
      return accounts.status();
    }
    throw httpError(`本机已加入工作站 ${existing.url}，请先退出后再加入其他工作站`, 409);
  }
  let accessToken: string | undefined;
  if (!input.code) {
    if (!input.username || !input.password) throw httpError('请填写绑定码，或用工作站账号登录', 400);
    let res: Response;
    try {
      res = await fetch(`${target}/api/workstation/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: input.username,
          password: input.password,
          ...(input.totp ? { totp: input.totp } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw httpError(`无法连接工作站：${(err as Error).message}`, 502);
    }
    const data = (await res.json().catch(() => ({}))) as { accessToken?: string; error?: string };
    if (!res.ok || !data.accessToken) throw httpError(data.error ?? `工作站返回 ${res.status}`, 502);
    accessToken = data.accessToken;
  }
  const status = await accounts.registerAsHost(
    target,
    {
      id: host.config.hostId,
      name: input.name,
      urls: input.urls,
      ...(host.version ? { version: host.version } : {}),
      platform: process.platform,
    },
    input.code ? { code: input.code } : { accessToken: accessToken! },
  );
  tunnel?.start();
  // 加入后立刻切到账号级模型账号，并把本机旧 profiles（含 Key）迁移到工作站。
  void host.enableWorkstationProfiles();
  return status;
}
