import { useEffect, useRef } from 'react'
import type { ContentBlock, InjectionChange, SessionSummary } from '@tandem/protocol'
import { GitFork } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { cn } from '../lib/cn'
import { navigate } from '../lib/router'
import type { HookNotice, ToolResultBlock, UiMessage } from '../lib/types'
import { ToolGroup, entriesFromMessages } from './chat/ToolGroup'
import { HookNoticeLine } from './chat/HookNoticeLine'
import { UserMessage } from './chat/UserMessage'
import { AssistantMessage } from './chat/AssistantMessage'
import {
  hasUserContent,
  ContextNote,
  InjectionsNote,
  InjectionChangeNote,
} from './chat/MessageNotes'
import '../styles/chat.css'

const EMPTY: UiMessage[] = []
const EMPTY_HOOKS: HookNotice[] = []

function SkeletonMessages() {
  return (
    <div className="space-y-6 py-6">
      <div className="flex justify-end">
        <div className="skeleton h-11 w-[55%] rounded-2xl" />
      </div>
      <div className="space-y-2.5">
        <div className="skeleton h-3.5 w-[82%]" />
        <div className="skeleton h-3.5 w-[91%]" />
        <div className="skeleton h-3.5 w-[64%]" />
      </div>
      <div className="skeleton h-10 w-[72%] rounded-xl" />
      <div className="space-y-2.5">
        <div className="skeleton h-3.5 w-[88%]" />
        <div className="skeleton h-3.5 w-[46%]" />
      </div>
    </div>
  )
}

export function MessageList({
  showSkeleton,
  messages: messagesProp,
  readOnly = false,
  toolResults,
  cwd,
  checkpoints,
}: {
  showSkeleton?: boolean
  /** 传入时渲染这份消息（如外部会话只读预览），不读当前活动会话。 */
  messages?: UiMessage[]
  readOnly?: boolean
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
  /** 用户消息 id → 检查点 id，用于操作条判断能否回退/重新生成。 */
  checkpoints?: Map<string, string>
}) {
  const storeMessages = useAppStore((s) => s.active?.messages ?? EMPTY)
  const storeSessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const storeStreamingId = useAppStore((s) => s.active?.streamingMessageId)
  const storeHooks = useAppStore((s) => s.active?.hookEvents ?? EMPTY_HOOKS)
  const messages = messagesProp ?? storeMessages
  const hooks = messagesProp ? EMPTY_HOOKS : storeHooks
  const activeHostId = useAppStore((s) => s.active?.hostId ?? null)
  const storeInjections = useAppStore((s) => (messagesProp ? undefined : s.active?.injections))
  const hostSessions = useAppStore((s) =>
    s.active?.hostId ? s.runtimes[s.active.hostId]?.sessions : undefined,
  )
  const sessionId = messagesProp ? null : storeSessionId
  const streamingId = messagesProp ? undefined : storeStreamingId

  // 首屏加载的消息不播放进入动画；之后新增的消息才淡入上移。
  // animated 里的类名会一直保留，避免流式更新时把进场动画截断。
  const seen = useRef<{
    sessionId: string | null
    primed: boolean
    ids: Set<string>
    animated: Set<string>
  }>({
    sessionId: null,
    primed: false,
    ids: new Set(),
    animated: new Set(),
  })
  if (seen.current.sessionId !== sessionId) {
    seen.current = { sessionId, primed: false, ids: new Set(), animated: new Set() }
  }
  if (seen.current.primed) {
    for (const m of messages) {
      if (!seen.current.ids.has(m.id)) seen.current.animated.add(m.id)
    }
  }
  const animateIds = seen.current.animated

  useEffect(() => {
    const state = seen.current
    if (!state.primed) {
      if (messages.length === 0) return
      state.primed = true
    }
    for (const m of messages) state.ids.add(m.id)
  }, [messages, sessionId])

  if (showSkeleton) return <SkeletonMessages />

  // 工具调用常常跨多条 assistant 消息（中间夹着隐藏的 tool_result）。
  // 连续、无文本的 assistant 消息合并成一个工具运行段。
  type Segment =
    | { kind: 'message'; message: UiMessage; animate: boolean }
    | { kind: 'notice'; message: UiMessage; animate: boolean }
    | { kind: 'run'; key: string; messages: UiMessage[]; animate: boolean }
  const segments: Segment[] = []
  let toolRun: UiMessage[] = []
  const flushRun = () => {
    if (toolRun.length === 0) return
    const toolCount = toolRun.reduce(
      (n, m) => n + m.content.filter((b) => b.type === 'tool_use').length,
      0,
    )
    if (toolCount >= 3) {
      segments.push({
        kind: 'run',
        key: `run-${toolRun[0].id}`,
        messages: toolRun,
        animate: toolRun.some((m) => animateIds.has(m.id)),
      })
    } else {
      for (const m of toolRun) {
        segments.push({ kind: 'message', message: m, animate: animateIds.has(m.id) })
      }
    }
    toolRun = []
  }
  for (const m of messages) {
    if (m.notice) {
      flushRun()
      segments.push({ kind: 'notice', message: m, animate: animateIds.has(m.id) })
      continue
    }
    if (m.role === 'user') {
      const visible = m.content.filter((b) => b.type !== 'tool_result')
      if (visible.length === 0) continue
      flushRun()
      segments.push({ kind: 'message', message: m, animate: animateIds.has(m.id) })
      continue
    }
    const hasText = m.content.some((b) => b.type === 'text' && b.text.trim())
    if (hasText) {
      flushRun()
      segments.push({ kind: 'message', message: m, animate: animateIds.has(m.id) })
    } else {
      toolRun.push(m)
    }
  }
  flushRun()

  const hooksByMessage = new Map<string, HookNotice[]>()
  const messageIds = new Set(messages.map((m) => m.id))
  const orphanHooks: HookNotice[] = []
  for (const hook of hooks) {
    if (hook.messageId && messageIds.has(hook.messageId)) {
      const list = hooksByMessage.get(hook.messageId)
      if (list) list.push(hook)
      else hooksByMessage.set(hook.messageId, [hook])
    } else {
      orphanHooks.push(hook)
    }
  }
  const hookLine = (id: string) => {
    const list = hooksByMessage.get(id)
    return list && list.length > 0 ? <HookNoticeLine notices={list} /> : null
  }

  // 分叉子会话：在分叉点那条消息下面给一个小入口（可能有多条）。
  const forkChildrenByMessage = new Map<string, SessionSummary[]>()
  if (!messagesProp && storeSessionId) {
    for (const summary of hostSessions ?? []) {
      const from = summary.forkedFrom
      if (from?.sessionId !== storeSessionId || !from.messageId) continue
      const list = forkChildrenByMessage.get(from.messageId) ?? []
      list.push(summary)
      forkChildrenByMessage.set(from.messageId, list)
    }
  }
  const forkLinks = (messageId: string) => {
    const list = forkChildrenByMessage.get(messageId)
    if (!list?.length || !activeHostId) return null
    return (
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-0.5 text-[12px] leading-4 text-muted">
        <span className="flex items-center gap-1">
          <GitFork size={11} />
          已分叉
        </span>
        {list.map((child) => (
          <button
            key={child.id}
            type="button"
            onClick={() => navigate({ kind: 'session', hostId: activeHostId, sessionId: child.id })}
            className="inline-flex min-w-0 max-w-[280px] items-center gap-0.5 rounded px-1 py-0.5 text-left text-text-tertiary transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
            title={`打开分叉会话：${child.title}`}
          >
            → <span className="truncate">{child.title || '未命名会话'}</span>
          </button>
        ))}
      </div>
    )
  }

  const turnIndex = new Map<string, number>()
  let turn = 0
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (!hasUserContent(m)) continue
    turnIndex.set(m.id, turn++)
  }

  // 助理消息的操作条以它前面最近一条可见用户消息作为本轮锚点。
  const turnUserByAssistant = new Map<string, UiMessage>()
  let lastUser: UiMessage | undefined
  for (const m of messages) {
    if (m.role === 'user') {
      if (hasUserContent(m)) lastUser = m
    } else if (lastUser) {
      turnUserByAssistant.set(m.id, lastUser)
    }
  }

  const changesByMessage = new Map<string, InjectionChange>()
  for (const change of storeInjections?.changes ?? []) {
    if (change.beforeMessageId) changesByMessage.set(change.beforeMessageId, change)
  }
  return (
    <div className="flex flex-col gap-6 pb-2">
      {!messagesProp && <InjectionsNote cwd={cwd} />}
      {segments.map((seg) => {
        if (seg.kind === 'run') {
          return (
            <div key={seg.key} className="msg-row">
              <ToolGroup
                entries={entriesFromMessages(seg.messages, streamingId)}
                animate={seg.animate}
                toolResults={toolResults}
                cwd={cwd}
              />
            </div>
          )
        }
        if (seg.kind === 'notice') {
          const text = seg.message.content
            .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join(' ')
          return (
            <div
              key={seg.message.id}
              className={cn(
                'msg-row px-1 text-[12px] leading-4 text-muted',
                seg.animate && 'chat-msg-enter',
              )}
            >
              {text}
            </div>
          )
        }
        const m = seg.message
        if (m.role === 'user') {
          const contexts = m.content.filter(
            (b): b is Extract<ContentBlock, { type: 'context' }> => b.type === 'context',
          )
          return (
            <div
              key={m.id}
              className="msg-row"
              data-turn-id={m.id}
              data-turn-index={turnIndex.get(m.id)}
              data-actions={
                m.content.some((b) => b.type === 'text' && b.text.trim()) ? 'true' : undefined
              }
            >
              {changesByMessage.has(m.id) && (
                <InjectionChangeNote change={changesByMessage.get(m.id)!} />
              )}
              {contexts.length > 0 && (
                <div className="mb-1 space-y-0.5">
                  {contexts.map((ctx, i) => (
                    <ContextNote key={i} kind={ctx.kind} text={ctx.text} />
                  ))}
                </div>
              )}
              <UserMessage message={m} animate={seg.animate} readOnly={readOnly} />
              {forkLinks(m.id)}
              {hookLine(m.id)}
            </div>
          )
        }
        return (
          <div
            key={m.id}
            className="msg-row"
            data-streaming={streamingId === m.id ? 'true' : undefined}
            data-actions={
              streamingId !== m.id &&
              m.content.some((b) => b.type === 'text' && b.text.trim())
                ? 'true'
                : undefined
            }
          >
            <AssistantMessage
              message={m}
              streaming={!!streamingId && m.id === streamingId}
              animate={seg.animate}
              toolResults={toolResults}
              cwd={cwd}
              readOnly={readOnly}
              turnUser={turnUserByAssistant.get(m.id)}
              checkpointId={
                turnUserByAssistant.get(m.id)
                  ? checkpoints?.get(turnUserByAssistant.get(m.id)!.id)
                  : undefined
              }
            />
            {forkLinks(m.id)}
            {hookLine(m.id)}
          </div>
        )
      })}
      {!messagesProp && orphanHooks.length > 0 && <HookNoticeLine notices={orphanHooks} />}
    </div>
  )
}

