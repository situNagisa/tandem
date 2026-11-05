// WebSocket 广播中心：多客户端订阅同一会话，实时同步。
import type { ServerMsg } from '@tandem/protocol';

/** 只依赖 ws 的最小接口，避免和具体实现耦合。 */
export interface WsClient {
  readyState: number;
  send(data: string): void;
}

export class Hub {
  private clients = new Set<WsClient>();
  private subs = new Map<string, Set<WsClient>>();

  add(client: WsClient): void {
    this.clients.add(client);
  }

  remove(client: WsClient): void {
    this.clients.delete(client);
    for (const [sessionId, set] of this.subs) {
      set.delete(client);
      if (set.size === 0) this.subs.delete(sessionId);
    }
  }

  subscribe(client: WsClient, sessionId: string): void {
    let set = this.subs.get(sessionId);
    if (!set) {
      set = new Set();
      this.subs.set(sessionId, set);
    }
    set.add(client);
  }

  unsubscribe(client: WsClient, sessionId: string): void {
    const set = this.subs.get(sessionId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) this.subs.delete(sessionId);
  }

  /** 会话删除后不再向订阅者推送该会话的后续事件。 */
  dropSession(sessionId: string): void {
    this.subs.delete(sessionId);
  }

  send(client: WsClient, msg: ServerMsg): void {
    if (client.readyState !== 1) return; // WebSocket.OPEN
    try {
      client.send(JSON.stringify(msg));
    } catch {
      // 连接可能已断开，忽略
    }
  }

  /** 只发给某会话的订阅者。 */
  broadcastSession(sessionId: string, msg: ServerMsg): void {
    const set = this.subs.get(sessionId);
    if (!set) return;
    for (const client of set) this.send(client, msg);
  }

  /** 发给所有连接（用于会话列表刷新/删除）。 */
  broadcastAll(msg: ServerMsg): void {
    for (const client of this.clients) this.send(client, msg);
  }
}
