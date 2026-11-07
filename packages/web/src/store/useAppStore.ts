import { create } from 'zustand'
import type {
  PermissionRequest,
  ServerMsg,
  Session,
  SessionSummary,
} from '@tandem/protocol'
import { api } from '../lib/api'
import { HostConnection } from '../lib/ws'
import { navigate, parseHash } from '../lib/router'
import { notifyBudget, notifyPermission, notifyTurnEnd, cancelPermissionNotification } from '../lib/attention'
import { useUiStore } from './useUiStore'
import { useTaskStore } from './useTaskStore'
import { useScheduleStore } from './useScheduleStore'
import { useVcsStore } from '../lib/useVcs'
import type {
  ActiveSession,
  ConnectionState,
  ExternalSessionItem,
  HostConfig,
  HookNotice,
  HostRuntime,
  SubagentSession,
  UiMessage,
} from '../lib/types'
import {
  appendSummary,
  childSubscriptions,
  collectToolResults,
  connections,
  emptySubagent,
  isDescendantSummary,
  isRunningStatus,
  newId,
  summaryOf,
  toast,
} from './appStore/helpers'
import type { AppState } from './appStore/types'
import { createHostsSlice } from './appStore/hostsSlice'

export type { HostInboxState } from './appStore/types'
export { depthOf } from './appStore/helpers'

export const useAppStore = create<AppState>((set, get) => {
  const getHost = (id: string): HostConfig | undefined => get().hosts.find((h) => h.id === id)

  const patchRuntime = (hostId: string, patch: Partial<HostRuntime>): void => {
    set((state) => {
      const rt = state.runtimes[hostId]
      if (!rt) return state
      return { runtimes: { ...state.runtimes, [hostId]: { ...rt, ...patch } } }
    })
  }

  /** 外部会话列表同时写入 runtime 和按 hostId 的汇总表。 */
  const setExternalSessions = (
    hostId: string,
    updater: (list: ExternalSessionItem[]) => ExternalSessionItem[],
  ): void => {
    set((state) => {
      const rt = state.runtimes[hostId]
      const current = state.externalSessions[hostId] ?? rt?.externalSessions ?? []
      const next = updater(current)
      return {
        ...(rt
          ? { runtimes: { ...state.runtimes, [hostId]: { ...rt, externalSessions: next } } }
          : {}),
        externalSessions: { ...state.externalSessions, [hostId]: next },
      }
    })
  }

  const patchActive = (
    hostId: string,
    sessionId: string,
    updater: (active: ActiveSession) => ActiveSession,
  ): void => {
    set((state) => {
      if (!state.active || state.active.hostId !== hostId || state.active.sessionId !== sessionId) {
        return state
      }
      return { active: updater(state.active) }
    })
  }

  const patchSubagent = (
    hostId: string,
    childId: string,
    updater: (sub: SubagentSession) => SubagentSession,
  ): void => {
    set((state) => {
      const active = state.active
      if (!active || active.hostId !== hostId || !active.subagents[childId]) return state
      return {
        active: {
          ...active,
          subagents: { ...active.subagents, [childId]: updater(active.subagents[childId]) },
        },
      }
    })
  }

  const addSubagent = (hostId: string, summary: SessionSummary): void => {
    const current = get().active
    if (!current || current.hostId !== hostId || !summary.parentId) return
    const sessions = get().runtimes[hostId]?.sessions ?? []
    if (!isDescendantSummary(sessions, summary, current.sessionId)) return
    set((state) => {
      const active = state.active
      if (!active || active.hostId !== hostId) return state
      const prev = active.subagents[summary.id]
      if (prev) {
        if (prev.summary === summary) return state
        return {
          active: {
            ...active,
            subagents: { ...active.subagents, [summary.id]: { ...prev, summary } },
          },
        }
      }
      return {
        active: {
          ...active,
          subagents: { ...active.subagents, [summary.id]: emptySubagent(summary) },
        },
      }
    })
    subscribeChild(hostId, summary.id)
  }

  const subscribeChild = (hostId: string, childId: string): void => {
    const active = get().active
    if (!active || active.hostId !== hostId) return
    let set = childSubscriptions.get(hostId)
    if (!set) {
      set = new Set()
      childSubscriptions.set(hostId, set)
    }
    if (set.has(childId)) return
    set.add(childId)
    connections.get(hostId)?.subscribe(childId)
  }

  const syncChildren = (hostId: string, parentId: string): void => {
    const active = get().active
    if (!active || active.hostId !== hostId || active.sessionId !== parentId) return
    const sessions = get().runtimes[hostId]?.sessions ?? []
    for (const child of sessions) {
      if (isDescendantSummary(sessions, child, parentId)) addSubagent(hostId, child)
    }
  }

  const clearChildSubscriptions = (hostId: string): void => {
    const set = childSubscriptions.get(hostId)
    if (!set) return
    const conn = connections.get(hostId)
    for (const id of set) conn?.unsubscribe(id)
    childSubscriptions.delete(hostId)
  }

  const applySubagentSnapshot = (
    hostId: string,
    session: Session,
    pendingPermissions: PermissionRequest[],
  ): void => {
    const summary = summaryOf(session)
    const sessions = get().runtimes[hostId]?.sessions ?? []
    const activeNow = get().active
    if (
      !activeNow ||
      activeNow.hostId !== hostId ||
      !isDescendantSummary(sessions, summary, activeNow.sessionId)
    ) {
      return
    }
    set((state) => {
      const active = state.active
      if (!active || active.hostId !== hostId) return state
      const last = session.messages[session.messages.length - 1]
      return {
        active: {
          ...active,
          subagents: {
            ...active.subagents,
            [session.id]: {
              summary,
              messages: session.messages,
              pending: pendingPermissions,
              loading: false,
              running: isRunningStatus(session.status),
              streamingMessageId:
                session.status === 'running' && last?.role === 'assistant' ? last.id : undefined,
              liveToolInputs: {},
              toolResults: collectToolResults(session.messages),
            },
          },
        },
      }
    })
  }

  const applySessionSummary = (hostId: string, summary: SessionSummary): void => {
    set((state) => {
      const rt = state.runtimes[hostId]
      if (!rt) return state
      const runtimes = {
        ...state.runtimes,
        [hostId]: { ...rt, sessions: appendSummary(rt.sessions, summary) },
      }
      if (!state.active || state.active.hostId !== hostId || state.active.sessionId !== summary.id) {
        return { runtimes }
      }
      const active: ActiveSession = {
        ...state.active,
        summary,
        running: isRunningStatus(summary.status) ? true : state.active.running,
        turnError:
          summary.status === 'error'
            ? (state.active.turnError ?? '回合执行出错')
            : summary.status === 'running'
              ? undefined
              : state.active.turnError,
      }
      return { runtimes, active }
    })
    if (summary.parentId) addSubagent(hostId, summary)
  }

  const activeSummaryForSession = (
    hostId: string,
    sessionId: string,
  ): SessionSummary | null => {
    const active = get().active
    if (!active || active.hostId !== hostId || active.sessionId !== sessionId) return null
    return active.summary
  }

  const removeSummary = (hostId: string, sessionId: string): void => {
    set((state) => {
      const rt = state.runtimes[hostId]
      if (!rt) return state
      return {
        runtimes: {
          ...state.runtimes,
          [hostId]: { ...rt, sessions: rt.sessions.filter((s) => s.id !== sessionId) },
        },
      }
    })
  }

  const applySnapshot = (
    hostId: string,
    session: Session,
    pendingPermissions: ActiveSession['pending'],
  ): void => {
    const summary = summaryOf(session)
    set((state) => {
      if (
        !state.active ||
        state.active.hostId !== hostId ||
        state.active.sessionId !== session.id
      ) {
        return state
      }
      const rt = state.runtimes[hostId]
      const runtimes = rt
        ? { ...state.runtimes, [hostId]: { ...rt, sessions: appendSummary(rt.sessions, summary) } }
        : state.runtimes
      const last = session.messages[session.messages.length - 1]
      return {
        runtimes,
        active: {
          ...state.active,
          summary,
          messages: session.messages,
          pending: pendingPermissions,
          todos: session.todos ?? [],
          loading: false,
          error: undefined,
          running: isRunningStatus(session.status),
          stopping: false,
          streamingMessageId:
            session.status === 'running' && last?.role === 'assistant' ? last.id : undefined,
          liveToolInputs: {},
          toolResults: collectToolResults(session.messages),
          plan: session.plan,
          hookEvents: [],
        },
      }
    })
  }

  async function loadSessionFallback(hostId: string, sessionId: string): Promise<void> {
    const host = getHost(hostId)
    if (!host) return
    try {
      const session = await api.session(host, sessionId)
      if (!get().active || get().active?.sessionId !== sessionId) return
      applySnapshot(hostId, session, [])
    } catch (err) {
      if (!get().active || get().active?.sessionId !== sessionId) return
      patchActive(hostId, sessionId, (a) => ({
        ...a,
        loading: false,
        error: err instanceof Error ? err.message : '加载会话失败',
      }))
    }
  }

  function ensureConnection(hostId: string): HostConnection | null {
    const host = getHost(hostId)
    if (!host) return null
    const existing = connections.get(hostId)
    if (existing) return existing

    const conn = new HostConnection(host, {
      onStatus: (status: ConnectionState, error?: string) => {
        patchRuntime(hostId, {
          status,
          error: status === 'offline' ? (error ?? '连接已断开，正在重连…') : undefined,
        })
      },
      onMessage: (msg) => handleServerMessage(hostId, msg),
    })
    connections.set(hostId, conn)
    conn.connect()
    return conn
  }

  function handleServerMessage(hostId: string, msg: ServerMsg): void {
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
        const text = `${period} ${name} 预算已用 ${percent}%`
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

  return {
    initialized: false,
    hosts: [],
    activeHostId: null,
    runtimes: {},
    externalSessions: {},
    inbox: {},
    active: null,
    changesNonce: 0,
    worktreeIntents: {},

    ...createHostsSlice(set, get, {
      patchRuntime,
      setExternalSessions,
      ensureConnection,
      applySessionSummary,
      syncChildren,
    }),

    bumpChanges: () => set((state) => ({ changesNonce: state.changesNonce + 1 })),
    openFileBrowser: (path) => {
      const cwd = get().active?.summary?.cwd
      if (!cwd) {
        useUiStore.getState().toast('当前会话没有工作目录', 'error')
        return
      }
      const ui = useUiStore.getState()
      ui.setFileBrowserVisible(true)
      ui.openFilePreview({ path: path ?? '', cwd })
    },

    openSession: (hostId, sessionId) => {
      const current = get().active
      if (current && current.hostId === hostId && current.sessionId === sessionId) return
      if (current) {
        connections.get(current.hostId)?.unsubscribe(current.sessionId)
        clearChildSubscriptions(current.hostId)
      }

      get().activateHost(hostId)
      const host = getHost(hostId)
      if (!host) return
      const rt = get().runtimes[hostId]
      const summary = rt?.sessions.find((s) => s.id === sessionId) ?? null
      set({
        active: {
          hostId,
          sessionId,
          summary,
          messages: [],
          pending: [],
          todos: [],
          loading: true,
          running: summary ? isRunningStatus(summary.status) : false,
          stopping: false,
          liveToolInputs: {},
          toolResults: {},
          hookEvents: [],
          subagents: {},
        },
      })
      if (!rt?.sessionsLoaded) void get().refreshSessions(hostId)
      // 详情面板要在打开会话后立刻显示账号名：账号列表未就绪时补拉一次
      if (!rt?.profilesLoaded && !rt?.profilesLoading) void get().refreshProfiles(hostId)

      const conn = ensureConnection(hostId)
      conn?.subscribe(sessionId)
      syncChildren(hostId, sessionId)
      // 系统提示注入段落：会话开头展开查看（与 WS 推送互为备份）
      void api
        .injections(host, sessionId)
        .then((injections) => {
          const now = get().active
          if (!now || now.hostId !== hostId || now.sessionId !== sessionId) return
          set({ active: { ...now, injections } })
        })
        .catch(() => {})
      // WebSocket 尚未连上时，先用 REST 拉一份只读快照，避免空白等待。
      if (!conn || conn.status !== 'online') void loadSessionFallback(hostId, sessionId)
      else {
        // 正常情况下 snapshot 会立刻到达；若 3 秒仍空白再兜底一次。
        window.setTimeout(() => {
          const a = get().active
          if (a && a.hostId === hostId && a.sessionId === sessionId && a.loading && a.messages.length === 0) {
            void loadSessionFallback(hostId, sessionId)
          }
        }, 3000)
      }
    },

    closeSession: () => {
      const active = get().active
      if (active) {
        connections.get(active.hostId)?.unsubscribe(active.sessionId)
        clearChildSubscriptions(active.hostId)
      }
      set({ active: null })
    },

    reloadActiveSession: () => {
      const active = get().active
      if (!active) return
      const conn = ensureConnection(active.hostId)
      patchActive(active.hostId, active.sessionId, (a) => ({ ...a, loading: true, error: undefined }))
      if (conn?.status === 'online') {
        conn.unsubscribe(active.sessionId)
        conn.subscribe(active.sessionId)
      } else {
        void loadSessionFallback(active.hostId, active.sessionId)
      }
    },

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

    mergeWorktree: async (hostId, sessionId, strategy) => {
      const host = getHost(hostId)
      if (!host) return false
      try {
        const result = await api.mergeWorktree(host, sessionId, strategy)
        if (!result.ok) throw new Error(result.error || '合并失败')
        toast('已合并回基准分支', 'success')
        return true
      } catch (err) {
        toast(err instanceof Error ? err.message : '合并失败', 'error')
        return false
      }
    },

    setWorktreeIntent: (hostId, sessionId, on) => {
      const key = `${hostId}:${sessionId}`
      set((state) => {
        const worktreeIntents = { ...state.worktreeIntents }
        if (on) worktreeIntents[key] = true
        else delete worktreeIntents[key]
        return { worktreeIntents }
      })
    },

    ensureWorktree: async (hostId, sessionId) => {
      const key = `${hostId}:${sessionId}`
      if (!get().worktreeIntents[key]) return true
      const host = getHost(hostId)
      if (!host) return false
      const rt = get().runtimes[hostId]
      const summary =
        (get().active?.hostId === hostId && get().active?.sessionId === sessionId
          ? get().active?.summary
          : null) ?? rt?.sessions.find((s) => s.id === sessionId)
      const clearIntent = () => get().setWorktreeIntent(hostId, sessionId, false)
      if (summary?.worktree) {
        clearIntent()
        return true
      }
      try {
        const updated = await api.worktree(host, sessionId)
        applySessionSummary(hostId, updated)
        clearIntent()
        if (updated.worktree) toast(`已创建隔离分支 ${updated.worktree.branch}`, 'success')
        return true
      } catch (err) {
        toast(err instanceof Error ? err.message : '创建 worktree 失败', 'error')
        return false
      }
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

    setPermissionMode: async (mode) => {
      const active = get().active
      const host = active ? getHost(active.hostId) : undefined
      if (!active?.summary || !host) return
      const prev = active.summary
      if (prev.permissionMode === mode) return
      const optimistic = { ...prev, permissionMode: mode }
      patchActive(active.hostId, active.sessionId, (a) => ({ ...a, summary: optimistic }))
      applySessionSummary(active.hostId, optimistic)
      try {
        const updated = await api.patchSession(host, prev.id, { permissionMode: mode })
        applySessionSummary(active.hostId, updated)
      } catch (err) {
        applySessionSummary(active.hostId, prev)
        toast(err instanceof Error ? err.message : '切换权限模式失败', 'error')
      }
    },

    rewind: async (input, seedText) => {
      const active = get().active
      const host = active ? getHost(active.hostId) : undefined
      if (!active || !host) return false
      if (active.running) {
        toast('会话正在运行，无法回退', 'error')
        return false
      }
      try {
        const session = await api.rewind(host, active.sessionId, input)
        applySnapshot(active.hostId, session, [])
        get().bumpChanges()
        if (input.restoreConversation && seedText !== undefined) {
          useUiStore.getState().seedPrompt(seedText)
        }
        toast(
          input.restoreFiles && input.restoreConversation
            ? '已恢复代码和对话'
            : input.restoreFiles
              ? '已恢复代码'
              : '已恢复对话',
          'success',
        )
        return true
      } catch (err) {
        toast(err instanceof Error ? err.message : '回退失败', 'error')
        return false
      }
    },

    setModel: async (profileId, groupId, model) => {
      const active = get().active
      const host = active ? getHost(active.hostId) : undefined
      if (!active?.summary || !host) return
      const prev = active.summary
      const optimistic: SessionSummary = { ...prev, profileId, model, groupId }
      patchActive(active.hostId, active.sessionId, (a) => ({ ...a, summary: optimistic }))
      applySessionSummary(active.hostId, optimistic)
      try {
        const updated = await api.patchSession(host, prev.id, {
          profileId,
          model,
          ...(groupId ? { groupId } : {}),
        })
        applySessionSummary(active.hostId, updated)
      } catch (err) {
        applySessionSummary(active.hostId, prev)
        toast(err instanceof Error ? err.message : '切换模型失败', 'error')
      }
    },

    createSession: async (hostId, input) => {
      const host = getHost(hostId)
      if (!host) throw new Error('Host 不存在')
      const summary = await api.createSession(host, input)
      const rt = get().runtimes[hostId]
      if (rt) applySessionSummary(hostId, summary)
      navigate({ kind: 'session', hostId, sessionId: summary.id })
      return summary
    },

    startSession: async (hostId, input, content) => {
      const host = getHost(hostId)
      if (!host) throw new Error('Host 不存在')
      const summary = await api.createSession(host, input)
      applySessionSummary(hostId, summary)
      set({
        active: {
          hostId,
          sessionId: summary.id,
          summary,
          messages: [],
          pending: [],
          todos: [],
          loading: true,
          running: false,
          stopping: false,
          liveToolInputs: {},
          toolResults: {},
          hookEvents: [],
          subagents: {},
        },
      })
      navigate({ kind: 'session', hostId, sessionId: summary.id })
      ensureConnection(hostId)?.subscribe(summary.id)
      get().send(content)
      return summary
    },

    dispatchSession: async (hostId, input, content) => {
      const host = getHost(hostId)
      if (!host) throw new Error('Host 不存在')
      if (get().runtimes[hostId]?.status !== 'online') throw new Error('Host 离线，无法派单')
      const summary = await api.createSession(host, input)
      applySessionSummary(hostId, summary)
      const conn = ensureConnection(hostId)
      const sent = conn?.send({ type: 'send', sessionId: summary.id, content }) ?? false
      return { summary, sent }
    },

    updateSession: async (hostId, sessionId, patch) => {
      const host = getHost(hostId)
      if (!host) return null
      const rt = get().runtimes[hostId]
      const active = get().active
      const prev =
        rt?.sessions.find((s) => s.id === sessionId) ??
        (active?.hostId === hostId && active.sessionId === sessionId ? active.summary : null)
      if (!prev) return null
      const optimistic: SessionSummary = { ...prev, ...patch }
      applySessionSummary(hostId, optimistic)
      try {
        const updated = await api.patchSession(host, sessionId, patch)
        applySessionSummary(hostId, updated)
        return updated
      } catch (err) {
        applySessionSummary(hostId, prev)
        toast(err instanceof Error ? err.message : '更新会话失败', 'error')
        return null
      }
    },

    forkSession: async (hostId, sessionId, messageId) => {
      const host = getHost(hostId)
      if (!host) return null
      try {
        const summary = await api.forkSession(host, sessionId, messageId)
        applySessionSummary(hostId, summary)
        toast(messageId ? '已从该消息分叉' : '已复制会话', 'success')
        navigate({ kind: 'session', hostId, sessionId: summary.id })
        return summary
      } catch (err) {
        toast(err instanceof Error ? err.message : '复制会话失败', 'error')
        return null
      }
    },

    deleteSession: async (hostId, sessionId, force = false) => {
      const host = getHost(hostId)
      if (!host) return
      await api.deleteSession(host, sessionId, force)
      removeSummary(hostId, sessionId)
      const active = get().active
      if (active && active.hostId === hostId && active.sessionId === sessionId) {
        connections.get(hostId)?.unsubscribe(sessionId)
        clearChildSubscriptions(hostId)
        set({ active: null })
        navigate({ kind: 'host', hostId })
      }
      toast('会话已删除', 'success')
    },
  }
})

