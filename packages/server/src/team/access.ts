// 团队成员的身份、项目可见范围与 REST 路由边界。
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import type { MemberRole, Profile, TeamIdentity, TeamRole } from '@tandem/protocol';
import type { Host } from '../host.js';
import type { SessionRecord } from '../types.js';

export interface OwnerPrincipal {
  kind: 'owner';
  role: 'owner';
  id: 'owner';
  name: string;
  projectDirs: string[];
}
export interface MemberPrincipal {
  kind: 'member';
  role: MemberRole;
  id: string;
  name: string;
  projectDirs: string[];
}
export type Principal = OwnerPrincipal | MemberPrincipal;

export const OWNER_NAME = '所有者';

declare module 'fastify' {
  interface FastifyRequest {
    team?: Principal;
  }
}

export function ownerPrincipal(): OwnerPrincipal {
  return { kind: 'owner', role: 'owner', id: 'owner', name: OWNER_NAME, projectDirs: [] };
}

export function principalOf(req: FastifyRequest): Principal {
  return req.team ?? ownerPrincipal();
}

export function isOwner(req: FastifyRequest): boolean {
  return principalOf(req).kind === 'owner';
}

export function identityOf(principal: Principal, host: Host): TeamIdentity {
  if (principal.kind === 'owner') return { role: 'owner', ownerName: OWNER_NAME };
  const member = host.team.getMember(principal.id);
  return {
    role: principal.role,
    ownerName: OWNER_NAME,
    ...(member
      ? { member: { ...member, online: host.hub.isMemberOnline(member.id) } }
      : {}),
  };
}

/** 角色是否具备审批权（所有者 / 审批者 / 协作者）。 */
export function canApprove(role: TeamRole): boolean {
  return role === 'owner' || role === 'approver' || role === 'collaborator';
}
export function canSend(role: TeamRole): boolean {
  return role === 'owner' || role === 'collaborator';
}

function normalized(p: string): string {
  const resolved = path.resolve(p);
  if (process.platform !== 'win32') return resolved;
  return resolved.replace(/\\/g, '/').toLowerCase();
}

function canonical(p: string): string {
  try {
    return normalized(realpathSync(p));
  } catch {
    return normalized(p);
  }
}

/** dir 是否在某个授权目录内（含目录本身）。 */
export function withinDirs(dir: string, roots: string[]): boolean {
  if (!dir) return false;
  const target = canonical(dir);
  for (const root of roots) {
    if (!root) continue;
    const base = canonical(root);
    const rel = path.relative(base, target);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

export function memberCanAccessPath(principal: Principal, absPath: string): boolean {
  if (principal.kind === 'owner') return true;
  if (!existsSync(absPath)) {
    // 不存在的路径按字面父目录判断，避免新建会话时探测任意路径
    return withinDirs(path.dirname(path.resolve(absPath)), principal.projectDirs);
  }
  return withinDirs(absPath, principal.projectDirs);
}

export function memberCanSeeSession(principal: Principal, rec?: SessionRecord): boolean {
  if (!rec) return false;
  if (principal.kind === 'owner') return true;
  if (withinDirs(rec.cwd, principal.projectDirs)) return true;
  // worktree 会话的 cwd 在 ~/.tandem/worktrees 下，按所属仓库授权
  if (rec.worktreeRepoRoot && withinDirs(rec.worktreeRepoRoot, principal.projectDirs)) return true;
  return false;
}

export interface GuardResult {
  code: number;
  message: string;
}

const OWNER_ANY_PREFIXES = [
  '/api/settings',
  '/api/config',
  '/api/hooks',
  '/api/mcp',
  '/api/pair',
  '/api/shares',
  '/api/budgets',
  '/api/usage',
  '/api/schedules',
  '/api/evals',
  '/api/external-sessions',
  '/api/skills',
  '/api/subagent-presets',
  '/api/prompt-templates',
  '/api/browser',
  '/api/stt',
  '/api/tasks',
  '/api/permissions',
  '/api/memory',
  '/api/gateway',
];
const OWNER_MUTATION_PREFIXES = ['/api/profiles', '/api/models'];
const TEAM_OWNER_PATHS = ['/api/team/members', '/api/team/invites', '/api/team/audit'];
const TRANSFER_RE = /^\/api\/permissions\/[^/]+\/transfer$/;

function startsWithAny(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** 成员 REST 边界：默认拒绝，白名单放行。 */
export function guardMemberRequest(
  host: Host,
  principal: Principal,
  method: string,
  pathname: string,
): GuardResult | undefined {
  if (principal.kind === 'owner') return undefined;
  const upper = method.toUpperCase();

  if (TRANSFER_RE.test(pathname) && upper === 'POST') {
    return canApprove(principal.role) ? undefined : { code: 403, message: '观察者不能转交审批' };
  }
  if (startsWithAny(pathname, OWNER_ANY_PREFIXES)) {
    return { code: 403, message: '该操作仅 Host 所有者可用' };
  }
  if (startsWithAny(pathname, OWNER_MUTATION_PREFIXES) && upper !== 'GET') {
    return { code: 403, message: '该操作仅 Host 所有者可用' };
  }
  if (startsWithAny(pathname, TEAM_OWNER_PATHS)) {
    return { code: 403, message: '仅 Host 所有者可以管理成员' };
  }
  if (pathname === '/api/team/me' && upper === 'GET') return undefined;
  if (pathname === '/api/team/approvers' && upper === 'GET') {
    return canApprove(principal.role) ? undefined : { code: 403, message: '观察者不能转交审批' };
  }
  if (pathname === '/ws') return undefined;
  if (pathname === '/api/host' && upper === 'GET') return undefined;
  if (pathname === '/api/profiles' && upper === 'GET') return undefined;
  if (pathname === '/api/models/capabilities' && upper === 'GET') return undefined;
  if (pathname === '/api/commands' && upper === 'GET') return undefined;
  if (pathname.startsWith('/api/fs/') && upper === 'GET') return undefined;

  if (pathname === '/api/sessions') {
    if (upper === 'GET') return undefined;
    if (upper === 'POST') {
      return canSend(principal.role)
        ? undefined
        : { code: 403, message: '观察者/审批者不能新建会话' };
    }
    return { code: 403, message: '该操作仅 Host 所有者可用' };
  }
  const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/.*)?$/.exec(pathname);
  if (sessionMatch) {
    if (upper !== 'GET') return { code: 403, message: '该操作仅 Host 所有者可用' };
    const rec = host.getSession(decodeURIComponent(sessionMatch[1]!));
    if (!memberCanSeeSession(principal, rec)) {
      // 不暴露其他项目会话是否存在
      return { code: 404, message: '会话不存在' };
    }
    return undefined;
  }

  return { code: 403, message: '该操作仅 Host 所有者可用' };
}

/** 成员读账号列表时隐藏 Key 掩码；模型/端点仍可用于新建会话。 */
export function sanitizeProfilesForMember(profiles: Profile[]): Profile[] {
  return profiles.map((profile) => ({
    ...profile,
    apiKeyMasked: '',
    ...(profile.groups
      ? {
          groups: profile.groups.map((group) => ({
            ...group,
            apiKeyMasked: '',
            keys: group.keys.map((key) => ({
              ...key,
              apiKeyMasked: '',
              ...(key.lastError ? { lastError: undefined } : {}),
            })),
          })),
        }
      : {}),
  }));
}
