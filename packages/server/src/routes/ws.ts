// WebSocket 客户端连接与消息分发：按成员角色限制订阅、发送与审批。
import type { FastifyInstance } from 'fastify';
import type {
  ClientMsg,
  InboxEvent,
  InboxSnapshot,
  PermissionDecision,
  TeamPresence,
} from '@tandem/protocol';
import type { WsClient } from '../events.js';
import type { RouteDeps } from './common.js';
import {
  canApprove,
  canSend,
  identityOf,
  isOwnerLike,
  memberCanSeeSession,
  principalOf,
  type Principal,
} from '../team/access.js';
import { recordAudit } from '../team/audit.js';

function inboxVisible(principal: Principal, event: InboxEvent): boolean {
  if (event.kind === 'permission') {
    if (!canApprove(principal.role)) return false;
    const target = event.permission?.assignedTo;
    if (target && principal.kind === 'member' && target.memberId !== principal.id) return false;
  }
  if (event.kind === 'permission_resolved' && !canApprove(principal.role)) return false;
  if (event.kind === 'budget' || event.kind === 'eval') return isOwnerLike(principal);
  if (!event.sessionId) return isOwnerLike(principal);
  return true;
}

export function registerWsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/ws', { websocket: true }, (socket, req) => {
    const client = socket as unknown as WsClient;
    const principal = principalOf(req);
    host.hub.add(
      client,
      principal.kind === 'member'
        ? {
            id: principal.id,
            name: principal.name,
            role: principal.role,
            projectDirs: principal.projectDirs,
          }
        : undefined,
    );
    const helloHost = host.info();
    host.hub.send(client, {
      type: 'hello',
      host: principal.kind === 'member' ? { ...helloHost, homeDir: '' } : helloHost,
      me: identityOf(principal, host),
    });

    const sendError = (message: string) => host.hub.send(client, { type: 'error', message });
    const subscribed = new Set<string>();

    const presence = (sessionId: string) => {
      const viewers: TeamPresence[] = host.hub.viewers(sessionId);
      host.hub.broadcastEphemeral(sessionId, { type: 'presence', sessionId, viewers });
    };

    const canSee = (sessionId: string): boolean => {
      if (isOwnerLike(principal)) return true;
      return memberCanSeeSession(principal, host.getSession(sessionId));
    };

    const filterInbox = (snapshot: InboxSnapshot): InboxSnapshot => {
      if (isOwnerLike(principal)) return snapshot;
      const keep = (event: InboxEvent) => {
        if (!inboxVisible(principal, event)) return false;
        if (!event.sessionId) return true;
        return memberCanSeeSession(principal, host.getSession(event.sessionId));
      };
      return {
        seq: snapshot.seq,
        events: snapshot.events.filter(keep),
        pending: snapshot.pending.filter(keep),
      };
    };

    socket.on('message', (data: Buffer) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString()) as ClientMsg;
      } catch {
        sendError('无法解析 WebSocket 消息');
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
        sendError('消息格式无效');
        return;
      }
      switch (msg.type) {
        case 'subscribe': {
          if (!canSee(msg.sessionId)) {
            sendError('会话不存在');
            return;
          }
          // tail 由新客户端显式携带；不传时保持旧行为（全量快照）。
          const tail =
            typeof msg.tail === 'number' && Number.isFinite(msg.tail)
              ? Math.max(1, Math.min(Math.floor(msg.tail), 5000))
              : undefined;
          const snapshot = host.snapshot(msg.sessionId, tail);
          if (!snapshot) {
            sendError('会话不存在');
            return;
          }
          host.hub.subscribe(client, msg.sessionId);
          subscribed.add(msg.sessionId);
          const sinceSeq =
            typeof msg.sinceSeq === 'number' && Number.isFinite(msg.sinceSeq)
              ? msg.sinceSeq
              : undefined;
          if (sinceSeq !== undefined) {
            const events = host.hub.replay(msg.sessionId, sinceSeq);
            if (events) {
              // 缓冲覆盖：按序补发，客户端不必再要快照
              for (const event of events) host.hub.send(client, event);
              presence(msg.sessionId);
              break;
            }
            // 缓冲不覆盖（Host 重启 / 已回退）：退回全量快照
          }
          const pendingPermissions = snapshot.pendingPermissions.filter((request) => {
            if (!canApprove(principal.role)) return false;
            if (principal.kind === 'member' && request.assignedTo) {
              return request.assignedTo.memberId === principal.id;
            }
            return true;
          });
          host.hub.send(client, {
            type: 'session_snapshot',
            session: snapshot.session,
            pendingPermissions,
            ...(snapshot.totalMessages !== undefined
              ? {
                  totalMessages: snapshot.totalMessages,
                  ...(snapshot.firstMessageId !== undefined
                    ? { firstMessageId: snapshot.firstMessageId }
                    : {}),
                  truncated: snapshot.truncated === true,
                }
              : {}),
            seq: host.hub.currentSeq(msg.sessionId),
          });
          presence(msg.sessionId);
          break;
        }
        case 'unsubscribe':
          host.hub.unsubscribe(client, msg.sessionId);
          subscribed.delete(msg.sessionId);
          presence(msg.sessionId);
          break;
        case 'subscribe_inbox': {
          host.hub.subscribeInbox(client);
          const sinceSeq =
            typeof msg.sinceSeq === 'number' && Number.isFinite(msg.sinceSeq)
              ? msg.sinceSeq
              : undefined;
          host.hub.send(client, {
            type: 'inbox_snapshot',
            snapshot: filterInbox(host.inboxSnapshot(sinceSeq)),
          });
          break;
        }
        case 'unsubscribe_inbox':
          host.hub.unsubscribeInbox(client);
          break;
        case 'send': {
          if (!canSend(principal.role)) {
            sendError('没有发送消息的权限');
            return;
          }
          if (!canSee(msg.sessionId)) {
            sendError('会话不存在');
            return;
          }
          const rec = host.getSession(msg.sessionId);
          void host
            .send(msg.sessionId, msg.content)
            .then(() => {
              recordAudit(host, principal, 'message.send', {
                sessionId: msg.sessionId,
                ...(rec ? { sessionTitle: rec.title } : {}),
              });
            })
            .catch((err: Error) => sendError(err.message));
          break;
        }
        case 'interrupt': {
          if (!canSend(principal.role) || !canSee(msg.sessionId)) {
            sendError('没有中断该会话的权限');
            return;
          }
          host.interrupt(msg.sessionId);
          break;
        }
        case 'retry_now': {
          if (!canSend(principal.role) || !canSee(msg.sessionId)) {
            sendError('没有重试该会话的权限');
            return;
          }
          host.retryNow(msg.sessionId);
          break;
        }
        case 'permission': {
          if (!canApprove(principal.role)) {
            sendError('没有审批权限');
            return;
          }
          const found = host.findPendingPermission(msg.requestId);
          if (!found) {
            sendError('审批不存在或已处理');
            return;
          }
          if (!canSee(found.rec.id)) {
            sendError('会话不存在');
            return;
          }
          const target = found.request.assignedTo;
          if (target && principal.kind === 'member' && target.memberId !== principal.id) {
            sendError('该审批已转交给其他成员');
            return;
          }
          const decision = msg.decision as PermissionDecision;
          recordAudit(host, principal, 'permission.decide', {
            sessionId: found.rec.id,
            sessionTitle: found.rec.title,
            detail: `${found.request.toolName} ${decision}`,
          });
          host.resolvePermission(
            msg.requestId,
            decision,
            typeof msg.reason === 'string' ? msg.reason : undefined,
          );
          break;
        }
        case 'ping':
          host.hub.send(client, { type: 'pong' });
          break;
        default:
          sendError('未知消息类型');
          break;
      }
    });

    socket.on('close', () => {
      host.hub.remove(client);
      for (const sessionId of subscribed) presence(sessionId);
    });
    socket.on('error', () => {
      host.hub.remove(client);
      for (const sessionId of subscribed) presence(sessionId);
    });
  });
}
