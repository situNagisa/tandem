import type { StoreApi } from 'zustand'
import { api } from '../../lib/api'
import type { UiMessage } from '../../lib/types'
import { connections, newId, toast } from './helpers'
import type { SessionCore } from './sessionCore'
import type { AppState } from './types'

export type MessagesSlice = Pick<
  AppState,
  | 'clearTurnError'
  | 'send'
  | 'interrupt'
  | 'retryNow'
  | 'resumePaused'
  | 'interruptSubagent'
  | 'decidePermission'
>

export function createMessagesSlice(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  core: SessionCore,
): MessagesSlice {
  const { getHost, patchActive, patchSubagent, applySessionSummary, ensureConnection } = core

  return {
    clearTurnError: () => {
      const active = get().active
      if (!active) return
      patchActive(active.hostId, active.sessionId, (a) => ({ ...a, turnError: undefined }))
    },

    send: (blocks) => {
      const active = get().active
      if (!active) return false
      const conn = ensureConnection(active.hostId)
      const ok = conn?.send({ type: 'send', sessionId: active.sessionId, content: blocks }) ?? false
      if (!ok) {
        toast('Host 未连接，消息未发送', 'error')
        return false
      }
      const wasRunning = active.running
      const local: UiMessage = {
        id: `local-${newId()}`,
        role: 'user',
        content: blocks,
        createdAt: Date.now(),
        local: true,
        queued: wasRunning,
      }
      patchActive(active.hostId, active.sessionId, (a) => ({
        ...a,
        messages: [...a.messages, local],
        running: true,
        stopping: false,
        turnError: undefined,
        summary: a.summary ? { ...a.summary, status: 'running', updatedAt: Date.now() } : null,
      }))
      if (active.summary) {
        applySessionSummary(active.hostId, { ...active.summary, status: 'running', updatedAt: Date.now() })
      }
      return true
    },

    interrupt: () => {
      const active = get().active
      if (!active || !active.running) return
      const conn = connections.get(active.hostId) ?? ensureConnection(active.hostId)
      const ok = conn?.send({ type: 'interrupt', sessionId: active.sessionId }) ?? false
      if (!ok) {
        toast('Host 未连接，无法中断', 'error')
        return
      }
      patchActive(active.hostId, active.sessionId, (a) => ({ ...a, stopping: true }))
    },

    retryNow: () => {
      const active = get().active
      if (!active) return
      const conn = connections.get(active.hostId) ?? ensureConnection(active.hostId)
      const ok = conn?.send({ type: 'retry_now', sessionId: active.sessionId }) ?? false
      if (!ok) toast('Host 未连接，无法重试', 'error')
    },

    resumePaused: async () => {
      const active = get().active
      if (!active) return
      const host = getHost(active.hostId)
      if (!host) return
      try {
        const summary = await api.resumeSession(host, active.sessionId)
        applySessionSummary(active.hostId, summary)
        patchActive(active.hostId, active.sessionId, (a) => ({
          ...a,
          summary: a.summary ? { ...a.summary, resumePaused: undefined, status: summary.status } : summary,
          running: true,
        }))
      } catch (err) {
        toast(err instanceof Error ? err.message : '恢复失败', 'error')
      }
    },

    interruptSubagent: (childId) => {
      const active = get().active
      if (!active) return
      const conn = connections.get(active.hostId) ?? ensureConnection(active.hostId)
      const ok = conn?.send({ type: 'interrupt', sessionId: childId }) ?? false
      if (!ok) {
        toast('Host 未连接，无法停止子代理', 'error')
        return
      }
      patchSubagent(active.hostId, childId, (sub) => ({
        ...sub,
        summary: sub.summary ? { ...sub.summary, status: 'running' } : null,
      }))
    },

    decidePermission: (requestId, decision, reason) => {
      const active = get().active
      if (!active) return
      const conn = connections.get(active.hostId) ?? ensureConnection(active.hostId)
      const ok =
        conn?.send({
          type: 'permission',
          requestId,
          decision,
          ...(reason ? { reason } : {}),
        }) ?? false
      if (!ok) {
        toast('Host 未连接，无法提交审批', 'error')
        return
      }
      patchActive(active.hostId, active.sessionId, (a) => {
        const pending = a.pending.filter((p) => p.id !== requestId)
        return {
          ...a,
          pending,
          summary: a.summary
            ? { ...a.summary, status: pending.length ? 'waiting_permission' : 'running' }
            : null,
        }
      })
      const now = get().active
      if (now && now.summary) applySessionSummary(active.hostId, now.summary)
    },
  }
}
