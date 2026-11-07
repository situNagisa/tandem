// 团队审计：记录成员/所有者的关键动作，最多保留最近 200 条。
import type { TeamAuditAction } from '@tandem/protocol';
import type { Host } from '../host.js';
import type { Principal } from './access.js';

export function recordAudit(
  host: Host,
  principal: Principal,
  action: TeamAuditAction,
  extra: { sessionId?: string; sessionTitle?: string; detail?: string } = {},
): void {
  host.team.addAudit({
    actorId: principal.id,
    actorName: principal.name,
    role: principal.role,
    action,
    ...extra,
  });
}
