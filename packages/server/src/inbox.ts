// 收件箱：跨会话汇总“需要用户处理”的事件（审批、回合结束、预算），
// 供手机/桌面在不打开会话时也能收到提醒并直接审批。
import type {
  BudgetAlert,
  HandoffState,
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

  /** 清除演示工作区产生的事件与未处理审批；返回移除条数。 */
  removeDemo(): number {
    const before = this.events.length + this.pending.size;
    this.events = this.events.filter((event) => !event.demo);
    for (const [id, event] of [...this.pending]) {
      if (event.demo) this.pending.delete(id);
    }
    return before - (this.events.length + this.pending.size);
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
      ...(request.demo ? { demo: true } : {}),
      permission: request,
      requestId: request.id,
      ...(isPlan ? { plan: true } : {}),
    });
    this.pending.set(request.id, event);
    return event;
  }

  /** 审批转交：更新未处理事件里的请求对象（保留原 seq，客户端按 requestId 去重）。 */
  retargetPermission(request: PermissionRequest): InboxEvent | undefined {
    const pending = this.pending.get(request.id);
    if (!pending) return undefined;
    const next: InboxEvent = { ...pending, permission: request };
    this.pending.set(request.id, next);
    const index = this.events.findIndex((event) => event.requestId === request.id && event.kind === 'permission');
    if (index >= 0) this.events[index] = next;
    return next;
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

  recordDivisionPlan(
    request: import('@tandem/protocol').DivisionPlanRequest,
    sessionTitle: string,
  ): InboxEvent {
    return this.push({
      kind: 'division_plan',
      sessionId: request.sessionId,
      sessionTitle,
      requestId: request.id,
      divisionPlan: request,
    });
  }

  recordTurnEnd(
    sessionId: string,
    sessionTitle: string,
    reason: 'done' | 'interrupted' | 'error',
    error?: string,
    opts?: { messageId?: string; silent?: boolean },
  ): InboxEvent {
    return this.push({
      kind: 'turn_end',
      sessionId,
      sessionTitle,
      turnReason: reason,
      ...(opts?.messageId ? { messageId: opts.messageId } : {}),
      ...(error ? { error } : {}),
      ...(opts?.silent ? { silent: true } : {}),
    });
  }

  recordCi(
    sessionId: string,
    sessionTitle: string,
    ci: NonNullable<InboxEvent['ci']>,
  ): InboxEvent {
    return this.push({ kind: 'ci', sessionId, sessionTitle, ci });
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

  recordHandoff(
    state: HandoffState,
    text: string,
    session?: { id: string; title: string },
  ): InboxEvent {
    return this.push({
      kind: 'handoff',
      handoff: { state, text },
      ...(session ? { sessionId: session.id, sessionTitle: session.title } : {}),
    });
  }

  recordEval(input: {
    runId: string;
    suite: string;
    status: 'running' | 'done' | 'cancelled';
    finished: number;
    total: number;
    text: string;
    at?: number;
  }): InboxEvent {
    return this.push({
      kind: 'eval',
      eval: {
        runId: input.runId,
        suite: input.suite,
        status: input.status,
        finished: input.finished,
        total: input.total,
        text: input.text,
      },
      ...(input.at ? { at: input.at } : {}),
    });
  }

  recordBoard(board: NonNullable<InboxEvent['board']>): InboxEvent {
    return this.push({ kind: 'board', board });
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
