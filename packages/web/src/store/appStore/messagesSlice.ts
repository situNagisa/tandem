import type { StoreApi } from 'zustand'
import { api } from '../../lib/api'
import { permissionTarget } from '../../lib/permissionLabel'
import type { SessionTarget, UiMessage } from '../../lib/types'
import { isDraftSession } from '../../lib/draftSession'
import { connections, newId, toast, viewKeyOf } from './helpers'
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
  const { getHost, patchView, patchSubagent, applySessionSummary, ensureConnection } = core

  const viewOf = (target?: SessionTarget | null) => {
    if (target) return get().sessionViews[viewKeyOf(target.hostId, target.sessionId)] ?? null
    return get().active
  }

  return {
    clearTurnError: (target) => {
      const view = viewOf(target)
      if (!view) return
      patchView(view.hostId, view.sessionId, (a) => ({ ...a, turnError: undefined }))
    },

    send: (blocks, target, routeMode) => {
      const view = viewOf(target)
      if (!view) return false
      if (isDraftSession(view.sessionId)) {
        toast('会话正在创建，请稍候', 'info')
        return false
      }
      const conn = ensureConnection(view.hostId)
      const ok =
        conn?.send({
          type: 'send',
          sessionId: view.sessionId,
          content: blocks,
          ...(routeMode ? { routeMode } : {}),
        }) ?? false
      if (!ok) {
        toast('Host 未连接，消息未发送', 'error')
        return false
      }
      const wasRunning = view.running
      const local: UiMessage = {
        id: `local-${newId()}`,
        role: 'user',
        content: blocks,
        createdAt: Date.now(),
        local: true,
        queued: wasRunning,
      }
      patchView(view.hostId, view.sessionId, (a) => ({
        ...a,
        messages: [...a.messages, local],
        running: true,
        stopping: false,
        turnError: undefined,
        summary: a.summary ? { ...a.summary, status: 'running', updatedAt: Date.now() } : null,
      }))
      if (view.summary) {
        applySessionSummary(view.hostId, {
          ...view.summary,
          status: 'running',
          updatedAt: Date.now(),
        })
      }
      return true
    },

    interrupt: (target) => {
      const view = viewOf(target)
      if (!view || !view.running || isDraftSession(view.sessionId)) return
      const conn = connections.get(view.hostId) ?? ensureConnection(view.hostId)
      const ok = conn?.send({ type: 'interrupt', sessionId: view.sessionId }) ?? false
      if (!ok) {
        toast('Host 未连接，无法中断', 'error')
        return
      }
      patchView(view.hostId, view.sessionId, (a) => ({ ...a, stopping: true }))
    },

    retryNow: (target) => {
      const view = viewOf(target)
      if (!view) return
      const conn = connections.get(view.hostId) ?? ensureConnection(view.hostId)
      const ok = conn?.send({ type: 'retry_now', sessionId: view.sessionId }) ?? false
      if (!ok) toast('Host 未连接，无法重试', 'error')
    },

    resumePaused: async (target) => {
      const view = viewOf(target)
      if (!view) return
      const host = getHost(view.hostId)
      if (!host) return
      try {
        const summary = await api.resumeSession(host, view.sessionId)
        applySessionSummary(view.hostId, summary)
        patchView(view.hostId, view.sessionId, (a) => ({
          ...a,
          summary: a.summary
            ? { ...a.summary, resumePaused: undefined, status: summary.status }
            : summary,
          running: true,
        }))
      } catch (err) {
        toast(err instanceof Error ? err.message : '恢复失败', 'error')
      }
    },

    interruptSubagent: (childId, target) => {
      const view = viewOf(target)
      if (!view) return
      const conn = connections.get(view.hostId) ?? ensureConnection(view.hostId)
      const ok = conn?.send({ type: 'interrupt', sessionId: childId }) ?? false
      if (!ok) {
        toast('Host 未连接，无法停止子代理', 'error')
        return
      }
      patchSubagent(view.hostId, childId, (sub) => ({
        ...sub,
        summary: sub.summary ? { ...sub.summary, status: 'running' } : null,
      }))
    },

    decidePermission: (requestId, decision, reason, target) => {
      const view = viewOf(target)
      if (!view) return
      const conn = connections.get(view.hostId) ?? ensureConnection(view.hostId)
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
      const decided = view.pending.find((item) => item.id === requestId)
      patchView(view.hostId, view.sessionId, (a) => {
        const pending = a.pending.filter((p) => p.id !== requestId)
        // 反馈14#07：审批完成后在对话流原位留一行结果（已允许 · 命令 / 已拒绝）。
        const trail = decided
          ? [
              ...(a.permissionTrail ?? []).slice(-49),
              {
                id: decided.id,
                toolUseId: decided.toolUseId,
                label: permissionTarget(decided).target,
                decision,
                at: Date.now(),
              },
            ]
          : a.permissionTrail
        return {
          ...a,
          pending,
          permissionTrail: trail,
          summary: a.summary
            ? { ...a.summary, status: pending.length ? 'waiting_permission' : 'running' }
            : null,
        }
      })
      const now = get().sessionViews[viewKeyOf(view.hostId, view.sessionId)]
      if (now?.summary) applySessionSummary(view.hostId, now.summary)
    },
  }
}
