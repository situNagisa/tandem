// WebSocket 客户端连接与消息分发。
import type { FastifyInstance } from 'fastify';
import type { ClientMsg, PermissionDecision } from '@tandem/protocol';
import type { WsClient } from '../events.js';
import type { RouteDeps } from './common.js';

export function registerWsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { host } = deps;

  app.get('/ws', { websocket: true }, (socket, _req) => {
    const client = socket as unknown as WsClient;
    host.hub.add(client);
    host.hub.send(client, { type: 'hello', host: host.info() });

    const sendError = (message: string) => host.hub.send(client, { type: 'error', message });

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
          const snapshot = host.snapshot(msg.sessionId);
          if (!snapshot) {
            sendError('会话不存在');
            return;
          }
          host.hub.subscribe(client, msg.sessionId);
          const sinceSeq =
            typeof msg.sinceSeq === 'number' && Number.isFinite(msg.sinceSeq)
              ? msg.sinceSeq
              : undefined;
          if (sinceSeq !== undefined) {
            const events = host.hub.replay(msg.sessionId, sinceSeq);
            if (events) {
              // 缓冲覆盖：按序补发，客户端不必再要快照
              for (const event of events) host.hub.send(client, event);
              break;
            }
            // 缓冲不覆盖（Host 重启 / 已回退）：退回全量快照
          }
          host.hub.send(client, {
            type: 'session_snapshot',
            session: snapshot.session,
            pendingPermissions: snapshot.pendingPermissions,
            seq: host.hub.currentSeq(msg.sessionId),
          });
          break;
        }
        case 'unsubscribe':
          host.hub.unsubscribe(client, msg.sessionId);
          break;
        case 'subscribe_inbox': {
          host.hub.subscribeInbox(client);
          const sinceSeq =
            typeof msg.sinceSeq === 'number' && Number.isFinite(msg.sinceSeq)
              ? msg.sinceSeq
              : undefined;
          host.hub.send(client, {
            type: 'inbox_snapshot',
            snapshot: host.inboxSnapshot(sinceSeq),
          });
          break;
        }
        case 'unsubscribe_inbox':
          host.hub.unsubscribeInbox(client);
          break;
        case 'send':
          void host.send(msg.sessionId, msg.content).catch((err: Error) => sendError(err.message));
          break;
        case 'interrupt':
          host.interrupt(msg.sessionId);
          break;
        case 'retry_now':
          host.retryNow(msg.sessionId);
          break;
        case 'permission':
          host.resolvePermission(
            msg.requestId,
            msg.decision as PermissionDecision,
            typeof msg.reason === 'string' ? msg.reason : undefined,
          );
          break;
        case 'ping':
          host.hub.send(client, { type: 'pong' });
          break;
        default:
          sendError('未知消息类型');
          break;
      }
    });

    socket.on('close', () => host.hub.remove(client));
    socket.on('error', () => host.hub.remove(client));
  });
}
