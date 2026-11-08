// 路由共用的入参/出参小工具。
import type { FastifyReply } from 'fastify';
import type { ProviderKind, RelayPairInfo } from '@tandem/protocol';
import type { Host } from '../host.js';
import type { SshRemoteManager } from '../ssh/manager.js';

export type RelayPairInfoSource = { pairInfo(): RelayPairInfo | undefined };

export interface RouteDeps {
  host: Host;
  relay?: RelayPairInfoSource;
  sshHosts?: SshRemoteManager;
  /** 本机作为主机的出站工作站隧道（加入/退出后即时启停）。 */
  workstation?: { start(): void; stop(): void; status(): { connected: boolean; url?: string } };
}

export const PROVIDER_KINDS: ProviderKind[] = ['anthropic', 'openai', 'openai-compatible', 'gemini', 'tandem-gateway'];

export function bad(reply: FastifyReply, message: string, code = 400): FastifyReply {
  return reply.code(code).send({ error: message });
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 迁移错误默认按 400 返回，避免把口令错误当服务器故障。 */
export function statusOf(err: unknown): number {
  const status = (err as { statusCode?: number }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : 400;
}
