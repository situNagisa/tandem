// 收件箱：跨会话汇总“需要用户处理”的事件（审批、回合结束、预算），
// 供手机/桌面在不打开会话时也能收到提醒并直接审批。
import type {
  BudgetAlert,
  InboxEvent,
  InboxSnapshot,
  PermissionDecision,
  PermissionRequest,
} from '@tandem/protocol';

/** 保留的最近事件条数；超出的旧事件被挤出，未处理审批另有 pending 表兜底。 */
export const INBOX_EVENT_LIMIT = 400;

export class Inbox {
  private events: InboxEvent[] = [];
  private pending = new Map<string, InboxEvent>();
  private seq = 0;

  currentSeq(): number {
    return this.seq;
  }

  private push(input: Omit<InboxEvent, 'seq' | 'at'> & { at?: number }): InboxEvent {
    this.seq += 1;
    const event: InboxEvent = { ...input, seq: this.seq, at: input.at ?? Date.now() };
    this.events.push(event);
    if (this.events.length > INBOX_EVENT_LIMIT) {
      this.events.splice(0, this.events.length - INBOX_EVENT_LIMIT);
    }
    return event;
  }

  recordPermission(request: PermissionRequest, sessionTitle: string): InboxEvent {
    const isPlan = request.toolName === 'ExitPlanMode';
    const event = this.push({
      kind: 'permission',
      sessionId: request.sessionId,
      sessionTitle,
      ...(request.depth ? { depth: request.depth } : {}),
      ...(request.sourceTitle ? { sourceTitle: request.sourceTitle } : {}),
      permission: request,
      requestId: request.id,
      ...(isPlan ? { plan: true } : {}),
    });
    this.pending.set(request.id, event);
    return event;
  }

  /** 审批被任意一端处理（或中断）后，从未处理表移除并记录结果。 */
  resolvePermission(requestId: string, decision: PermissionDecision): InboxEvent | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    return this.push({
      kind: 'permission_resolved',
      requestId,
      decision,
      ...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
      ...(pending.sessionTitle ? { sessionTitle: pending.sessionTitle } : {}),
      ...(pending.permission ? { permission: pending.permission } : {}),
    });
  }

  recordTurnEnd(
    sessionId: string,
    sessionTitle: string,
    reason: 'done' | 'interrupted' | 'error',
    error?: string,
  ): InboxEvent {
    return this.push({
      kind: 'turn_end',
      sessionId,
      sessionTitle,
      turnReason: reason,
      ...(error ? { error } : {}),
    });
  }

  recordBudget(
    alert: BudgetAlert,
    text: string,
    session?: { id: string; title: string },
  ): InboxEvent {
    return this.push({
      kind: 'budget',
      budget: alert,
      budgetText: text,
      ...(session ? { budgetSessionId: session.id, budgetSessionTitle: session.title } : {}),
    });
  }

  /**
   * 订阅/重连时的快照。sinceSeq 覆盖时只返回增量事件，否则返回完整缓冲；
   * pending 始终是服务端权威的未处理审批列表。
   */
  snapshot(sinceSeq?: number): InboxSnapshot {
    const pending = [...this.pending.values()].sort((a, b) => a.at - b.at);
    if (
      typeof sinceSeq === 'number' &&
      Number.isFinite(sinceSeq) &&
      sinceSeq >= 0 &&
      sinceSeq <= this.seq &&
      (sinceSeq === this.seq || (this.events[0]?.seq ?? this.seq + 1) <= sinceSeq + 1)
    ) {
      return {
        seq: this.seq,
        events: this.events.filter((event) => event.seq > sinceSeq),
        pending,
      };
    }
    return { seq: this.seq, events: this.events.slice(), pending };
  }
}

/** 预算告警的收件箱文案（与 Host 内 notice 保持一致的口径）。 */
export function budgetInboxText(alert: BudgetAlert, name: string, spent: string, limit: string): string {
  const percent = alert.limitUsd > 0 ? Math.round((alert.spentUsd / alert.limitUsd) * 1000) / 10 : 0;
  const level = alert.level === '100' ? '已达上限' : '接近上限';
  return `预算${level}：「${name}」本期已用 ${spent} / ${limit}（${percent}%）`;
}
