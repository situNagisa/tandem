// 内网团队：成员、一次性邀请与审计日志。明文 token / 邀请码只返回一次，持久化只存 SHA-256。
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  MemberRole,
  TeamAuditAction,
  TeamAuditEntry,
  TeamInvite,
  TeamMember,
  TeamRole,
} from '@tandem/protocol';
import { readJson, writePrivateFile } from '../config.js';
import { findActiveToken, hashToken, isMemberRole, tokenMatchesHash } from '../auth/token.js';

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const AUDIT_LIMIT = 200;

interface StoredMember extends TeamMember {
  tokenHash: string;
}
interface StoredInvite extends TeamInvite {
  codeHash: string;
}
interface TeamFile {
  version: 1;
  members: StoredMember[];
  invites: StoredInvite[];
  audit: TeamAuditEntry[];
}

function normalizeDirs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => path.resolve(v.trim())))];
}

function publicMember(m: StoredMember): TeamMember {
  const { tokenHash: _tokenHash, ...rest } = m;
  return { ...rest, projectDirs: [...rest.projectDirs] };
}

function publicInvite(i: StoredInvite): TeamInvite {
  const { codeHash: _codeHash, ...rest } = i;
  return { ...rest, projectDirs: [...rest.projectDirs] };
}

export class TeamStore {
  private file: string;
  private members = new Map<string, StoredMember>();
  private invites = new Map<string, StoredInvite>();
  private auditEntries: TeamAuditEntry[] = [];
  /** 只在内存里更新，定期落盘，避免每个请求都写文件。 */
  private lastSeenDirty = false;

  constructor(home: string) {
    this.file = path.join(home, 'team.json');
    const data = readJson<Partial<TeamFile>>(this.file);
    for (const raw of data?.members ?? []) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.tokenHash !== 'string') continue;
      if (!isMemberRole(raw.role)) continue;
      const member: StoredMember = {
        ...raw,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '未命名成员',
        projectDirs: normalizeDirs(raw.projectDirs),
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      };
      this.members.set(member.id, member);
    }
    for (const raw of data?.invites ?? []) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.codeHash !== 'string' || !isMemberRole(raw.role)) continue;
      const invite: StoredInvite = {
        ...raw,
        projectDirs: normalizeDirs(raw.projectDirs),
      };
      this.invites.set(invite.id, invite);
    }
    this.auditEntries = Array.isArray(data?.audit) ? data.audit.slice(-AUDIT_LIMIT) : [];
  }

  private save(): void {
    writePrivateFile(
      this.file,
      JSON.stringify(
        {
          version: 1,
          members: [...this.members.values()],
          invites: [...this.invites.values()],
          audit: this.auditEntries,
        },
        null,
        2,
      ),
    );
    this.lastSeenDirty = false;
  }

  /** 定期把 lastSeenAt 落盘（进程退出时由 Host 调 close）。 */
  close(): void {
    if (this.lastSeenDirty) this.save();
  }

  listMembers(): TeamMember[] {
    return [...this.members.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicMember);
  }

  getMember(id: string): TeamMember | undefined {
    const m = this.members.get(id);
    return m ? publicMember(m) : undefined;
  }

  /** token 无效 / 已吊销时返回 undefined。 */
  authenticate(token: string): TeamMember | undefined {
    if (!token) return undefined;
    const member = findActiveToken(this.members.values(), token, (item) => item.tokenHash);
    if (!member) return undefined;
    member.lastSeenAt = Date.now();
    this.lastSeenDirty = true;
    return publicMember(member);
  }

  touch(memberId: string): void {
    const member = this.members.get(memberId);
    if (!member) return;
    member.lastSeenAt = Date.now();
    this.lastSeenDirty = true;
  }

  createInvite(input: { role: MemberRole; projectDirs: string[] }, now = Date.now()): {
    invite: TeamInvite;
    code: string;
  } {
    if (!isMemberRole(input.role)) throw new Error('角色无效');
    const code = randomBytes(18).toString('base64url');
    const invite: StoredInvite = {
      id: randomUUID(),
      role: input.role,
      projectDirs: normalizeDirs(input.projectDirs),
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS,
      codeHash: hashToken(code),
    };
    this.invites.set(invite.id, invite);
    this.save();
    return { invite: publicInvite(invite), code };
  }

  listInvites(now = Date.now()): TeamInvite[] {
    // 过期且未使用的邀请保留 24h 供审计，之后不再展示
    return [...this.invites.values()]
      .filter((invite) => !invite.usedAt ? invite.expiresAt > now - INVITE_TTL_MS : true)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicInvite);
  }

  removeInvite(id: string): boolean {
    const deleted = this.invites.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  acceptInvite(code: string, name: string, now = Date.now()): { token: string; member: TeamMember } {
    const invite = [...this.invites.values()].find((item) => tokenMatchesHash(code.trim(), item.codeHash));
    if (!invite) throw new Error('邀请码无效');
    if (invite.usedAt) throw new Error('邀请码已被使用');
    if (invite.expiresAt <= now) throw new Error('邀请码已过期');
    const memberName = name.trim().slice(0, 40) || '同事';
    const token = `tmm_${randomBytes(32).toString('hex')}`;
    const member: StoredMember = {
      id: randomUUID(),
      name: memberName,
      role: invite.role,
      projectDirs: [...invite.projectDirs],
      createdAt: now,
      lastSeenAt: now,
      tokenHash: hashToken(token),
    };
    invite.usedAt = now;
    invite.usedByName = memberName;
    this.members.set(member.id, member);
    this.save();
    return { token, member: publicMember(member) };
  }

  updateMember(
    id: string,
    patch: { name?: string; role?: MemberRole; projectDirs?: string[] },
  ): TeamMember | undefined {
    const member = this.members.get(id);
    if (!member) return undefined;
    if (typeof patch.name === 'string' && patch.name.trim()) member.name = patch.name.trim().slice(0, 40);
    if (isMemberRole(patch.role)) member.role = patch.role;
    if (patch.projectDirs !== undefined) member.projectDirs = normalizeDirs(patch.projectDirs);
    this.save();
    return publicMember(member);
  }

  revokeMember(id: string, now = Date.now()): boolean {
    const member = this.members.get(id);
    if (!member) return false;
    member.revokedAt = now;
    this.save();
    return true;
  }

  addAudit(input: {
    actorId: string;
    actorName: string;
    role: TeamRole;
    action: TeamAuditAction;
    sessionId?: string;
    sessionTitle?: string;
    detail?: string;
    at?: number;
  }): TeamAuditEntry {
    const entry: TeamAuditEntry = {
      id: randomUUID(),
      at: input.at ?? Date.now(),
      actorId: input.actorId,
      actorName: input.actorName,
      role: input.role,
      action: input.action,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.sessionTitle ? { sessionTitle: input.sessionTitle } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    };
    this.auditEntries.push(entry);
    if (this.auditEntries.length > AUDIT_LIMIT) {
      this.auditEntries.splice(0, this.auditEntries.length - AUDIT_LIMIT);
    }
    this.save();
    return entry;
  }

  /** 最近 limit 条，按时间倒序。 */
  listAudit(limit = AUDIT_LIMIT): TeamAuditEntry[] {
    const size = Math.max(1, Math.min(limit, AUDIT_LIMIT));
    return this.auditEntries.slice(-size).reverse();
  }
}
