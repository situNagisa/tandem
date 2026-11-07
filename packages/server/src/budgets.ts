// 预算：规则存 ~/.tandem/budgets.json，基于 usage.json 的日累计实时计算周期花费。
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  BudgetAction,
  BudgetAlert,
  BudgetPeriod,
  BudgetRule,
  BudgetScope,
  BudgetStatus,
} from '@tandem/protocol';
import { readJson, writePrivateFile } from './config.js';
import type { UsageStore } from './usage.js';

const SCOPES: BudgetScope[] = ['global', 'account', 'group', 'model'];
const PERIODS: BudgetPeriod[] = ['day', 'week', 'month'];
const ACTIONS: BudgetAction[] = ['warn', 'block'];

export interface BudgetContext {
  profileId?: string;
  groupId?: string;
  model?: string;
}

interface BudgetFile {
  rules?: BudgetRule[];
}

export class BudgetStore {
  private file: string;
  private rules: BudgetRule[] = [];
  /** 已广播过的档位：ruleId + 周期起点 → 80/100。 */
  private alerted = new Map<string, Set<'80' | '100'>>();

  constructor(
    home: string,
    private readonly usage: UsageStore,
  ) {
    this.file = path.join(home, 'budgets.json');
    const data = readJson<BudgetFile>(this.file);
    try {
      this.rules = normalizeRules(data?.rules ?? [], false);
    } catch (err) {
      console.warn('[tandem] 预算规则无效，已忽略:', (err as Error).message);
      this.rules = [];
    }
  }

  list(): BudgetRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  /** 整体替换规则；校验失败抛错（路由按 400 返回）。 */
  replace(input: unknown): BudgetRule[] {
    if (!Array.isArray(input)) throw new Error('规则必须是数组');
    const rules = normalizeRules(input, true);
    this.rules = rules;
    this.save();
    // 规则变了，旧档位记录不再适用
    this.alerted.clear();
    return this.list();
  }

  /** 各规则当前周期的用量与百分比。 */
  status(now = new Date()): BudgetStatus[] {
    return this.rules.map((rule) => this.statusOf(rule, now));
  }

  /** 找到会阻止本次请求的 block 规则（未达到 100% 或已停用的忽略）。 */
  blockingRule(context: BudgetContext, now = new Date()): BudgetStatus | undefined {
    return this.status(now).find(
      (status) =>
        status.action === 'block' &&
        status.blocked &&
        ruleMatches(status, context),
    );
  }

  /** 用量变化后检查所有规则，返回本轮新跨过的告警档位（同一周期同档只报一次）。 */
  observe(now = new Date()): BudgetAlert[] {
    const alerts: BudgetAlert[] = [];
    for (const rule of this.rules) {
      if (rule.enabled === false) continue;
      const status = this.statusOf(rule, now);
      if (!status.level) continue;
      const periodKey = periodStartOf(rule.period, now).day;
      const key = `${rule.id}|${periodKey}`;
      let seen = this.alerted.get(key);
      if (!seen) {
        seen = new Set();
        this.alerted.set(key, seen);
      }
      if (seen.has(status.level)) continue;
      seen.add(status.level);
      alerts.push({
        ruleId: rule.id,
        scope: rule.scope,
        spentUsd: status.spentUsd,
        limitUsd: status.limitUsd,
        level: status.level,
        ...(rule.profileId ? { profileId: rule.profileId } : {}),
        ...(rule.groupId ? { groupId: rule.groupId } : {}),
        ...(rule.model ? { model: rule.model } : {}),
        period: rule.period,
        action: rule.action,
      });
    }
    if (this.alerted.size > 500) this.alerted.clear();
    return alerts;
  }

  /** 告警/拒绝文案里的规则名。 */
  describe(rule: Pick<BudgetRule, 'scope' | 'profileId' | 'groupId' | 'model' | 'label' | 'period'>): string {
    if (rule.label?.trim()) return rule.label.trim();
    const period = rule.period === 'day' ? '日' : rule.period === 'week' ? '周' : '月';
    switch (rule.scope) {
      case 'global':
        return `全局${period}预算`;
      case 'account':
        return `账号 ${rule.profileId} 的${period}预算`;
      case 'group':
        return `分组 ${rule.groupId} 的${period}预算`;
      case 'model':
        return `模型 ${rule.model} 的${period}预算`;
    }
  }

  private statusOf(rule: BudgetRule, now: Date): BudgetStatus {
    const start = periodStartOf(rule.period, now);
    const end = nextPeriodStart(rule.period, start.date);
    const lastDay = new Date(end.date);
    lastDay.setDate(lastDay.getDate() - 1);
    const rows = this.usage.list(start.day, localDay(lastDay));
    let spentUsd = 0;
    for (const row of rows) {
      if (!ruleMatches(rule, row)) continue;
      spentUsd += row.costUsd || 0;
    }
    spentUsd = Math.round(spentUsd * 1e8) / 1e8;
    const percent = rule.limitUsd > 0 ? Math.round((spentUsd / rule.limitUsd) * 1000) / 10 : 0;
    const level = percent >= 100 ? '100' : percent >= 80 ? '80' : undefined;
    return {
      ruleId: rule.id,
      scope: rule.scope,
      ...(rule.profileId ? { profileId: rule.profileId } : {}),
      ...(rule.groupId ? { groupId: rule.groupId } : {}),
      ...(rule.model ? { model: rule.model } : {}),
      period: rule.period,
      limitUsd: rule.limitUsd,
      spentUsd,
      percent,
      ...(rule.enabled !== false && level ? { level } : {}),
      action: rule.action,
      blocked: rule.enabled !== false && rule.action === 'block' && percent >= 100,
      resetAt: end.date.getTime(),
    };
  }

  private save(): void {
    writePrivateFile(this.file, JSON.stringify({ rules: this.rules }, null, 2));
  }
}

function ruleMatches(
  rule: Pick<BudgetRule, 'scope' | 'profileId' | 'groupId' | 'model'>,
  context: BudgetContext,
): boolean {
  switch (rule.scope) {
    case 'global':
      return true;
    case 'account':
      return !!rule.profileId && context.profileId === rule.profileId;
    case 'group':
      return (
        !!rule.profileId &&
        !!rule.groupId &&
        context.profileId === rule.profileId &&
        context.groupId === rule.groupId
      );
    case 'model':
      return !!rule.model && context.model === rule.model;
  }
}

/** 某条预算规则状态是否作用于该会话上下文（配额预估/交接共用）。 */
export function budgetStatusMatches(
  status: Pick<BudgetStatus, 'scope' | 'profileId' | 'groupId' | 'model'>,
  context: BudgetContext,
): boolean {
  return ruleMatches(status, context);
}

function normalizeRules(input: unknown[], createIds: boolean): BudgetRule[] {
  const out: BudgetRule[] = [];
  const ids = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<BudgetRule>;
    const scope = item.scope as BudgetScope;
    const period = item.period as BudgetPeriod;
    const action = item.action as BudgetAction;
    if (!SCOPES.includes(scope)) throw new Error(`预算范围无效: ${String(item.scope)}`);
    if (!PERIODS.includes(period)) throw new Error(`预算周期无效: ${String(item.period)}`);
    if (!ACTIONS.includes(action)) throw new Error(`预算动作无效: ${String(item.action)}`);
    const limitUsd = Number(item.limitUsd);
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw new Error('预算上限必须大于 0');
    const profileId = typeof item.profileId === 'string' ? item.profileId.trim() : '';
    const groupId = typeof item.groupId === 'string' ? item.groupId.trim() : '';
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    if (scope === 'account' && !profileId) throw new Error('账号范围需要 profileId');
    if (scope === 'group' && (!profileId || !groupId)) throw new Error('分组范围需要 profileId 与 groupId');
    if (scope === 'model' && !model) throw new Error('模型范围需要 model');
    let id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || ids.has(id)) {
      if (!createIds) continue;
      id = randomUUID();
    }
    ids.add(id);
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    out.push({
      id,
      scope,
      ...(scope === 'account' || scope === 'group' ? { profileId } : {}),
      ...(scope === 'group' ? { groupId } : {}),
      ...(scope === 'model' ? { model } : {}),
      period,
      limitUsd,
      action,
      ...(label ? { label } : {}),
      ...(item.enabled === false ? { enabled: false } : {}),
    });
  }
  return out;
}

function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** 周期起点：自然日 / 本周（周一起）/ 本月。 */
function periodStartOf(period: BudgetPeriod, now: Date): { date: Date; day: string } {
  const today = startOfDay(now);
  if (period === 'day') return { date: today, day: localDay(today) };
  if (period === 'week') {
    const offset = (today.getDay() + 6) % 7;
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    return { date, day: localDay(date) };
  }
  const date = new Date(today.getFullYear(), today.getMonth(), 1);
  return { date, day: localDay(date) };
}

function nextPeriodStart(period: BudgetPeriod, start: Date): { date: Date; day: string } {
  const date = new Date(start);
  if (period === 'day') date.setDate(start.getDate() + 1);
  else if (period === 'week') date.setDate(start.getDate() + 7);
  else date.setMonth(start.getMonth() + 1);
  return { date, day: localDay(date) };
}
