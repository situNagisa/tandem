// 上下文估算、系统提示注入记录、预算与用量、模型列表/能力。
import type {
  ContextBreakdown,
  InjectionSnapshot,
  InjectionSegment,
  ListModelsInput,
  ModelInfo,
} from '@tandem/protocol';
import { buildSystemPromptParts } from '../agent/prompt.js';
import { cacheHitRateOf, calibrateBreakdown, estimateBreakdown } from '../context.js';
import { listModels as fetchModelList } from '../providers/index.js';
import type { ListModelsResult } from '../providers/index.js';
import { applyModelCapabilities } from '../providers/capabilities.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';
import { formatUsd } from './helpers.js';

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
  return {
    allowTask,
    planMode: rec.permissionMode === 'plan',
    hookContext: opts.hookContext,
    skills: host.skills.promptSection(rec.cwd),
    memory: host.memory.promptSection(
      rec.cwd,
      host.promptTemplates.get('memoryRule', rec.cwd),
    ),
    delegationPrompt: host.delegationPrompt(rec),
    delegationKey: host.delegationKey(rec),
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
  const parts = buildSystemPromptParts(rec.cwd, host.promptOptions(rec, opts));
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
  if (rec.context) return rec.context;
  const profile = host.profileFor(rec.profileId, rec.groupId);
  const model = rec.model || profile?.defaultModel || '';
  const system = host.buildSystemFor(rec).system;
  const tools = host.toolDefinitions(rec);
  return estimateBreakdown({
    model,
    system,
    tools,
    messages: rec.messages,
    cwd: rec.cwd,
    cacheHitRate: cacheHitRateOf(rec.usage),
    providerKind: profile?.kind,
    capabilityOverrides: profile?.modelCapabilities,
  });
}

export function assertBudget(host: Host, rec: SessionRecord, model: string): void {
  const status = host.budgets.blockingRule({
    profileId: rec.profileId,
    groupId: rec.groupId,
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
  return fetchModelList(input, profile);
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
    const result = await fetchModelList(
      {
        kind: profile.kind,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        profileId,
        groupId,
      },
      profile,
    );
    const found = result.ok ? result.models.find((m) => m.id === model) : undefined;
    if (found) info = { ...found };
  } catch {
    // provider 列表不可用：仍返回内置能力
  }
  info = applyModelCapabilities(info, profile.kind, profile.modelCapabilities);
  host.capabilityCache.set(key, { at: Date.now(), info: { ...info } });
  return info;
}
