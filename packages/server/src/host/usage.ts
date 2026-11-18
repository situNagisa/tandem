// 上下文估算、系统提示注入记录、预算与用量、模型列表/能力。
import type {
  ContextBreakdown,
  InjectionSnapshot,
  InjectionSegment,
  ListModelsInput,
  ModelInfo,
  ModelPriceInfo,
  SessionUsageBreakdown,
  SessionUsageRow,
} from '@tandem/protocol';
import { buildSystemPromptParts } from '../agent/prompt.js';
import { normalizeContextSettings } from '../context-settings.js';
import {
  cacheHitRateOf,
  calibrateBreakdown,
  estimateBreakdown,
  trimOldToolResults,
} from '../context.js';
import { listModels as fetchModelList } from '../providers/index.js';
import type { ListModelsResult } from '../providers/index.js';
import { applyModelCapabilities } from '../providers/capabilities.js';
import { priceForModel, priceInfoFor, resolvePriceForModel } from '../usage.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';
import { formatUsd } from './helpers.js';
import { withLiveWindow } from './sessions.js';

export function setContext(host: Host, rec: SessionRecord, context: ContextBreakdown, broadcast = true): void {
  rec.context = context;
  if (broadcast) host.broadcastSummary(rec);
}

export function calibrateContext(host: Host, rec: SessionRecord, context: ContextBreakdown, actualInputTokens: number): void {
  const calibrated = calibrateBreakdown(context, actualInputTokens, cacheHitRateOf(rec.usage));
  host.setContext(rec, calibrated, false);
}

export function promptOptions(host: Host, rec: SessionRecord,
    opts: { allowTask?: boolean; hookContext?: string } = {}) {
  const allowTask = opts.allowTask !== false;
  // 取向关闭只影响取向说明（见 routePlanInjection），分工说明照常注入。
  const withDelegationPrompt = allowTask;
  return {
    allowTask,
    planMode: rec.permissionMode === 'plan',
    hookContext: opts.hookContext,
    skills: host.skills.promptSection(rec.cwd),
    secrets: host.secrets.promptSection(rec.cwd),
    memory: host.memory.promptSection(
      rec.cwd,
      host.promptTemplates.get('memoryRule', rec.cwd),
    ),
    wiki: rec.wikiRun ? '' : host.wiki.promptSection(rec.cwd),
    ...(withDelegationPrompt
      ? { delegationPrompt: host.delegationPrompt(rec), delegationKey: host.delegationKey(rec) }
      : {}),
    ...(allowTask
      ? {
          subagents: host.subagentPresets
            .list(rec.cwd)
            .map((preset) => ({ name: preset.name, description: preset.description })),
        }
      : {}),
    ...(rec.systemPromptExtra ? { extraSystemPrompt: rec.systemPromptExtra } : {}),
    prompts: withPromptOverrides(host.promptTemplates.resolved(rec.cwd), rec),
  };
}

/** 评测配置的提示词覆盖只对该会话生效，优先于项目/用户/内置。 */
function withPromptOverrides(
  prompts: Record<string, { text: string; source: import('@tandem/protocol').PromptSource }>,
  rec: SessionRecord,
): Record<string, { text: string; source: import('@tandem/protocol').PromptSource }> {
  if (!rec.promptOverrides) return prompts;
  const merged = { ...prompts };
  for (const [key, text] of Object.entries(rec.promptOverrides)) {
    if (typeof text === 'string' && text.trim()) merged[key] = { text, source: 'user' };
  }
  return merged;
}

export function buildSystemFor(host: Host, rec: SessionRecord,
    opts: { allowTask?: boolean; hookContext?: string } = {}): { system: string; parts: InjectionSegment[] } {
  const machine = host.remote ? { platform: host.env.platform, git: false } : undefined;
  const parts = buildSystemPromptParts(rec.cwd, { ...host.promptOptions(rec, opts), ...(machine ? { machine } : {}) });
  return { system: parts.map((part) => part.content).join('\n\n'), parts };
}

export function recordInjections(host: Host, rec: SessionRecord,
    segments: InjectionSegment[],
    beforeMessageId?: string): InjectionSnapshot {
  const prev = host.injections.get(rec.id);
  const changes = prev?.changes ?? [];
  let changed = !prev;
  if (prev) {
    const prevMap = new Map(prev.segments.map((item) => [item.id, item]));
    const nextMap = new Map(segments.map((item) => [item.id, item]));
    const added = segments.filter((item) => !prevMap.has(item.id)).map((item) => item.name);
    const removed = prev.segments.filter((item) => !nextMap.has(item.id)).map((item) => item.name);
    const modified = segments
      .filter((item) => {
        const before = prevMap.get(item.id);
        return before && before.content !== item.content;
      })
      .map((item) => item.name);
    if (added.length || removed.length || modified.length) {
      changed = true;
      changes.unshift({
        ...(beforeMessageId ? { beforeMessageId } : {}),
        at: Date.now(),
        added: [...added, ...modified],
        removed,
        summary: [
          ...added.map((name) => `+${name}`),
          ...removed.map((name) => `−${name}`),
          ...modified.map((name) => `~${name}`),
        ].join(' '),
      });
      if (changes.length > 20) changes.length = 20;
    }
  }
  const snapshot: InjectionSnapshot = {
    segments,
    totalTokens: segments.reduce((sum, item) => sum + item.tokens, 0),
    updatedAt: Date.now(),
    changes,
  };
  host.injections.set(rec.id, {
    segments,
    changes,
    updatedAt: snapshot.updatedAt,
  });
  if (changed) {
    host.hub.broadcastSession(rec.id, { type: 'injections', sessionId: rec.id, injections: snapshot });
  }
  return snapshot;
}

export function injectionsFor(host: Host, rec: SessionRecord): InjectionSnapshot {
  const cached = host.injections.get(rec.id);
  if (cached) {
    return {
      segments: cached.segments,
      totalTokens: cached.segments.reduce((sum, item) => sum + item.tokens, 0),
      updatedAt: cached.updatedAt,
      changes: cached.changes,
    };
  }
  const { parts } = host.buildSystemFor(rec, { allowTask: (rec.depth ?? 0) === 0 });
  host.injections.set(rec.id, { segments: parts, changes: [], updatedAt: Date.now() });
  return {
    segments: parts,
    totalTokens: parts.reduce((sum, item) => sum + item.tokens, 0),
    updatedAt: Date.now(),
    changes: [],
  };
}

export function contextFor(host: Host, rec: SessionRecord): ContextBreakdown {
  const settings = normalizeContextSettings(host.config.context);
  const autoCompact = {
    enabled: settings.autoCompact,
    threshold: settings.autoCompactThreshold,
  };
  const quota = host.estimateQuota(rec);
  // 设置可能在会话期间改过：返回时用当前阈值覆盖旧快照；分母按当前型号/1M 开关重算
  if (rec.context) return { ...withLiveWindow(host, rec, rec.context), autoCompact, quota };
  const profile = host.profileFor(rec.route?.profileId ?? rec.profileId, rec.route?.groupId ?? rec.groupId);
  const model = rec.route?.model || rec.model || profile?.defaultModel || '';
  const system = host.buildSystemFor(rec).system;
  const tools = host.toolDefinitions(rec);
  const allowTask = (rec.depth ?? 0) === 0;
  const messages = trimOldToolResults(
    rec.messages.filter((m) => !m.notice),
    settings,
  ).messages;
  return {
    ...estimateBreakdown({
      model,
      system,
      tools,
      messages,
      cwd: rec.cwd,
      cacheHitRate: cacheHitRateOf(rec.usage),
      providerKind: profile?.kind,
      capabilityOverrides: profile?.modelCapabilities,
      longContext: rec.longContext,
      autoCompact,
      ...(allowTask
        ? {
            agents: host.subagentPresets
              .list(rec.cwd)
              .map((preset) => ({ name: preset.name, description: preset.description })),
          }
        : {}),
    }),
    quota,
  };
}

export function assertBudget(host: Host, rec: SessionRecord, model: string,
    scope?: { profileId?: string; groupId?: string }): void {
  host.boards.assertCardBudget(rec);
  // 用户在本会话选过「继续使用当前分组」：预算阻止不再拦截，直到用户自己改掉预算规则
  if (rec.handoffBypass?.includes('budget')) return;
  const status = host.budgets.blockingRule({
    profileId: scope?.profileId ?? rec.profileId,
    groupId: scope?.groupId ?? rec.groupId,
    model,
  });
  if (!status) return;
  const rt = host.ensureRuntime(rec.id);
  if (rt.budgetAllowOnce) {
    rt.budgetAllowOnce = false;
    return;
  }
  const rule = host.budgets.list().find((item) => item.id === status.ruleId);
  const name = rule ? host.budgets.describe(rule) : status.ruleId;
  throw new Error(
    `预算已达上限：${name} 本期已用 ${formatUsd(status.spentUsd)} / ${formatUsd(status.limitUsd)}（${status.percent}%），已阻止新请求。可在会话中临时放行一次。`,
  );
}

export function allowBudgetOnce(host: Host, sessionId: string): boolean {
  const rec = host.store.get(sessionId);
  if (!rec) return false;
  host.ensureRuntime(sessionId).budgetAllowOnce = true;
  return true;
}

export function observeBudgets(host: Host, rec: SessionRecord): void {
  const alerts = host.budgets.observe();
  for (const alert of alerts) {
    host.hub.broadcastAll({ type: 'budget_alert', ...alert });
    const rule = host.budgets.list().find((item) => item.id === alert.ruleId);
    const name = rule
      ? host.budgets.describe(rule)
      : host.budgets.describe({
          scope: alert.scope,
          period: alert.period,
          ...(alert.profileId ? { profileId: alert.profileId } : {}),
          ...(alert.groupId ? { groupId: alert.groupId } : {}),
          ...(alert.model ? { model: alert.model } : {}),
        });
    const percent = alert.limitUsd > 0 ? Math.round((alert.spentUsd / alert.limitUsd) * 1000) / 10 : 0;
    const text =
      alert.level === '100'
        ? `预算提醒：「${name}」本期已用 ${formatUsd(alert.spentUsd)} / ${formatUsd(alert.limitUsd)}（${percent}%）${
            alert.action === 'block' ? '，后续模型请求将被拒绝，可在会话中临时放行一次。' : '。'
          }`
        : `预算提醒：「${name}」本期已用 ${formatUsd(alert.spentUsd)} / ${formatUsd(alert.limitUsd)}（${percent}%）。`;
    host.appendNotice(rec, text);
    // 收件箱：预算告警是 Host 级事件，绑定触发本次用量的会话便于跳回
    host.pushInbox(
      host.inbox.recordBudget(alert, text, { id: rec.id, title: rec.title }),
    );
  }
}

export function listModels(host: Host, input: ListModelsInput): Promise<ListModelsResult> {
  const profile = input.profileId
    ? host.profileFor(input.profileId, input.groupId)
    : undefined;
  // 账号级模型账号：主机的 Key 为空，模型列表也在工作站用真实 Key 拉取。
  if (profile?.proxied) {
    const client = host.workstationProfiles();
    const accountId = profile.accountId ?? host.accounts.ownerAccountId();
    if (!client || !accountId) {
      return Promise.resolve({ ok: false, models: [], error: '主机未连接工作站' });
    }
    return client.listModels(accountId, input);
  }
  return fetchModelList(input, profile);
}

/** 菜单参考单价：账号覆盖优先，其次内置表；每百万 token 美元。 */
export function modelPrices(host: Host, profileId: string,
    groupId?: string): Record<string, ModelPriceInfo> {
  const profile = host.profileFor(profileId, groupId);
  if (!profile) return {};
  const models = profile.models.length ? profile.models : [profile.defaultModel].filter(Boolean);
  const out: Record<string, ModelPriceInfo> = {};
  for (const model of models) {
    const resolved = resolvePriceForModel(profile, model);
    if (resolved) {
      const group = resolved.groupMultiplier ?? 1;
      out[model] = {
        ...priceInfoFor(resolved.price, profile.kind),
        source: resolved.source,
        ...(group !== 1 && resolved.official
          ? {
              officialInput: resolved.official.input,
              officialOutput: resolved.official.output,
              groupMultiplier: group,
            }
          : {}),
      };
    }
  }
  return out;
}

export async function modelCapabilities(host: Host, profileId: string,
    groupId: string | undefined,
    model: string): Promise<ModelInfo | undefined> {
  const profile = host.profileFor(profileId, groupId);
  if (!profile || !model) return undefined;
  const key = `${profileId}:${groupId ?? ''}:${model}`;
  const cached = host.capabilityCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60_000) return { ...cached.info };

  let info: ModelInfo = { id: model };
  try {
    const result = await listModels(host, {
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
      profileId,
      groupId,
    });
    const found = result.ok ? result.models.find((m) => m.id === model) : undefined;
    if (found) info = { ...found };
  } catch {
    // provider 列表不可用：仍返回内置能力
  }
  info = applyModelCapabilities(info, profile.kind, profile.modelCapabilities);
  host.capabilityCache.set(key, { at: Date.now(), info: { ...info } });
  return info;
}

/**
 * 会话用量按模型拆分：从消息上的 usage 汇总，差额单列「其他（压缩/评审等）」。
 * 单价按当前账号/分组解析，只用于解释计算式；各行金额是记账时的值，历史不重算。
 */
export function sessionUsageBreakdown(host: Host, rec: SessionRecord): SessionUsageBreakdown {
  const rows = new Map<string, SessionUsageRow>();
  const round = (value: number) => Math.round(value * 1e8) / 1e8;
  for (const message of rec.messages) {
    if (message.role !== 'assistant' || !message.usage) continue;
    const model = message.model || rec.model;
    const usage = message.usage;
    const row = rows.get(model) ?? {
      model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    row.calls += 1;
    row.inputTokens += usage.inputTokens || 0;
    row.outputTokens += usage.outputTokens || 0;
    row.cacheReadTokens += usage.cacheReadTokens || 0;
    row.cacheWriteTokens += usage.cacheWriteTokens || 0;
    row.costUsd = round(row.costUsd + (usage.costUsd || 0));
    rows.set(model, row);
  }
  const list = [...rows.values()].sort((a, b) => b.costUsd - a.costUsd);
  const sum = list.reduce(
    (acc, row) => ({
      inputTokens: acc.inputTokens + row.inputTokens,
      outputTokens: acc.outputTokens + row.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
      costUsd: round(acc.costUsd + row.costUsd),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
  );
  const residual: SessionUsageRow = {
    model: '其他',
    calls: 0,
    inputTokens: Math.max(0, (rec.usage.inputTokens || 0) - sum.inputTokens),
    outputTokens: Math.max(0, (rec.usage.outputTokens || 0) - sum.outputTokens),
    cacheReadTokens: Math.max(0, (rec.usage.cacheReadTokens || 0) - sum.cacheReadTokens),
    cacheWriteTokens: Math.max(0, (rec.usage.cacheWriteTokens || 0) - sum.cacheWriteTokens),
    costUsd: round(Math.max(0, (rec.usage.costUsd || 0) - sum.costUsd)),
  };
  const profile = rec.profileId ? host.profileFor(rec.profileId, rec.groupId) : undefined;
  const prices: Record<string, import('@tandem/protocol').ModelPriceInfo> = {};
  for (const row of list) {
    const resolved = resolvePriceForModel(profile, row.model);
    if (!resolved) continue;
    prices[row.model] = {
      ...priceInfoFor(resolved.price, profile?.kind ?? 'openai-compatible'),
      source: resolved.source,
      ...(resolved.official ? { officialInput: resolved.official.input, officialOutput: resolved.official.output } : {}),
      ...(resolved.groupMultiplier ? { groupMultiplier: resolved.groupMultiplier } : {}),
    };
  }
  return { rows: list, residual, total: { ...rec.usage }, prices, ...(rec.profileId ? { profileId: rec.profileId } : {}) };
}
