import type { ClientMsg, ServerMsg } from '@tandem/protocol'
import type { ConnectionState, HostConfig } from './types'
import { websocketUrl } from './hostUrl'

interface Handlers {
  onStatus: (state: ConnectionState, error?: string) => void
  onMessage: (msg: ServerMsg) => void
}

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
  private ws: WebSocket | null = null
  private closed = false
  private retry = 0
  private retryTimer: number | undefined
  private pingTimer: number | undefined
  private subscriptions = new Set<string>()
  private lastStatus: ConnectionState = 'offline'

  constructor(host: HostConfig, handlers: Handlers) {
    this.host = host
    this.handlers = handlers
  }

  updateHost(host: HostConfig): void {
    this.host = host
    this.reconnectNow()
  }

  connect(): void {
    if (this.closed) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.clearRetry()
    this.setStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(websocketUrl(this.host.url, this.host.token))
    } catch {
      this.scheduleReconnect('Host 地址无效')
      return
    }
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.setStatus('online')
      for (const sessionId of this.subscriptions) {
        this.rawSend({ type: 'subscribe', sessionId })
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
      if (msg.type === 'pong') return
      this.handlers.onMessage(msg)
    }

    ws.onerror = () => {
      // 具体原因由 close 事件处理
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.stopPing()
      if (this.closed) return
      this.setStatus('offline')
      this.scheduleReconnect()
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
    this.send({ type: 'subscribe', sessionId })
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId)
    this.send({ type: 'unsubscribe', sessionId })
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
