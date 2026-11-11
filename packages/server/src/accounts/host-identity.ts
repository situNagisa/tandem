// 主机长期身份（Ed25519）：本机与执行器主机登记时生成，主机上下文用它向工作站验明身份。
import { createHash, createPrivateKey, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { b64u, unb64u } from '@tandem/protocol/wire';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface HostIdentity {
  privateKey: KeyObject;
  publicRaw: Buffer;
  /** 公钥 SHA-256（64 位小写十六进制）。 */
  fingerprint: string;
}

export function generateHostKey(): string {
  return b64u(randomBytes(32));
}

/** hostKey 是 32 字节 Ed25519 种子（base64url）。 */
export function identityFromHostKey(hostKey: string): HostIdentity {
  const seed = Buffer.from(unb64u(hostKey));
  if (seed.length !== 32) throw new Error('主机密钥必须是 32 字节的 base64url');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicRaw = Buffer.from(unb64u(jwk.x as string));
  return { privateKey, publicRaw, fingerprint: createHash('sha256').update(publicRaw).digest('hex') };
}
