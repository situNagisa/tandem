// 网关统计：按成员聚合 UsageStore 里带 memberId 的行（每个请求只记一行，不会重复计数）。
import type { GatewayMemberUsage, GatewayToken, TeamMember } from '@tandem/protocol';
import type { UsageStore } from '../usage.js';

function dayString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function monthStart(date: Date): string {
  return dayString(new Date(date.getFullYear(), date.getMonth(), 1));
}

/** 每个团队成员今天的请求数/token/花费，以及本月花费；带当前令牌限额。 */
export function gatewayMemberUsage(
  usage: UsageStore,
  members: TeamMember[],
  tokens: GatewayToken[],
  now = new Date(),
): GatewayMemberUsage[] {
  const today = dayString(now);
  const from = monthStart(now);
  const rows = usage.list(from, today);
  const byMember = new Map<string, { requests: number; input: number; output: number; todayCost: number; monthCost: number }>();
  for (const row of rows) {
    if (!row.memberId) continue;
    const entry = byMember.get(row.memberId) ?? { requests: 0, input: 0, output: 0, todayCost: 0, monthCost: 0 };
    entry.monthCost += row.costUsd || 0;
    if (row.day === today) {
      entry.requests += row.turns || 0;
      entry.input += row.inputTokens || 0;
      entry.output += row.outputTokens || 0;
      entry.todayCost += row.costUsd || 0;
    }
    byMember.set(row.memberId, entry);
  }
  const activeByMember = new Map<string, GatewayToken>();
  const anyByMember = new Map<string, GatewayToken>();
  for (const token of [...tokens].sort((a, b) => b.createdAt - a.createdAt)) {
    if (!anyByMember.has(token.memberId)) anyByMember.set(token.memberId, token);
    if (!token.revokedAt && !activeByMember.has(token.memberId)) activeByMember.set(token.memberId, token);
  }
  return members
    .map((member) => {
      const entry = byMember.get(member.id);
      const active = activeByMember.get(member.id);
      const latest = active ?? anyByMember.get(member.id);
      return {
        memberId: member.id,
        memberName: member.name,
        todayRequests: entry?.requests ?? 0,
        todayInputTokens: entry?.input ?? 0,
        todayOutputTokens: entry?.output ?? 0,
        todayCostUsd: round(entry?.todayCost ?? 0),
        monthCostUsd: round(entry?.monthCost ?? 0),
        tokenCount: [...activeByMember.keys()].includes(member.id) ? 1 : 0,
        ...(latest?.dailyLimitUsd ? { dailyLimitUsd: latest.dailyLimitUsd } : {}),
        ...(latest?.monthlyLimitUsd ? { monthlyLimitUsd: latest.monthlyLimitUsd } : {}),
        ...(latest ? { rpm: latest.rpm } : {}),
        ...(latest?.lastUsedAt ? { lastUsedAt: latest.lastUsedAt } : {}),
      } satisfies GatewayMemberUsage;
    })
    .sort((a, b) => b.todayCostUsd - a.todayCostUsd || b.todayRequests - a.todayRequests || a.memberName.localeCompare(b.memberName, 'zh-Hans-CN'));
}

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** 成员当前自然日 / 本月已花费（网关限额判定用）。 */
export function memberSpend(
  usage: UsageStore,
  memberId: string,
  now = new Date(),
): { todayUsd: number; monthUsd: number } {
  const today = dayString(now);
  const rows = usage.list(monthStart(now), today);
  let todayUsd = 0;
  let monthUsd = 0;
  for (const row of rows) {
    if (row.memberId !== memberId) continue;
    monthUsd += row.costUsd || 0;
    if (row.day === today) todayUsd += row.costUsd || 0;
  }
  return { todayUsd: round(todayUsd), monthUsd: round(monthUsd) };
}
