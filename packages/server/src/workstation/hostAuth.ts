// 主机 → 工作站的管理请求鉴权：主机用登记过的 Ed25519 私钥签名，工作站按登记公钥验签。
// 签名覆盖时间戳、hostId、accountId、方法、路径与请求体哈希；5 分钟内有效，防重放。
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { b64u, unb64u } from '@tandem/relay/wire';
import { identityFromHostKey, signWith } from '../relay/e2e.js';
import type { AccountsStore } from '../accounts/store.js';

const MAX_SKEW_MS = 5 * 60 * 1000;

export interface HostSignedRequest {
  hostId: string;
  accountId: string;
  timestamp: number;
  method: string;
  path: string;
  body: Buffer;
}

export function hostSignatureMessage(input: HostSignedRequest): Buffer {
  const bodyHash = createHash('sha256').update(input.body).digest('hex');
  return Buffer.from(
    `${input.timestamp}\n${input.hostId}\n${input.accountId}\n${input.method.toUpperCase()}\n${input.path}\n${bodyHash}`,
  );
}

/** 主机侧：用本地长期私钥签名一组请求头。 */
export function signHostRequest(
  hostKey: string,
  args: Omit<HostSignedRequest, 'timestamp'> & { timestamp?: number },
): Record<string, string> {
  const timestamp = args.timestamp ?? Date.now();
  const identity = identityFromHostKey(hostKey);
  const sig = signWith(identity, hostSignatureMessage({ ...args, timestamp }));
  return {
    'x-tandem-host-id': args.hostId,
    'x-tandem-account-id': args.accountId,
    'x-tandem-timestamp': String(timestamp),
    'x-tandem-signature': b64u(sig),
  };
}

function headerOf(req: FastifyRequest, name: string): string {
  const value = req.headers[name];
  return typeof value === 'string' ? value : '';
}

/** 工作站侧：校验签名，返回可信的 { hostId, accountId }；失败抛 401/403。 */
export function verifyHostRequest(
  store: AccountsStore,
  req: FastifyRequest,
  body: Buffer,
): { hostId: string; accountId: string } {
  const hostId = headerOf(req, 'x-tandem-host-id');
  const accountId = headerOf(req, 'x-tandem-account-id');
  const timestamp = Number(headerOf(req, 'x-tandem-timestamp'));
  const signature = headerOf(req, 'x-tandem-signature');
  const fail = (message: string, statusCode = 401): never => {
    throw Object.assign(new Error(message), { statusCode });
  };
  if (!hostId || !accountId || !signature || !Number.isFinite(timestamp)) fail('缺少主机签名');
  if (Math.abs(Date.now() - timestamp) > MAX_SKEW_MS) fail('主机签名已过期');
  const publicKey = store.hostPublicKey(hostId);
  if (!publicKey) fail('主机未登记', 403);
  if (!store.accountCanAccessHost(hostId, accountId)) fail('该账号无权使用这台主机', 403);
  const path = (req.raw.url ?? '').split('?')[0] ?? '';
  let ok = false;
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
      format: 'jwk',
    });
    ok = verify(
      null,
      hostSignatureMessage({ hostId, accountId, timestamp, method: req.method, path, body }),
      key,
      unb64u(signature),
    );
  } catch {
    ok = false;
  }
  if (!ok) fail('主机签名无效');
  return { hostId, accountId };
}
