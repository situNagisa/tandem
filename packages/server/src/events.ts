// WebSocket 广播中心：多客户端订阅同一会话，实时同步。
// 每个会话维护单调递增的 seq 与最近若干事件的环形缓冲，供断线客户端补发。
import type { SeqServerMsg, ServerMsg } from '@tandem/protocol';

/** 只依赖 ws 的最小接口，避免和具体实现耦合。 */
export interface WsClient {
  readyState: number;
  send(data: string): void;
}

/** 每会话保留的事件条数（含 block_delta）。 */
export const EVENT_BUFFER_LIMIT = 2000;

export class Hub {
  private clients = new Set<WsClient>();
  private subs = new Map<string, Set<WsClient>>();
  /** 订阅了全局收件箱的连接（跨会话审批/回合结束等摘要）。 */
  private inboxClients = new Set<WsClient>();
  /** 会话事件序号：只增不减。 */
  private seqs = new Map<string, number>();
  /** 会话事件环形缓冲：按 seq 递增排列，最多 EVENT_BUFFER_LIMIT 条。 */
  private buffers = new Map<string, SeqServerMsg[]>();

  add(client: WsClient): void {
    this.clients.add(client);
  }

  remove(client: WsClient): void {
    this.clients.delete(client);
    this.inboxClients.delete(client);
    for (const [sessionId, set] of this.subs) {
      set.delete(client);
      if (set.size === 0) this.subs.delete(sessionId);
    }
  }

  subscribeInbox(client: WsClient): void {
    this.inboxClients.add(client);
  }

  unsubscribeInbox(client: WsClient): void {
    this.inboxClients.delete(client);
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

  /** 当前是否有客户端打开（订阅）该会话，供 PR 轮询按需工作。 */
  hasSubscribers(sessionId: string): boolean {
    return (this.subs.get(sessionId)?.size ?? 0) > 0;
  }

  /** 会话删除后不再向订阅者推送该会话的后续事件。 */
  dropSession(sessionId: string): void {
    this.subs.delete(sessionId);
    this.buffers.delete(sessionId);
    this.seqs.delete(sessionId);
  }

  /** 对话/文件被回退后，旧事件不再适用于新状态：清空缓冲让客户端改用快照。 */
  resetSession(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  /** 会话当前 seq（尚无事件时为 0）。 */
  currentSeq(sessionId: string): number {
    return this.seqs.get(sessionId) ?? 0;
  }

  send(client: WsClient, msg: SeqServerMsg): void {
    if (client.readyState !== 1) return; // WebSocket.OPEN
    try {
      client.send(JSON.stringify(msg));
    } catch {
      // 连接可能已断开，忽略
    }
  }

  /** 分配 seq 并写入该会话的环形缓冲。 */
  private record(sessionId: string, msg: ServerMsg): SeqServerMsg {
    const seq = this.currentSeq(sessionId) + 1;
    this.seqs.set(sessionId, seq);
    const withSeq = { ...msg, seq };
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(sessionId, buffer);
    }
    buffer.push(withSeq);
    if (buffer.length > EVENT_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - EVENT_BUFFER_LIMIT);
    }
    return withSeq;
  }

  /** 广播会话事件：无论有无订阅者都分配 seq 并缓存，便于断线重放。 */
  broadcastSession(sessionId: string, msg: ServerMsg): SeqServerMsg {
    const withSeq = this.record(sessionId, msg);
    const set = this.subs.get(sessionId);
    if (set) {
      for (const client of set) this.send(client, withSeq);
    }
    return withSeq;
  }

  /**
   * 断线重放：返回 seq > sinceSeq 的全部缓存事件。
   * 缓冲无法覆盖（Host 重启、回退清空、或 sinceSeq 超前）时返回 undefined，调用方改发快照。
   */
  replay(sessionId: string, sinceSeq: number): SeqServerMsg[] | undefined {
    if (!Number.isFinite(sinceSeq) || sinceSeq < 0) return undefined;
    const current = this.currentSeq(sessionId);
    if (sinceSeq > current) return undefined;
    if (sinceSeq === current) return [];
    const buffer = this.buffers.get(sessionId) ?? [];
    const first = buffer[0]?.seq;
    // 缓冲为空说明这些事件不在内存里（重启/清空），只能发快照
    if (first === undefined) return undefined;
    // 覆盖条件：缓冲里从 first 起连续，且 sinceSeq+1 落在缓冲范围内
    if (sinceSeq < first - 1) return undefined;
    return buffer.filter((event) => (event.seq ?? 0) > sinceSeq);
  }

  /** 发给所有连接（用于会话列表刷新/删除）。 */
  broadcastAll(msg: ServerMsg): void {
    for (const client of this.clients) this.send(client, msg);
  }

  /** 只发给订阅了收件箱的连接。 */
  broadcastInbox(msg: ServerMsg): void {
    for (const client of this.inboxClients) this.send(client, msg);
  }
}
