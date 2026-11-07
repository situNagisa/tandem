// 配额运行态：记录 provider 限流头、刷新会话预估。
import type { BudgetStatus, QuotaEstimate } from '@tandem/protocol';
import type { ProviderRateLimit } from '../providers/types.js';
import { budgetStatusMatches } from '../budgets.js';
import { estimateQuota } from '../quota.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';

/** 把一个 Key 的响应头额度合并写入 profiles.json（仅分组 Key）。 */
export function recordKeyQuota(host: Host, profileId: string,
    groupId: string | undefined,
    keyId: string | undefined,
    info: ProviderRateLimit): void {
  if (!keyId || !groupId) return;
  const key = host.groupFor(profileId, groupId)?.keys?.find((item) => item.id === keyId);
  if (!key) return;
  const previous = key.quota;
  const quota = {
    ...(previous ?? {}),
    ...(info.remainingRequests !== undefined ? { remainingRequests: info.remainingRequests } : {}),
    ...(info.limitRequests !== undefined ? { limitRequests: info.limitRequests } : {}),
    ...(info.remainingTokens !== undefined ? { remainingTokens: info.remainingTokens } : {}),
    ...(info.limitTokens !== undefined ? { limitTokens: info.limitTokens } : {}),
    ...(info.resetRequestsAt !== undefined ? { resetRequestsAt: info.resetRequestsAt } : {}),
    ...(info.resetTokensAt !== undefined ? { resetTokensAt: info.resetTokensAt } : {}),
    updatedAt: Date.now(),
  };
  host.profiles.updateKeyState(profileId, groupId, keyId, { quota });
}

/** 与会话账号/分组/模型相关的预算状态。 */
export function budgetStatusesFor(host: Host, rec: SessionRecord): BudgetStatus[] {
  const context = { profileId: rec.profileId, groupId: rec.groupId, model: rec.model };
  return host.budgets.status().filter((status) => budgetStatusMatches(status, context));
}

export function estimateFor(host: Host, rec: SessionRecord): QuotaEstimate {
  const statuses = budgetStatusesFor(host, rec);
  return estimateQuota(rec, {
    group: host.groupFor(rec.profileId, rec.groupId),
    budgetStatuses: statuses,
    budgetLabel: (status) => {
      const rule = host.budgets.list().find((item) => item.id === status.ruleId);
      return rule ? host.budgets.describe(rule) : status.ruleId;
    },
  });
}

/** 刷新 rec.quota 与上下文快照里的 quota；broadcast 时同步推 session_updated。 */
export function refreshQuota(host: Host, rec: SessionRecord, broadcast = false): QuotaEstimate {
  const quota = estimateFor(host, rec);
  rec.quota = quota;
  if (rec.context) rec.context = { ...rec.context, quota };
  if (broadcast) host.broadcastSummary(rec);
  return quota;
}
