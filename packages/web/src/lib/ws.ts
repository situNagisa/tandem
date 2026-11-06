import type { ClientMsg, SeqServerMsg, ServerMsg } from '@tandem/protocol'
import type { ConnectionState, HostConfig } from './types'
import { websocketUrl } from './hostUrl'
import {
  RELAY_UNSUPPORTED_MESSAGE,
  detectRelayCryptoSupport,
  isRelayHost,
  relayChannel,
  relayErrorMessage,
} from './relay'

interface Handlers {
  onStatus: (state: ConnectionState, error?: string) => void
  onMessage: (msg: ServerMsg) => void
}

/** WebSocket 与 E2EWebSocket 的最小公共接口。 */
interface HostSocket {
  readyState: number
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** 超过这个时间没有任何服务端消息，认为连接已半死（后台挂起、网络切换）。 */
const STALE_AFTER = 45_000

const MAX_DELAY = 30_000

/**
 * 单个 Host 的长连接。
 * - 指数退避重连（0.5s → 30s，带抖动）
 * - 断线重连成功后自动重新 subscribe
 * - 通过 ping/pong 保活
 */
export class HostConnection {
  private host: HostConfig
  private handlers: Handlers
  private ws: HostSocket | null = null
  private closed = false
  private retry = 0
  private retryTimer: number | undefined
  private pingTimer: number | undefined
  private subscriptions = new Set<string>()
  private lastStatus: ConnectionState = 'offline'
  /** 每会话已应用到的最后 seq，重连时作为 sinceSeq 请求补发。 */
  private lastSeq = new Map<string, number>()
  /** 等待前序 seq 的事件，保证按序应用。 */
  private pending = new Map<string, Map<number, ServerMsg>>()
  private lastActivity = 0

  constructor(host: HostConfig, handlers: Handlers) {
    this.host = host
    this.handlers = handlers
  }

  updateHost(host: HostConfig): void {
    this.host = host
    this.reconnectNow()
  }

  private generation = 0

  connect(): void {
    if (this.closed) return
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === 0)) {
      return
    }
    this.clearRetry()
    this.setStatus('connecting')
    const gen = ++this.generation

    const attach = (ws: HostSocket) => {
      if (gen !== this.generation || this.closed) {
        try {
          ws.close()
        } catch {
          /* 忽略 */
        }
        return
      }
      this.ws = ws

      ws.onopen = () => {
        if (this.ws !== ws) return
        this.lastActivity = Date.now()
        this.setStatus('online')
        for (const sessionId of this.subscriptions) {
          const sinceSeq = this.lastSeq.get(sessionId)
          this.rawSend({
            type: 'subscribe',
            sessionId,
            ...(sinceSeq !== undefined ? { sinceSeq } : {}),
          })
        }
        this.startPing()
      }

      ws.onmessage = (ev) => {
        if (this.ws !== ws) return
        if (typeof ev.data !== 'string') return
        let msg: ServerMsg
        try {
          msg = JSON.parse(ev.data) as ServerMsg
        } catch {
          return
        }
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return
        this.retry = 0
        this.lastActivity = Date.now()
        if (msg.type === 'pong') return
        this.deliver(msg)
      }

      ws.onerror = () => {
        // 具体原因由 close 事件处理
      }

      ws.onclose = (ev) => {
        if (this.ws !== ws) return
        this.ws = null
        this.pending.clear()
        this.stopPing()
        if (this.closed) return
        const reason = isRelayHost(this.host) && ev?.reason ? relayErrorMessage(ev.reason) : undefined
        this.scheduleReconnect(reason)
      }
    }

    if (isRelayHost(this.host)) {
      void detectRelayCryptoSupport().then((ok) => {
        if (gen !== this.generation || this.closed) return
        if (!ok) {
          this.scheduleReconnect(RELAY_UNSUPPORTED_MESSAGE)
          return
        }
        try {
          const socket = relayChannel(this.host).openWebSocket(
            `/ws?token=${encodeURIComponent(this.host.token)}`,
          )
          attach(socket as unknown as HostSocket)
        } catch (err) {
          this.scheduleReconnect(relayErrorMessage(err))
        }
      })
      return
    }

    try {
      attach(new WebSocket(websocketUrl(this.host.url, this.host.token)) as unknown as HostSocket)
    } catch {
      this.scheduleReconnect('Host 地址无效')
    }
  }

  send(msg: ClientMsg): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }

  subscribe(sessionId: string): void {
    this.subscriptions.add(sessionId)
    // 显式订阅（打开/重新加载会话）要全量快照，不能沿用上一轮的 seq。
    this.lastSeq.delete(sessionId)
    this.pending.delete(sessionId)
    this.send({ type: 'subscribe', sessionId })
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId)
    this.pending.delete(sessionId)
    this.send({ type: 'unsubscribe', sessionId })
  }

  /**
   * 从后台恢复或网络恢复时调用：连接已不在就立即重连；
   * 长时间没收到任何消息则视为半死连接，同样重建。
   */
  checkAlive(): void {
    if (this.closed) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.reconnectNow()
      return
    }
    if (Date.now() - this.lastActivity > STALE_AFTER) {
      this.reconnectNow()
      return
    }
    this.rawSend({ type: 'ping' })
  }

  /** 浏览器报告断网：停止重试并立即显示离线，等 online 事件再重建。 */
  markOffline(): void {
    if (this.closed) return
    this.clearRetry()
    this.stopPing()
    const old = this.ws
    this.ws = null
    if (old) {
      try {
        old.close()
      } catch {
        /* 忽略 */
      }
    }
    this.setStatus('offline')
  }

  /** 立即重连（用户点“重试”或网络恢复时）。 */
  reconnectNow(): void {
    if (this.closed) return
    this.retry = 0
    this.clearRetry()
    if (this.ws) {
      const old = this.ws
      this.ws = null
      try {
        old.close()
      } catch {
        /* 忽略 */
      }
      this.stopPing()
    }
    this.connect()
  }

  close(): void {
    this.closed = true
    this.clearRetry()
    this.stopPing()
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close()
      } catch {
        /* 忽略 */
      }
    }
  }

  get status(): ConnectionState {
    return this.lastStatus
  }

  /**
   * 按会话 seq 顺序投递事件：重复的忽略，乱序的暂存，前序到达后再依次应用。
   * 快照携带当前 seq，直接整体替换并抹平等待队列。
   */
  private deliver(msg: SeqServerMsg): void {
    if (msg.type === 'session_snapshot') {
      const sid = msg.session.id
      if (typeof msg.seq === 'number') this.lastSeq.set(sid, msg.seq)
      this.pending.delete(sid)
      this.handlers.onMessage(msg)
      return
    }
    const sessionId = 'sessionId' in msg ? msg.sessionId : undefined
    const seq = msg.seq
    if (!sessionId || typeof seq !== 'number') {
      this.handlers.onMessage(msg)
      return
    }
    const last = this.lastSeq.get(sessionId)
    if (last !== undefined && seq <= last) return
    if (last === undefined || seq === last + 1) {
      this.lastSeq.set(sessionId, seq)
      this.handlers.onMessage(msg)
      this.flush(sessionId)
      return
    }
    let queue = this.pending.get(sessionId)
    if (!queue) {
      queue = new Map()
      this.pending.set(sessionId, queue)
    }
    queue.set(seq, msg)
  }

  private flush(sessionId: string): void {
    const queue = this.pending.get(sessionId)
    if (!queue) return
    let last = this.lastSeq.get(sessionId)
    while (last !== undefined && queue.has(last + 1)) {
      const next = queue.get(last + 1)!
      queue.delete(last + 1)
      last += 1
      this.lastSeq.set(sessionId, last)
      this.handlers.onMessage(next)
    }
    if (queue.size === 0) this.pending.delete(sessionId)
  }

  private rawSend(msg: ClientMsg): void {
    try {
      this.ws?.send(JSON.stringify(msg))
    } catch {
      /* 忽略 */
    }
  }

  private setStatus(state: ConnectionState, error?: string): void {
    this.lastStatus = state
    this.handlers.onStatus(state, error)
  }

  private scheduleReconnect(error?: string): void {
    if (this.closed || this.retryTimer !== undefined) return
    const base = Math.min(MAX_DELAY, 500 * 2 ** this.retry)
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    this.retry += 1
    if (error) this.handlers.onStatus('offline', error)
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined
      this.connect()
    }, delay)
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.rawSend({ type: 'ping' })
      }
    }, 25_000)
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) {
      window.clearInterval(this.pingTimer)
      this.pingTimer = undefined
    }
  }
}
