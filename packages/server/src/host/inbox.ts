// 收件箱：跨会话事件（审批/回合结束/预算/CI）推送与快照。
import type { InboxEvent } from '@tandem/protocol';
import type { Host } from '../host.js';

export function pushInbox(host: Host, event: InboxEvent): void {
  host.hub.broadcastInbox({ type: 'inbox_event', event });
}

export function inboxSnapshot(host: Host, sinceSeq?: number) {
  return host.inbox.snapshot(sinceSeq);
}

export function recordCi(host: Host, sessionId: string, sessionTitle: string, ci: NonNullable<InboxEvent['ci']>): void {
  host.pushInbox(host.inbox.recordCi(sessionId, sessionTitle, ci));
}
