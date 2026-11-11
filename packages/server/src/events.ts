// WebSocket 广播中心：多客户端订阅同一会话，实时同步。
// 每个会话维护单调递增的 seq 与最近若干事件的环形缓冲，供断线客户端补发。
import type { SeqServerMsg, ServerMsg, TeamPresence } from '@tandem/protocol';

/** 只依赖 ws 的最小接口，避免和具体实现耦合。 */
export interface WsClient {
  readyState: number;
  send(data: string): void;
  close?(): void;
}

/** 已鉴权的连接身份；缺省表示所有者（全权限）。 */
export interface WsAccess {
  id: string;
  name: string;
  role: 'owner' | 'observer' | 'approver' | 'collaborator';
  projectDirs: string[];
}

function canApprove(role: WsAccess['role']): boolean {
  return role === 'owner' || role === 'approver' || role === 'collaborator';
}

/** 每会话保留的事件条数（含 block_delta）。 */
export const EVENT_BUFFER_LIMIT = 2000;

export class Hub {
  private clients = new Set<WsClient>();
  /** 连接身份（所有者不登记）。 */
  private access = new Map<WsClient, WsAccess>();
  /** 会话可见性回调（由 Host 注册，用于过滤跨连接广播）。 */
  private canViewSession?: (access: WsAccess, sessionId: string) => boolean;
  private subs = new Map<string, Set<WsClient>>();
  /** 订阅了全局收件箱的连接（跨会话审批/回合结束等摘要）。 */
  private inboxClients = new Set<WsClient>();
  /** 会话事件序号：只增不减。 */
  private seqs = new Map<string, number>();
  /** 会话事件环形缓冲：按 seq 递增排列，最多 EVENT_BUFFER_LIMIT 条。 */
  private buffers = new Map<string, SeqServerMsg[]>();

  add(client: WsClient, access?: WsAccess): void {
    this.clients.add(client);
    if (access) this.access.set(client, access);
  }

  setSessionVisibility(fn: (access: WsAccess, sessionId: string) => boolean): void {
    this.canViewSession = fn;
  }

  /** 吊销成员后断开其现有长连接。 */
  disconnectMember(memberId: string): void {
    for (const [client, access] of this.access) {
      if (access.id !== memberId) continue;
      try {
        client.close?.();
      } catch {
        // 忽略已断开的连接
      }
      this.remove(client);
    }
  }

  /** 当前订阅该会话的连接（含所有者），用于会话页顶部在线头像。 */
  viewers(sessionId: string): TeamPresence[] {
    const set = this.subs.get(sessionId);
    if (!set) return [];
    const seen = new Set<string>();
    const list: TeamPresence[] = [];
    for (const client of set) {
      const access = this.access.get(client);
      const entry: TeamPresence = access
        ? { id: access.id, name: access.name, role: access.role }
        : { id: 'owner', name: '所有者', role: 'owner' };
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      list.push(entry);
    }
    return list;
  }

  /** 无需 seq 的临时事件（在线状态）。 */
  broadcastEphemeral(sessionId: string, msg: ServerMsg): void {
    const set = this.subs.get(sessionId);
    if (!set) return;
    for (const client of set) this.send(client, msg);
  }

  remove(client: WsClient): void {
    this.clients.delete(client);
    this.access.delete(client);
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

  /** 非所有者连接只收到自己可见的会话与有权限的审批事件。 */
  private canDeliver(client: WsClient, msg: SeqServerMsg): boolean {
    const access = this.access.get(client);
    if (!access) return true;
    const visible = (sessionId?: string) =>
      !!sessionId && (this.canViewSession ? this.canViewSession(access, sessionId) : true);
    switch (msg.type) {
      case 'session_updated':
      case 'session_deleted':
        return msg.type === 'session_deleted' || visible(msg.session.id);
      case 'permission_request':
        return canApprove(access.role) && visible(msg.request.sessionId);
      case 'permission_resolved':
        return canApprove(access.role) && visible(msg.sessionId);
      case 'inbox_event': {
        const event = msg.event;
        if (event.kind === 'permission') {
          if (!canApprove(access.role)) return false;
          return !event.sessionId || visible(event.sessionId);
        }
        if (event.kind === 'permission_resolved') {
          return canApprove(access.role) && (!event.sessionId || visible(event.sessionId));
        }
        // 预算/评测是 Host 级信息，只发给所有者
        if (event.kind === 'budget' || event.kind === 'eval') return false;
        if (!event.sessionId) return false;
        return visible(event.sessionId);
      }
      default:
        return true;
    }
  }

  send(client: WsClient, msg: SeqServerMsg): void {
    if (!this.canDeliver(client, msg)) return;
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
