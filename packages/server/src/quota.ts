// 配额预估：根据最近几轮的实际消耗、预算规则与 Key 限流额度，估算还能跑多少轮。
import type { BudgetStatus, QuotaEstimate } from '@tandem/protocol';
import type { SessionRecord, StoredProfile, StoredProfileGroup, StoredProfileKey } from './types.js';

export interface QuotaContext {
  now?: number;
  profile?: StoredProfile;
  group?: StoredProfileGroup;
  /** 当前会阻止请求的预算规则（已按会话账号/分组/模型过滤）。 */
  budgetStatuses?: BudgetStatus[];
  budgetLabel?: (status: BudgetStatus) => string;
}

interface Consumption {
  turns: number;
  avgCostPerTurn?: number;
  avgTokensPerTurn?: number;
  requestsPerTurn: number;
}

/** 最近 3 个真实用户回合内的消耗；没有用量时返回 undefined。 */
export function recentConsumption(rec: SessionRecord): Consumption | undefined {
  const messages = rec.messages.filter((message) => !message.notice && !message.summary);
  const turnStarts: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'user') continue;
    if (message.content.some((block) => block.type !== 'tool_result')) turnStarts.push(index);
  }
  if (turnStarts.length === 0) return undefined;
  const from = turnStarts[Math.max(0, turnStarts.length - 3)] ?? 0;
  let cost = 0;
  let costKnown = false;
  let tokens = 0;
  let requests = 0;
  for (const message of messages.slice(from)) {
    if (message.role !== 'assistant' || !message.usage) continue;
    requests += 1;
    tokens +=
      (message.usage.inputTokens ?? 0) +
      (message.usage.outputTokens ?? 0);
    if (typeof message.usage.costUsd === 'number') {
      cost += message.usage.costUsd;
      costKnown = true;
    }
  }
  if (requests === 0) return undefined;
  const turns = Math.max(1, Math.min(3, turnStarts.length));
  const requestsPerTurn = Math.max(1, Math.round((requests / turns) * 100) / 100);
  return {
    turns,
    ...(costKnown ? { avgCostPerTurn: cost / turns } : {}),
    avgTokensPerTurn: tokens / turns,
    requestsPerTurn,
  };
}

function minDefined(values: Array<number | undefined>): number | undefined {
  let out: number | undefined;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) continue;
    if (out === undefined || value < out) out = value;
  }
  return out;
}

function keyAvailable(key: StoredProfileKey, now: number): boolean {
  if (key.disabled) return false;
  return !key.cooldownUntil || key.cooldownUntil <= now;
}

/** 当前分组的限流预估：取所有可用 Key 中最紧的剩余请求/token。 */
export function keyQuotaEstimate(
  group: StoredProfileGroup | undefined,
  consumption: Consumption | undefined,
  now: number,
): QuotaEstimate['key'] | undefined {
  const keys = group?.keys ?? [];
  if (keys.length === 0) return undefined;
  const available = keys.filter((key) => keyAvailable(key, now));
  const resets = keys
    .flatMap((key) => [
      key.cooldownUntil,
      key.quota?.resetRequestsAt,
      key.quota?.resetTokensAt,
    ])
    .filter((value): value is number => typeof value === 'number' && value > now);
  const resetAt = resets.length ? Math.min(...resets) : undefined;
  if (available.length === 0) {
    return { cooling: true, ...(resetAt !== undefined ? { resetAt } : {}) };
  }
  const remainingRequests = minDefined(
    available.map((key) => key.quota?.remainingRequests),
  );
  const remainingTokens = minDefined(
    available.map((key) => key.quota?.remainingTokens),
  );
  return {
    cooling: false,
    ...(remainingRequests !== undefined ? { remainingRequests } : {}),
    ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

/** 综合预算与限流，给出预计可再跑轮数与瓶颈。 */
export function estimateQuota(rec: SessionRecord, context: QuotaContext = {}): QuotaEstimate {
  const now = context.now ?? Date.now();
  const consumption = recentConsumption(rec);
  const estimates: Array<{ turns: number; by: 'budget' | 'ratelimit' }> = [];
  let budget: QuotaEstimate['budget'];

  const statuses = context.budgetStatuses ?? [];
  for (const status of statuses) {
    const remainingUsd = Math.max(0, status.limitUsd - status.spentUsd);
    const label = context.budgetLabel?.(status) ?? status.ruleId;
    const candidate: NonNullable<QuotaEstimate['budget']> = {
      ruleId: status.ruleId,
      label,
      percent: status.percent,
      remainingUsd,
      resetAt: status.resetAt,
    };
    if (!budget || status.percent > budget.percent) budget = candidate;
    let turns: number | undefined;
    if (status.blocked) turns = 0;
    else if (consumption?.avgCostPerTurn && consumption.avgCostPerTurn > 0) {
      turns = Math.floor(remainingUsd / consumption.avgCostPerTurn);
    }
    if (turns !== undefined) estimates.push({ turns, by: 'budget' });
  }

  const key = keyQuotaEstimate(context.group, consumption, now);
  if (key) {
    if (key.cooling) {
      estimates.push({ turns: 0, by: 'ratelimit' });
    } else if (consumption) {
      const requestTurns =
        key.remainingRequests !== undefined
          ? Math.floor(key.remainingRequests / consumption.requestsPerTurn)
          : undefined;
      const avgTokens = consumption.avgTokensPerTurn;
      const tokenTurns =
        key.remainingTokens !== undefined && avgTokens !== undefined && avgTokens > 0
          ? Math.floor(key.remainingTokens / avgTokens)
          : undefined;
      const turns = minDefined([requestTurns, tokenTurns]);
      if (turns !== undefined) estimates.push({ turns, by: 'ratelimit' });
    }
  }

  let turnsLeft: number | undefined;
  let limitedBy: 'budget' | 'ratelimit' | undefined;
  for (const item of estimates) {
    if (
      turnsLeft === undefined ||
      item.turns < turnsLeft ||
      (item.turns === turnsLeft && item.by === 'budget')
    ) {
      turnsLeft = item.turns;
      limitedBy = item.by;
    }
  }
  return {
    ...(turnsLeft !== undefined ? { turnsLeft: Math.max(0, turnsLeft) } : {}),
    ...(limitedBy ? { limitedBy } : {}),
    ...(consumption?.avgCostPerTurn !== undefined
      ? { avgCostPerTurn: consumption.avgCostPerTurn }
      : {}),
    ...(consumption?.avgTokensPerTurn !== undefined
      ? { avgTokensPerTurn: consumption.avgTokensPerTurn }
      : {}),
    ...(budget ? { budget } : {}),
    ...(key ? { key } : {}),
    updatedAt: now,
  };
}
