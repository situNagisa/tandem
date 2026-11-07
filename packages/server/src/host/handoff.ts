// 会话交接：额度将尽时暂停/切换备用分组/等待重置，并在切换前保存检查点、压缩上下文。
import { randomUUID } from 'node:crypto';
import type { HandoffReason, HandoffState } from '@tandem/protocol';
import { normalizeContextSettings } from '../context-settings.js';
import { contextWindowForModel, estimateMessagesTokens, estimateTokens } from '../context.js';
import {
  groupUsable,
  handoffMessage,
  handoffResumeAt,
  handoffSettings,
  handoffNotice,
  peerOf,
  selectHandoffTarget,
} from '../handoff.js';
import type { SessionRecord } from '../types.js';
import type { Host } from '../host.js';
import { compactHistory } from './compaction.js';
import { budgetStatusesFor } from './quota.js';

const ACTIVE_STATUSES = new Set<HandoffState['status']>(['pending', 'switching', 'waiting']);

/** 当前是否有尚未结束的交接（避免每轮重复弹卡）。 */
export function handoffActive(rec: SessionRecord): boolean {
  return !!rec.handoff && ACTIVE_STATUSES.has(rec.handoff.status);
}

function planHandoff(host: Host, rec: SessionRecord, reason: HandoffReason): HandoffState {
  const profile = host.profiles.get(rec.profileId);
  const from = profile
    ? peerOf(profile, rec.groupId, rec.model)
    : {
        profileId: rec.profileId,
        ...(rec.groupId ? { groupId: rec.groupId } : {}),
        ...(rec.model ? { model: rec.model } : {}),
        label: rec.profileId,
      };
  const settings = handoffSettings(host.config.handoff);
  const target = selectHandoffTarget(
    host.profiles.list(),
    { profileId: rec.profileId, ...(rec.groupId ? { groupId: rec.groupId } : {}), model: rec.model },
    settings,
  );
  const statuses = budgetStatusesFor(host, rec);
  const budget = statuses.slice().sort((a, b) => b.percent - a.percent)[0];
  const resumeAt = handoffResumeAt(
    host.groupFor(rec.profileId, rec.groupId),
    budget?.resetAt,
  );
  return {
    id: randomUUID(),
    reason,
    status: 'pending',
    createdAt: Date.now(),
    from,
    ...(target ? { target } : {}),
    resumeAt,
    message: handoffMessage(from, reason),
  };
}

function persistHandoff(host: Host, rec: SessionRecord, state: HandoffState): void {
  rec.handoff = state;
  host.store.markDirty(rec.id, true);
  host.broadcastSummary(rec);
}

/** 需要用户选择时：保存交接卡并推收件箱。 */
function requestChoice(host: Host, rec: SessionRecord, state: HandoffState): void {
  state.status = 'pending';
  persistHandoff(host, rec, state);
  host.pushInbox(
    host.inbox.recordHandoff(state, `${state.message}切换分组 / 等待重置 / 暂停`, {
      id: rec.id,
      title: rec.title,
    }),
  );
}

function sleepUntil(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('用户中断'));
      return;
    }
    let settled = false;
    const finish = (aborted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted) reject(new Error('用户中断'));
      else resolve();
    };
    const timer = setTimeout(() => finish(false), Math.max(0, ms));
    const onAbort = () => finish(true);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 等到重置时间后继续当前回合（自动等待策略）。 */
async function waitAndContinue(
  host: Host,
  rec: SessionRecord,
  state: HandoffState,
  signal?: AbortSignal,
): Promise<void> {
  state.status = 'waiting';
  persistHandoff(host, rec, state);
  await sleepUntil((state.resumeAt ?? Date.now() + 60_000) - Date.now(), signal);
  state.status = 'done';
  state.resolvedAt = Date.now();
  persistHandoff(host, rec, state);
  host.appendNotice(rec, '额度已重置，继续运行');
}

/** 简单估算目标模型的上下文是否放得下；放不下就用现有自动压缩压到窗口内。 */
async function fitContextForTarget(
  host: Host,
  rec: SessionRecord,
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  const profile = host.profileFor(rec.profileId, rec.groupId);
  if (!profile) return;
  const settings = normalizeContextSettings(host.config.context);
  const window = contextWindowForModel(model, profile.kind, profile.modelCapabilities);
  const limit = Math.floor(window * Math.min(0.8, settings.autoCompactThreshold));
  const used = () =>
    estimateMessagesTokens(rec.messages.filter((message) => !message.notice)) +
    estimateTokens(host.buildSystemFor(rec).system) +
    4096;
  for (let attempt = 0; attempt < 2 && used() > limit; attempt++) {
    const compacted = await compactHistory(host, rec, rec.messages, {
      model,
      keepTurns: settings.autoCompactKeepTurns,
      auto: true,
      force: true,
      ...(signal ? { signal } : {}),
    }).catch(() => undefined);
    if (!compacted) break;
    rec.messages = compacted.messages;
    host.observeBudgets(rec);
    host.store.markDirty(rec.id, true);
    host.broadcastSnapshot(rec);
  }
}

/** 切换：先存检查点 → 改账号/分组/模型 → 压缩到目标窗口 → 记录交接提示。 */
export async function performSwitch(
  host: Host,
  rec: SessionRecord,
  state: HandoffState,
  via: 'auto' | 'user',
  signal?: AbortSignal,
): Promise<boolean> {
  const target = state.target;
  if (!target) return false;
  const profile = host.profiles.get(target.profileId);
  if (!profile) return false;
  const group = target.groupId
    ? profile.groups?.find((item) => item.id === target.groupId)
    : undefined;
  if (target.groupId && !group) return false;
  if (group && !groupUsable(group)) return false;
  const model =
    target.model ||
    group?.defaultModel ||
    group?.models[0] ||
    profile.defaultModel ||
    profile.models[0] ||
    rec.model;
  if (!model) return false;

  state.status = 'switching';
  persistHandoff(host, rec, state);
  const checkpoint = host.checkpoints.create(rec.id, `handoff-${state.id}`);
  state.checkpointId = checkpoint.id;

  rec.profileId = target.profileId;
  if (target.groupId) rec.groupId = target.groupId;
  else delete rec.groupId;
  rec.model = model;
  host.store.markDirty(rec.id, true);
  host.broadcastSummary(rec);

  try {
    await fitContextForTarget(host, rec, model, signal);
  } catch (err) {
    host.appendNotice(rec, `交接前的上下文压缩失败，已按原历史继续：${(err as Error).message}`);
  }

  host.appendNotice(rec, handoffNotice(state));
  state.status = 'done';
  state.resolvedAt = Date.now();
  state.via = via;
  persistHandoff(host, rec, state);
  host.broadcastSnapshot(rec);
  return true;
}

/**
 * Agent 循环在请求前/全部 Key 耗尽时调用：
 * 返回 continue 表示已切换或等待结束，可以继续当前回合；返回 stop 表示已暂停等待用户选择。
 */
export async function triggerHandoff(
  host: Host,
  rec: SessionRecord,
  reason: HandoffReason,
  signal?: AbortSignal,
): Promise<'continue' | 'stop'> {
  if (handoffActive(rec)) return 'stop';
  const settings = handoffSettings(host.config.handoff);
  const state = planHandoff(host, rec, reason);
  if (settings.policy === 'switch') {
    if (state.target) {
      const ok = await performSwitch(host, rec, state, 'auto', signal);
      if (ok) return 'continue';
    }
    requestChoice(host, rec, state);
    return 'stop';
  }
  if (settings.policy === 'wait') {
    await waitAndContinue(host, rec, state, signal);
    return 'continue';
  }
  requestChoice(host, rec, state);
  return 'stop';
}

/** 用户从交接卡选择继续方式。返回更新后的会话（切换/等待的后续回合异步开始）。 */
export async function chooseHandoff(host: Host, rec: SessionRecord,
    action: 'switch' | 'wait' | 'pause'): Promise<SessionRecord> {
  const state = rec.handoff;
  if (!state || state.status === 'done') throw new Error('当前没有待处理的交接');
  if (action === 'switch') {
    if (!state.target) throw new Error('没有可切换的备用分组，请先在账号设置里配置');
    const ok = await performSwitch(host, rec, state, 'user');
    if (!ok) throw new Error('备用分组当前不可用');
    host.resumeAfterHandoff(rec.id, 'switch');
    return rec;
  }
  if (action === 'wait') {
    const resumeAt = state.resumeAt ?? Date.now() + 60_000;
    state.status = 'waiting';
    state.resumeAt = resumeAt;
    state.via = 'user';
    persistHandoff(host, rec, state);
    host.scheduleHandoffResume(rec.id, Math.max(0, resumeAt - Date.now()));
    return rec;
  }
  state.status = 'paused';
  state.resolvedAt = Date.now();
  state.via = 'user';
  persistHandoff(host, rec, state);
  host.appendNotice(rec, '已暂停；额度恢复后可从交接卡继续。');
  return rec;
}

/** 用户直接发新消息时取消尚未处理的交接卡/等待计时器。 */
export function cancelHandoff(host: Host, rec: SessionRecord): void {
  if (!rec.handoff || rec.handoff.status === 'done') return;
  const timer = host.handoffTimers.get(rec.id);
  if (timer) {
    clearTimeout(timer);
    host.handoffTimers.delete(rec.id);
  }
  delete rec.handoff;
  host.store.markDirty(rec.id, false);
}

