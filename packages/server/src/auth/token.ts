// 长期令牌与角色白名单的唯一实现：持久化只存 SHA-256，比对用常量时间，吊销集中判断。
import { createHash, timingSafeEqual } from 'node:crypto';
import type { MemberRole, TeamRole } from '@tandem/protocol';

export const MEMBER_ROLES: readonly MemberRole[] = ['observer', 'approver', 'collaborator'];

const APPROVER_ROLES: readonly TeamRole[] = ['owner', 'approver', 'collaborator'];
const SENDER_ROLES: readonly TeamRole[] = ['owner', 'collaborator'];

export function isMemberRole(value: unknown): value is MemberRole {
  return MEMBER_ROLES.includes(value as MemberRole);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function digestOf(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** token 的哈希与持久化哈希做常量时间比对。 */
export function tokenMatchesHash(token: string, storedHash: string | undefined): boolean {
  if (!token || !storedHash) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = digestOf(token);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

/** 记录未被吊销；可选到期时间也在这里收敛。 */
export function isTokenActive(
  record: { revokedAt?: number } | undefined,
  now = Date.now(),
  expiresAt?: number,
): boolean {
  if (!record || record.revokedAt !== undefined) return false;
  return expiresAt === undefined || expiresAt > now;
}

/** 在一组令牌记录里按明文 token 找有效记录（每条哈希常量时间比对）。 */
export function findActiveToken<T extends object>(
  records: Iterable<T>,
  token: string,
  hashOf: (record: T) => string | undefined,
  options: { now?: number; expiresAtOf?: (record: T) => number | undefined } = {},
): T | undefined {
  if (!token) return undefined;
  const digest = digestOf(token);
  for (const record of records) {
    const revokedAt = (record as { revokedAt?: number }).revokedAt;
    const expiresAt = options.expiresAtOf?.(record);
    if (!isTokenActive({ revokedAt }, options.now, expiresAt)) continue;
    const stored = hashOf(record);
    if (!stored) continue;
    const expected = Buffer.from(stored, 'hex');
    if (expected.length === digest.length && timingSafeEqual(expected, digest)) return record;
  }
  return undefined;
}

export function hasAnyRole<T extends string>(role: T | undefined, allowed: readonly T[]): boolean {
  return !!role && allowed.includes(role);
}

/** 审批权：所有者 / 审批者 / 协作者。 */
export function canApprove(role: TeamRole): boolean {
  return hasAnyRole(role, APPROVER_ROLES);
}

/** 发送与设备操作权：所有者 / 协作者。 */
export function canSend(role: TeamRole): boolean {
  return hasAnyRole(role, SENDER_ROLES);
}
