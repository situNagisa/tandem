// 内网团队共享：成员管理、一次性邀请、公开接受邀请、审计与身份查询。
import { statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  AcceptTeamInviteInput,
  CreateTeamInviteInput,
  MemberRole,
  TeamAuditEntry,
  TeamIdentity,
  TeamMember,
  TeamOverview,
  UpdateTeamMemberInput,
} from '@tandem/protocol';
import type { RouteDeps } from './common.js';
import { bad, str } from './common.js';
import { principalOf } from '../team/access.js';
import { identityOf } from '../team/access.js';
import { recordAudit } from '../team/audit.js';
import { canApprove, isMemberRole } from '../auth/token.js';
import { publicBaseUrl } from '../util/address.js';

export function isPublicTeamPath(urlPath: string): boolean {
  return urlPath === '/api/team/invites/accept';
}

function parseProjectDirs(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('projectDirs 必须是目录数组');
  const dirs = [...new Set(value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => path.resolve(v.trim())))];
  if (!dirs.length) throw new Error('至少选择一个项目目录');
  for (const dir of dirs) {
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      throw new Error(`目录不存在: ${dir}`);
    }
    if (!stat.isDirectory()) throw new Error(`不是目录: ${dir}`);
  }
  return dirs;
}

function onlineMembers(deps: RouteDeps): TeamMember[] {
  return deps.host.team.listMembers().map((member) => ({
    ...member,
    online: deps.host.hub.isMemberOnline(member.id),
  }));
}

export function registerTeamRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/api/team/me', async (req): Promise<TeamIdentity> => {
    return identityOf(principalOf(req), host);
  });

  app.get('/api/team/members', async (): Promise<TeamOverview> => ({
    members: onlineMembers(deps),
    invites: host.team.listInvites(),
  }));

  // 审批转交用的轻量列表：只暴露有审批权的成员与在线状态。
  app.get('/api/team/approvers', async (): Promise<TeamMember[]> =>
    onlineMembers(deps)
      .filter((member) => !member.revokedAt && canApprove(member.role))
      .map((member) => ({ ...member, projectDirs: [] })),
  );

  app.post('/api/team/invites', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<CreateTeamInviteInput>;
    const role = str(body.role) as MemberRole;
    if (!isMemberRole(role)) return bad(reply, '角色无效');
    let projectDirs: string[];
    try {
      projectDirs = parseProjectDirs(body.projectDirs);
    } catch (err) {
      return bad(reply, (err as Error).message);
    }
    const { invite, code } = host.team.createInvite({ role, projectDirs });
    const base = publicBaseUrl(app);
    const url = `${base.url}/#invite=${encodeURIComponent(code)}`;
    recordAudit(host, principalOf(req), 'invite.create', {
      detail: `${role} · ${projectDirs.join(', ')}`,
    });
    host.hub.broadcastAll({ type: 'team_updated' });
    return reply.code(201).send({
      invite,
      code,
      url,
      ...(base.warning ? { warning: base.warning } : {}),
    });
  });

  app.delete('/api/team/invites/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!host.team.removeInvite(id)) return bad(reply, '邀请不存在', 404);
    host.hub.broadcastAll({ type: 'team_updated' });
    return reply.code(204).send();
  });

  app.post('/api/team/members/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as UpdateTeamMemberInput;
    const patch: UpdateTeamMemberInput = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (body.role !== undefined) {
      if (!isMemberRole(body.role)) return bad(reply, '角色无效');
      patch.role = body.role;
    }
    if (body.projectDirs !== undefined) {
      try {
        patch.projectDirs = parseProjectDirs(body.projectDirs);
      } catch (err) {
        return bad(reply, (err as Error).message);
      }
    }
    const before = host.team.getMember(id);
    if (!before) return bad(reply, '成员不存在', 404);
    const member = host.team.updateMember(id, patch);
    if (!member) return bad(reply, '成员不存在', 404);
    const dirsChanged =
      before.projectDirs.length !== member.projectDirs.length ||
      before.projectDirs.some((dir, index) => dir !== member.projectDirs[index]);
    if (before.role !== member.role || dirsChanged) host.hub.disconnectMember(id);
    recordAudit(host, principalOf(req), 'member.update', {
      detail: `${member.name} → ${member.role}`,
    });
    host.hub.broadcastAll({ type: 'team_updated' });
    return { ...member, online: host.hub.isMemberOnline(member.id) };
  });

  app.post('/api/team/members/:id/revoke', async (req, reply) => {
    const { id } = req.params as { id: string };
    const member = host.team.getMember(id);
    if (!member) return bad(reply, '成员不存在', 404);
    host.team.revokeMember(id);
    host.hub.disconnectMember(id);
    recordAudit(host, principalOf(req), 'member.revoke', { detail: member.name });
    host.hub.broadcastAll({ type: 'team_updated' });
    return reply.code(204).send();
  });

  app.get('/api/team/audit', async (req): Promise<TeamAuditEntry[]> => {
    const query = req.query as { limit?: string };
    const limit = Number.parseInt(str(query.limit), 10);
    return host.team.listAudit(Number.isFinite(limit) && limit > 0 ? limit : 200);
  });

  // 公开接口：凭一次性邀请码换取成员 token；不需要（也不接受）Host 主 token。
  app.post('/api/team/invites/accept', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<AcceptTeamInviteInput>;
    const code = str(body.code);
    if (!code) return bad(reply, '邀请码不能为空');
    try {
      const { token, member } = host.team.acceptInvite(code, str(body.name));
      recordAudit(
        host,
        { kind: 'member', id: member.id, name: member.name, role: member.role, projectDirs: member.projectDirs },
        'invite.accept',
        { detail: member.role },
      );
      host.hub.broadcastAll({ type: 'team_updated' });
      return reply.code(201).send({ token, member, host: host.info() });
    } catch (err) {
      return bad(reply, (err as Error).message, 400);
    }
  });
}
