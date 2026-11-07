import type { ServerMsg } from '@tandem/protocol'
import type { StoreApi } from 'zustand'
import { navigate, parseHash } from '../../lib/router'
import {
  cancelPermissionNotification,
  notifyBudget,
  notifyPermission,
  notifyTurnEnd,
} from '../../lib/attention'
import type { HookNotice, UiMessage } from '../../lib/types'
import { useUiStore } from '../useUiStore'
import { useTaskStore } from '../useTaskStore'
import { useScheduleStore } from '../useScheduleStore'
import { useBrowserStore } from '../useBrowserStore'
import { useVcsStore } from '../../lib/useVcs'
import { childSubscriptions, collectToolResults, connections, toast } from './helpers'
import type { SessionCore } from './sessionCore'
import type { AppState } from './types'

/** 处理 Host 推送的 WS 消息，写入 active / runtimes / inbox 等状态。 */
export function createServerMessageHandler(
  set: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState'],
  core: SessionCore,
): (hostId: string, msg: ServerMsg) => void {
  const {
    getHost,
    patchRuntime,
    patchActive,
    patchSubagent,
    applySubagentSnapshot,
    applySessionSummary,
    activeSummaryForSession,
    removeSummary,
    applySnapshot,
  } = core

  return function handleServerMessage(hostId: string, msg: ServerMsg): void {
    const rt = get().runtimes[hostId]
    if (!rt) return
    switch (msg.type) {
      case 'hello': {
        patchRuntime(hostId, { info: msg.host, status: 'online', error: undefined })
        void get().refreshProfiles(hostId)
        void get().refreshSessions(hostId)
        void get().refreshExternalSessions(hostId)
        break
      }
      case 'session_snapshot': {
        const snapshotActive = get().active
        if (
          snapshotActive &&
          msg.session.id !== snapshotActive.sessionId &&
          msg.session.parentId
        ) {
          applySubagentSnapshot(hostId, msg.session, msg.pendingPermissions)
        } else {
          applySnapshot(hostId, msg.session, msg.pendingPermissions)
        }
        break
      }
      case 'session_updated': {
        applySessionSummary(hostId, msg.session)
        break
      }
      case 'injections': {
        const now = get().active
        if (!now || now.hostId !== hostId || now.sessionId !== msg.sessionId) break
        set({ active: { ...now, injections: msg.injections } })
        break
      }
      case 'browser_state': {
        useBrowserStore.getState().apply(msg.state)
        break
      }
      case 'inbox_snapshot': {
        const snapshot = msg.snapshot
        set((state) => ({
          inbox: {
            ...state.inbox,
            [hostId]: {
              seq: snapshot.seq,
              events: snapshot.events,
              pending: snapshot.pending,
              unread: snapshot.pending.length,
            },
          },
        }))
        break
      }
      case 'inbox_event': {
        const event = msg.event
        const ui = useUiStore.getState()
        set((state) => {
          const prev = state.inbox[hostId]
          const events = prev
            ? [...prev.events.filter((item) => item.seq !== event.seq), event].slice(-400)
            : [event]
          let pending = prev?.pending ?? []
          if (event.kind === 'permission' && event.permission) {
            pending = pending.some((item) => item.requestId === event.requestId)
              ? pending
              : [...pending, event]
          } else if (event.kind === 'permission_resolved') {
            pending = pending.filter((item) => item.requestId !== event.requestId)
          }
          const counts =
            event.kind === 'permission' ||
            event.kind === 'turn_end' ||
            event.kind === 'budget' ||
            event.kind === 'ci'
          return {
            inbox: {
              ...state.inbox,
              [hostId]: {
                seq: Math.max(prev?.seq ?? 0, event.seq),
                events,
                pending,
                unread: (prev?.unread ?? 0) + (counts && !ui.inboxOpen ? 1 : 0),
              },
            },
          }
        })
        if (event.kind === 'permission' && event.permission) {
          const summary = get().runtimes[hostId]?.sessions.find(
            (s) => s.id === event.sessionId,
          )
          if (ui.notifyEvents.permission) {
            notifyPermission({
              hostId,
              sessionId: event.sessionId ?? '',
              sessionTitle: event.sessionTitle ?? summary?.title ?? '未命名会话',
              hostName: getHost(hostId)?.name ?? 'Host',
              requestId: event.requestId ?? event.permission.id,
              description: event.plan
                ? '提交了计划，等待批准'
                : event.permission.description || event.permission.toolName,
            })
          }
        } else if (event.kind === 'permission_resolved' && event.requestId) {
          cancelPermissionNotification(event.requestId)
        } else if (event.kind === 'turn_end') {
          const isError = event.turnReason === 'error'
          if (isError ? ui.notifyEvents.error : ui.notifyEvents.turnEnd) {
            notifyTurnEnd({
              hostId,
              sessionId: event.sessionId ?? '',
              sessionTitle: event.sessionTitle ?? '未命名会话',
              hostName: getHost(hostId)?.name ?? 'Host',
              reason: event.turnReason ?? 'done',
              ...(event.error ? { error: event.error } : {}),
            })
          }
        } else if (event.kind === 'budget' && event.budget && event.budgetText) {
          if (ui.notifyEvents.budget) {
            notifyBudget({
              hostId,
              hostName: getHost(hostId)?.name ?? 'Host',
              text: event.budgetText,
              level: event.budget.level,
              ruleId: event.budget.ruleId,
            })
          }
        }
        break
      }
      case 'external_sessions_changed': {
        void get().refreshExternalSessions(hostId, true)
        break
      }
      case 'task_updated': {
        useTaskStore
          .getState()
          .applyEvent(hostId, msg.task, msg.content, msg.since, msg.truncated)
        break
      }
      case 'schedules_updated': {
        const host = getHost(hostId)
        if (host) void useScheduleStore.getState().refresh(host)
        break
      }
      case 'vcs_updated': {
        useVcsStore.getState().apply(hostId, msg.sessionId, msg.state)
        break
      }
      case 'session_deleted': {
        const active = get().active
        removeSummary(hostId, msg.sessionId)
        if (active?.hostId === hostId && active.subagents[msg.sessionId]) {
          childSubscriptions.get(hostId)?.delete(msg.sessionId)
          const subagents = { ...active.subagents }
          delete subagents[msg.sessionId]
          set({ active: { ...active, subagents } })
        }
        if (active && active.hostId === hostId && active.sessionId === msg.sessionId) {
          connections.get(hostId)?.unsubscribe(msg.sessionId)
          set({ active: null })
          navigate({ kind: 'host', hostId })
          toast('会话已被删除', 'info')
        }
        break
      }
      case 'message_start': {
        const startActive = get().active
        if (startActive?.hostId === hostId && startActive.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => {
            const message = msg.message
            const messages = sub.messages.some((m) => m.id === message.id)
              ? sub.messages.map((m) => (m.id === message.id ? message : m))
              : [...sub.messages, message]
            return {
              ...sub,
              messages,
              loading: false,
              running: message.role === 'assistant' ? true : sub.running,
              streamingMessageId:
                message.role === 'assistant' ? message.id : sub.streamingMessageId,
              toolResults:
                message.role === 'user'
                  ? collectToolResults([message], sub.toolResults)
                  : sub.toolResults,
            }
          })
          break
        }
        patchActive(hostId, msg.sessionId, (active) => {
          const message = msg.message
          let messages = active.messages
          const exists = messages.some((m) => m.id === message.id)
          if (exists) {
            messages = messages.map((m) => (m.id === message.id ? message : m))
          } else {
            if (message.role === 'user') {
              const firstLocal = messages.findIndex((m) => m.local)
              if (firstLocal >= 0) {
                messages = messages.filter((_, i) => i !== firstLocal)
              }
            }
            messages = [...messages, message]
          }
          const toolResults =
            message.role === 'user' ? collectToolResults([message], active.toolResults) : active.toolResults
          return {
            ...active,
            messages,
            toolResults,
            running: message.role === 'assistant' ? true : active.running,
            streamingMessageId: message.role === 'assistant' ? message.id : active.streamingMessageId,
            turnError: message.role === 'assistant' ? undefined : active.turnError,
            error: undefined,
          }
        })
        break
      }
      case 'block_delta': {
        const delta = msg.delta
        const deltaActive = get().active
        if (deltaActive?.hostId === hostId && deltaActive.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => {
            if (delta.kind === 'tool_input') {
              const key = `${msg.messageId}:${msg.index}`
              return {
                ...sub,
                liveToolInputs: {
                  ...sub.liveToolInputs,
                  [key]: (sub.liveToolInputs[key] ?? '') + delta.partialJson,
                },
              }
            }
            const messages = sub.messages.map((m) => {
              if (m.id !== msg.messageId) return m
              const content = m.content.slice()
              while (content.length < msg.index) content.push({ type: 'text', text: '' })
              if (delta.kind === 'block_start') content[msg.index] = delta.block
              else {
                const block = content[msg.index]
                if (block && (block.type === 'text' || block.type === 'thinking')) {
                  content[msg.index] = { ...block, text: block.text + delta.text }
                } else {
                  content[msg.index] = { type: 'text', text: delta.text }
                }
              }
              return { ...m, content }
            })
            return { ...sub, messages, running: true }
          })
          break
        }
        patchActive(hostId, msg.sessionId, (active) => {
          if (delta.kind === 'tool_input') {
            const key = `${msg.messageId}:${msg.index}`
            return {
              ...active,
              liveToolInputs: {
                ...active.liveToolInputs,
                [key]: (active.liveToolInputs[key] ?? '') + delta.partialJson,
              },
            }
          }
          const messages = active.messages.map((m) => {
            if (m.id !== msg.messageId) return m
            const content = m.content.slice()
            while (content.length < msg.index) content.push({ type: 'text', text: '' })
            if (delta.kind === 'block_start') {
              content[msg.index] = delta.block
            } else {
              const block = content[msg.index]
              if (block && (block.type === 'text' || block.type === 'thinking')) {
                content[msg.index] = { ...block, text: block.text + delta.text }
              } else {
                content[msg.index] = { type: 'text', text: delta.text }
              }
            }
            return { ...m, content }
          })
          return { ...active, messages, running: true }
        })
        break
      }
      case 'message_end': {
        const endActive = get().active
        if (endActive?.hostId === hostId && endActive.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => {
            const message = msg.message
            const messages = sub.messages.some((m) => m.id === message.id)
              ? sub.messages.map((m) => (m.id === message.id ? message : m))
              : [...sub.messages, message]
            const prefix = `${message.id}:`
            return {
              ...sub,
              messages,
              liveToolInputs: Object.fromEntries(
                Object.entries(sub.liveToolInputs).filter(([k]) => !k.startsWith(prefix)),
              ),
              toolResults: collectToolResults([message], sub.toolResults),
              streamingMessageId:
                sub.streamingMessageId === message.id ? undefined : sub.streamingMessageId,
            }
          })
          break
        }
        patchActive(hostId, msg.sessionId, (active) => {
          const message = msg.message
          let messages: UiMessage[]
          if (active.messages.some((m) => m.id === message.id)) {
            messages = active.messages.map((m) => (m.id === message.id ? message : m))
          } else {
            messages = [...active.messages, message]
          }
          const prefix = `${message.id}:`
          const liveToolInputs = Object.fromEntries(
            Object.entries(active.liveToolInputs).filter(([k]) => !k.startsWith(prefix)),
          )
          return {
            ...active,
            messages,
            liveToolInputs,
            toolResults: collectToolResults([message], active.toolResults),
            streamingMessageId:
              active.streamingMessageId === message.id ? undefined : active.streamingMessageId,
          }
        })
        break
      }
      case 'permission_request': {
        const req = msg.request
        const active = get().active
        if (
          active &&
          active.hostId === hostId &&
          active.subagents[req.sessionId]
        ) {
          patchSubagent(hostId, req.sessionId, (sub) => ({
            ...sub,
            pending: sub.pending.some((p) => p.id === req.id) ? sub.pending : [...sub.pending, req],
            running: true,
          }))
          // 子代理审批冒泡到主会话审批卡
          patchActive(hostId, active.sessionId, (a) => ({
            ...a,
            pending: a.pending.some((p) => p.id === req.id) ? a.pending : [...a.pending, req],
            running: true,
          }))
          const summary = get().runtimes[hostId]?.sessions.find((s) => s.id === req.sessionId)
          if (summary) applySessionSummary(hostId, { ...summary, status: 'waiting_permission' })
        }
        if (active && active.hostId === hostId && active.sessionId === req.sessionId) {
          patchActive(hostId, req.sessionId, (a) => {
            const pending = a.pending.some((p) => p.id === req.id) ? a.pending : [...a.pending, req]
            return { ...a, pending, running: true, stopping: false }
          })
          if (active.summary) {
            applySessionSummary(hostId, { ...active.summary, status: 'waiting_permission' })
          }
        }
        const notifySummary = get().runtimes[hostId]?.sessions.find(
          (s) => s.id === req.sessionId,
        )
        notifyPermission({
          hostId,
          sessionId: req.sessionId,
          sessionTitle: notifySummary?.title ?? '未命名会话',
          hostName: getHost(hostId)?.name ?? 'Host',
          requestId: req.id,
          description: req.description,
        })
        break
      }
      case 'permission_resolved': {
        const active = get().active
        if (!active || active.hostId !== hostId) break
        if (active.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => {
            const pending = sub.pending.filter((p) => p.id !== msg.requestId)
            return {
              ...sub,
              pending,
              running: pending.length > 0 ? true : sub.summary?.status === 'running',
              summary: sub.summary
                ? {
                    ...sub.summary,
                    status: pending.length > 0 ? 'waiting_permission' : 'running',
                  }
                : null,
            }
          })
          patchActive(hostId, active.sessionId, (a) => {
            const pending = a.pending.filter((p) => p.id !== msg.requestId)
            return {
              ...a,
              pending,
              summary: a.summary
                ? { ...a.summary, status: pending.length > 0 ? 'waiting_permission' : 'running' }
                : null,
            }
          })
          break
        }
        patchActive(hostId, msg.sessionId, (a) => {
          const pending = a.pending.filter((p) => p.id !== msg.requestId)
          const status = pending.length === 0 ? 'running' : 'waiting_permission'
          return {
            ...a,
            pending,
            summary: a.summary ? { ...a.summary, status } : null,
          }
        })
        const now = get().active
        if (now && now.hostId === hostId && now.sessionId === msg.sessionId && now.summary) {
          applySessionSummary(hostId, now.summary)
        }
        break
      }
      case 'todos': {
        const todoActive = get().active
        if (todoActive?.hostId === hostId && todoActive.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => ({
            ...sub,
            summary: sub.summary ? { ...sub.summary, updatedAt: Date.now() } : null,
          }))
          break
        }
        patchActive(hostId, msg.sessionId, (a) => ({ ...a, todos: msg.todos }))
        break
      }
      case 'plan': {
        patchActive(hostId, msg.sessionId, (a) => ({ ...a, plan: msg.plan }))
        break
      }
      case 'budget_alert': {
        const profilesNow = get().runtimes[hostId]?.profiles ?? []
        const profile = profilesNow.find((p) => p.id === msg.profileId)
        const group = profile?.groups?.find((g) => g.id === msg.groupId)
        const name =
          group?.name ??
          profile?.name ??
          (msg.scope === 'model' ? (msg.model ?? '模型') : '全局')
        const period = msg.period === 'day' ? '今日' : msg.period === 'week' ? '本周' : '本月'
        const percent =
          msg.limitUsd > 0 ? Math.max(0, Math.round((msg.spentUsd / msg.limitUsd) * 100)) : 100
        const text = `${period} ${name}预算已用 ${percent}%`
        if (msg.level === '100') {
          toast(text, 'error', {
            actionLabel: '查看',
            onClick: () => useUiStore.getState().openSettings('budgets'),
          })
        } else {
          toast(text, 'info')
        }
        break
      }
      case 'hook_event': {
        const hookActive = get().active
        const notice: HookNotice = {
          ...(hookActive && hookActive.sessionId === msg.sessionId
            ? {
                messageId:
                  hookActive.messages[hookActive.messages.length - 1]?.id,
              }
            : {}),
          sessionId: msg.sessionId,
          event: msg.event,
          name: msg.name,
          ok: msg.ok,
          durationMs: msg.durationMs,
          ...(msg.blocked ? { blocked: true } : {}),
          ...(msg.message ? { message: msg.message } : {}),
        }
        if (!notice.ok || notice.blocked) {
          patchActive(hostId, msg.sessionId, (a) => ({
            ...a,
            hookEvents: [...a.hookEvents, notice].slice(-20),
          }))
        }
        break
      }
      case 'turn_end': {
        const turnActive = get().active
        if (turnActive?.hostId === hostId && turnActive.subagents[msg.sessionId]) {
          patchSubagent(hostId, msg.sessionId, (sub) => {
            const messageId = sub.streamingMessageId
            return {
              ...sub,
              running: false,
              pending: [],
              streamingMessageId: undefined,
              liveToolInputs: messageId
                ? Object.fromEntries(
                    Object.entries(sub.liveToolInputs).filter(([k]) => !k.startsWith(`${messageId}:`)),
                  )
                : sub.liveToolInputs,
              error: msg.reason === 'error' ? (msg.error ?? '子代理执行出错') : undefined,
              summary: sub.summary
                ? {
                    ...sub.summary,
                    status: msg.reason === 'error' ? ('error' as const) : ('idle' as const),
                    updatedAt: Date.now(),
                  }
                : null,
            }
          })
          break
        }
        patchActive(hostId, msg.sessionId, (a) => {
          const messageId = a.streamingMessageId
          const liveToolInputs = messageId
            ? Object.fromEntries(
                Object.entries(a.liveToolInputs).filter(([k]) => !k.startsWith(`${messageId}:`)),
              )
            : a.liveToolInputs
          return {
            ...a,
            messages: a.messages.map((m) =>
              m.local && m.queued ? { ...m, queued: false } : m,
            ),
            running: false,
            stopping: false,
            pending: [],
            streamingMessageId: undefined,
            liveToolInputs,
            turnError: msg.reason === 'error' ? (msg.error ?? '回合执行出错') : undefined,
            summary: a.summary
              ? {
                  ...a.summary,
                  status: msg.reason === 'error' ? ('error' as const) : ('idle' as const),
                }
              : null,
          }
        })
        if (msg.reason === 'error') {
          const route = parseHash()
          const viewing =
            route.kind === 'session' &&
            route.hostId === hostId &&
            route.sessionId === msg.sessionId
          // 正在看这个会话时由对话底部横幅展示，避免同一条错误出现两次。
          if (!viewing) {
            const title =
              get().runtimes[hostId]?.sessions.find((s) => s.id === msg.sessionId)?.title ||
              '未命名会话'
            toast(`会话「${title}」出错`, 'error', {
              onClick: () => navigate({ kind: 'session', hostId, sessionId: msg.sessionId }),
            })
          }
        }
        set((state) => ({ changesNonce: state.changesNonce + 1 }))
        if (activeSummaryForSession(hostId, msg.sessionId)) {
          const base = activeSummaryForSession(hostId, msg.sessionId)!
          applySessionSummary(hostId, {
            ...base,
            status: msg.reason === 'error' ? 'error' : 'idle',
            updatedAt: Date.now(),
          })
        }
        const finished = get().runtimes[hostId]?.sessions.find((s) => s.id === msg.sessionId)
        notifyTurnEnd({
          hostId,
          sessionId: msg.sessionId,
          sessionTitle: finished?.title ?? '未命名会话',
          hostName: getHost(hostId)?.name ?? 'Host',
          reason: msg.reason,
          error: msg.error,
        })
        break
      }
      case 'error': {
        const host = getHost(hostId)
        toast(`${host?.name ?? 'Host'}：${msg.message}`, 'error')
        break
      }
      default:
        break
    }
  }
}
