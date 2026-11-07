import type { StoreApi } from 'zustand'
import { cancelPermissionNotification } from '../../lib/attention'
import { connections, toast } from './helpers'
import type { SessionCore } from './sessionCore'
import type { AppState } from './types'

export type InboxSlice = Pick<AppState, 'decideInboxPermission' | 'markInboxSeen'>

export function createInboxSlice(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  core: SessionCore,
): InboxSlice {
  const { ensureConnection } = core

  return {
    decideInboxPermission: (hostId, requestId, decision, reason) => {
      const conn = connections.get(hostId) ?? ensureConnection(hostId)
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
      cancelPermissionNotification(requestId)
      // 乐观从收件箱移除；桌面端的 permission_resolved 会再广播一次校正
      set((state) => {
        const inbox = state.inbox[hostId]
        if (!inbox) return state
        const pending = inbox.pending.filter((item) => item.requestId !== requestId)
        return {
          inbox: {
            ...state.inbox,
            [hostId]: {
              ...inbox,
              pending,
              unread: Math.max(0, inbox.unread - (pending.length < inbox.pending.length ? 1 : 0)),
            },
          },
        }
      })
      set((state) => {
        const active = state.active
        if (!active || active.hostId !== hostId) return state
        const pending = active.pending.filter((p) => p.id !== requestId)
        if (pending.length === active.pending.length) return state
        return {
          active: {
            ...active,
            pending,
            subagents: Object.fromEntries(
              Object.entries(active.subagents).map(([id, sub]) => [
                id,
                { ...sub, pending: sub.pending.filter((p) => p.id !== requestId) },
              ]),
            ),
          },
        }
      })
    },

    markInboxSeen: () => {
      set((state) => {
        const inbox = { ...state.inbox }
        let changed = false
        for (const [hostId, entry] of Object.entries(inbox)) {
          if (entry.unread > 0) {
            inbox[hostId] = { ...entry, unread: 0 }
            changed = true
          }
        }
        return changed ? { inbox } : state
      })
    },
  }
}
