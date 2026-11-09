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
/** 工作区账号令牌（Ed25519，本地验签）；角色已映射到 Host 角色。 */
export interface AccountPrincipal {
  kind: 'account';
  role: TeamRole;
  id: string;
  name: string;
  username: string;
  accountRole: import('@tandem/protocol').WorkspaceRole;
  projectDirs: string[];
  /** 授权范围是「全部机器 / 指定机器」时，视为可访问该机全部项目。 */
  allProjects?: boolean;
}
/** 其他 Host 用设备级令牌（dvt_…）调用本机设备服务。 */
export interface DevicePrincipal {
  kind: 'device';
  role: 'observer';
  id: string;
  name: string;
  projectDirs: string[];
}
export type Principal = OwnerPrincipal | MemberPrincipal | AccountPrincipal | DevicePrincipal;

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
  return isOwnerLike(principalOf(req));
}

/** 所有者令牌与工作区「所有者/管理员」都视为 Host 级管理员。 */
export function isOwnerLike(principal: Principal): boolean {
  return principal.kind === 'owner' || (principal.kind === 'account' && principal.role === 'owner');
}

export function identityOf(principal: Principal, host: Host): TeamIdentity {
  if (principal.kind === 'owner') return { role: 'owner', ownerName: OWNER_NAME };
  if (principal.kind === 'device') return { role: 'observer', ownerName: OWNER_NAME };
  if (principal.kind === 'account') {
    return {
      role: principal.role,
      ownerName: OWNER_NAME,
      account: { id: principal.id, username: principal.username, name: principal.name, role: principal.accountRole },
    };
  }
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
  if (isOwnerLike(principal)) return true;
  if (principal.kind === 'account' && principal.allProjects) return true;
  if (!existsSync(absPath)) {
    // 不存在的路径按字面父目录判断，避免新建会话时探测任意路径
    return withinDirs(path.dirname(path.resolve(absPath)), principal.projectDirs);
  }
  return withinDirs(absPath, principal.projectDirs);
}

export function memberCanSeeSession(principal: Principal, rec?: SessionRecord): boolean {
  if (!rec) return false;
  if (isOwnerLike(principal)) return true;
  if (principal.kind === 'account' && principal.allProjects) return true;
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
  const upper = method.toUpperCase();
  if (isOwnerLike(principal)) {
    return undefined;
  }
  if (principal.kind === 'device') {
    if (pathname === '/api/devices' || pathname.startsWith('/api/devices/')) {
      if (pathname.includes('/peer-tokens')) return { code: 403, message: '设备令牌不能管理其他设备令牌' };
      return undefined;
    }
    return { code: 403, message: '设备令牌只能访问设备服务' };
  }
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
  // 工作站设备：读列表/日志对成员开放，操作与挂载需要协作者（设备级令牌已在上方单独处理）。
  if (pathname === '/api/devices' || pathname.startsWith('/api/devices/')) {
    if (pathname.includes('/peer-tokens')) return { code: 403, message: '仅 Host 所有者可以管理设备令牌' };
    if (upper === 'GET') return undefined;
    return canSend(principal.role) ? undefined : { code: 403, message: '观察者/审批者不能操作设备' };
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

  if (pathname === '/api/search' && upper === 'GET') return undefined;
  // 项目 Wiki：读操作按项目授权在路由内校验；写入/生成/定时仍归所有者。
  if ((pathname === '/api/wiki' || pathname.startsWith('/api/wiki/')) && upper === 'GET') {
    return undefined;
  }
  const readMatch = /^\/api\/sessions\/([^/]+)\/read$/.exec(pathname);
  if (readMatch && upper === 'POST') {
    const rec = host.getSession(decodeURIComponent(readMatch[1]!));
    if (!memberCanSeeSession(principal, rec)) {
      return { code: 404, message: '会话不存在' };
    }
    return undefined;
  }

  const sessionDevicesMatch = /^\/api\/sessions\/([^/]+)\/devices(?:\/.*)?$/.exec(pathname);
  if (sessionDevicesMatch) {
    const rec = host.getSession(decodeURIComponent(sessionDevicesMatch[1]!));
    if (!memberCanSeeSession(principal, rec)) return { code: 404, message: '会话不存在' };
    if (upper === 'GET') return undefined;
    return canSend(principal.role) ? undefined : { code: 403, message: '观察者/审批者不能操作设备' };
  }
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
