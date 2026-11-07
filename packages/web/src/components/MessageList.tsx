import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ContentBlock, InjectionChange, SessionSummary } from '@tandem/protocol'
import { GitFork, ChevronRight } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useSessionView } from './session/SessionScope'
import { cn } from '../lib/cn'
import { navigate } from '../lib/router'
import type { HookNotice, ToolResultBlock, UiMessage } from '../lib/types'
import { ToolGroup, entriesFromMessages } from './chat/ToolGroup'
import { HookNoticeLine } from './chat/HookNoticeLine'
import { HandoffCard } from './chat/HandoffCard'
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

/**
 * 每行单独 memo：流式输出时只有正在增长的那条重新渲染，
 * 避免上千条历史消息在每次 delta 时全部参与协调。
 */
const NoticeRow = memo(function NoticeRow({
  message,
  animate,
}: {
  message: UiMessage
  animate: boolean
}) {
  const [open, setOpen] = useState(false)
  const text = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
  if (message.compaction) {
    return (
      <div
        className={cn('msg-row px-1 text-[12px] leading-4 text-muted', animate && 'chat-msg-enter')}
        data-message-id={message.id}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1 rounded px-0.5 text-left text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
        >
          <ChevronRight
            size={12}
            className={cn('shrink-0 transition-transform', open && 'rotate-90')}
          />
          <span>{text}</span>
        </button>
        {open && (
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2/50 p-2 text-[12px] leading-4 text-text-soft">
            {message.compaction.summary}
          </pre>
        )}
      </div>
    )
  }
  return (
    <div
      className={cn('msg-row px-1 text-[12px] leading-4 text-muted', animate && 'chat-msg-enter')}
      data-message-id={message.id}
    >
      {text}
    </div>
  )
})

const UserRow = memo(function UserRow({
  message,
  animate,
  readOnly,
  turnIndex,
  change,
  fork,
  hook,
}: {
  message: UiMessage
  animate: boolean
  readOnly: boolean
  turnIndex?: number
  change?: ReactNode
  fork?: ReactNode
  hook?: ReactNode
}) {
  const contexts = message.content.filter(
    (b): b is Extract<ContentBlock, { type: 'context' }> => b.type === 'context',
  )
  return (
    <div
      className="msg-row"
      data-message-id={message.id}
      data-turn-id={message.id}
      data-turn-index={turnIndex}
      data-actions={
        message.content.some((b) => b.type === 'text' && b.text.trim()) ? 'true' : undefined
      }
    >
      {change}
      {contexts.length > 0 && (
        <div className="mb-1 space-y-0.5">
          {contexts.map((ctx, i) => (
            <ContextNote key={i} kind={ctx.kind} text={ctx.text} />
          ))}
        </div>
      )}
      <UserMessage message={message} animate={animate} readOnly={readOnly} />
      {fork}
      {hook}
    </div>
  )
})

const AssistantRow = memo(function AssistantRow({
  message,
  streaming,
  animate,
  toolResults,
  cwd,
  readOnly,
  turnUser,
  checkpointId,
  fork,
  hook,
}: {
  message: UiMessage
  streaming: boolean
  animate: boolean
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
  readOnly: boolean
  turnUser?: UiMessage
  checkpointId?: string
  fork?: ReactNode
  hook?: ReactNode
}) {
  return (
    <div
      className="msg-row"
      data-message-id={message.id}
      data-streaming={streaming ? 'true' : undefined}
      data-actions={
        !streaming && message.content.some((b) => b.type === 'text' && b.text.trim())
          ? 'true'
          : undefined
      }
    >
      <AssistantMessage
        message={message}
        streaming={streaming}
        animate={animate}
        toolResults={toolResults}
        cwd={cwd}
        readOnly={readOnly}
        turnUser={turnUser}
        checkpointId={checkpointId}
      />
      {fork}
      {hook}
    </div>
  )
})

const ToolRunRow = memo(function ToolRunRow({
  messages,
  animate,
  streamingId,
  toolResults,
  cwd,
}: {
  messages: UiMessage[]
  animate: boolean
  streamingId?: string
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
}) {
  return (
    <div className="msg-row" data-message-id={messages[0]?.id}>
      {messages.slice(1).map((message) => (
        <span key={message.id} data-message-id={message.id} aria-hidden="true" />
      ))}
      <ToolGroup
        entries={entriesFromMessages(messages, streamingId)}
        animate={animate}
        toolResults={toolResults}
        cwd={cwd}
      />
    </div>
  )
})

const INITIAL_WINDOW = 60
const BACKFILL_STEP = 150
// 常驻 DOM 上限：再往前的历史按需点按钮加载，保证 1000 轮会话也能流畅滚动。
const MAX_WINDOW = 400
const LOAD_MORE_STEP = 400

/** 长会话渐进渲染：先显示最近 60 条，再分批补齐更早的历史。 */
export function MessageList(props: {
  showSkeleton?: boolean
  messages?: UiMessage[]
  readOnly?: boolean
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
  checkpoints?: Map<string, string>
}) {
  const scopedSessionId = useSessionView((s) => s?.sessionId ?? null)
  const sessionId = props.messages ? 'preview' : (scopedSessionId ?? 'none')
  const key = props.messages ? `preview:${props.messages[0]?.id ?? 'empty'}` : sessionId
  return <MessageListInner key={key} {...props} />
}

function MessageListInner({
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
  const storeMessages = useSessionView((s) => s?.messages ?? EMPTY)
  const storeSessionId = useSessionView((s) => s?.sessionId ?? null)
  const storeStreamingId = useSessionView((s) => s?.streamingMessageId)
  const storeHooks = useSessionView((s) => s?.hookEvents ?? EMPTY_HOOKS)
  const messages = messagesProp ?? storeMessages
  const hooks = messagesProp ? EMPTY_HOOKS : storeHooks
  const activeHostId = useSessionView((s) => s?.hostId ?? null)
  const storeInjections = useSessionView((s) => (messagesProp ? undefined : s?.injections))
  const handoffStatus = useSessionView((s) =>
    messagesProp ? undefined : s?.summary?.handoff?.status,
  )
  const hostSessions = useAppStore((s) =>
    activeHostId ? s.runtimes[activeHostId]?.sessions : undefined,
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

  // 只先挂载最近一段；挂载后按小批次向上补历史，避免一次 1s+ 的长任务。
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW)
  const [windowCap, setWindowCap] = useState(MAX_WINDOW)
  // 未超过常驻上限的会话一次渲完，避免历史补进时滚动位置跳动；
  // 只有超长会话才启用渐进窗口。
  const effectiveWindow =
    messages.length <= MAX_WINDOW ? messages.length : Math.min(windowSize, messages.length)
  const windowFrom = Math.max(0, messages.length - effectiveWindow)
  const target = Math.min(messages.length, windowCap)
  useEffect(() => {
    if (messages.length <= MAX_WINDOW) return
    if (windowSize >= target) return
    const timer = setTimeout(() => {
      setWindowSize((size) => Math.min(target, size + BACKFILL_STEP))
    }, 30)
    return () => clearTimeout(timer)
  }, [windowSize, target, messages.length])
  const loadEarlier = () => {
    setWindowCap((cap) => cap + LOAD_MORE_STEP)
    setWindowSize((size) => size + LOAD_MORE_STEP)
  }

  // 上下文面板点击「最占空间」条目：必要时扩大渲染窗口，再把目标消息滚到视口中部
  useEffect(() => {
    const onJump = (event: Event) => {
      const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId
      if (!messageId) return
      const index = messages.findIndex((message) => message.id === messageId)
      if (index < 0) return
      const needed = messages.length - index + 20
      if (needed > windowSize) setWindowSize(Math.min(messages.length, needed))
      if (needed > windowCap) setWindowCap(needed)
      const scroll = () => {
        const el = document.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(messageId)}"]`,
        )
        if (!el) return
        const row = el.closest<HTMLElement>('.msg-row') ?? el
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        row.classList.remove('msg-jump-hit')
        // 强制重启动画：连续搜索不同命中时也能看见高亮
        void row.offsetWidth
        row.classList.add('msg-jump-hit')
        window.setTimeout(() => row.classList.remove('msg-jump-hit'), 2800)
      }
      window.setTimeout(scroll, 80)
      window.setTimeout(scroll, 300)
    }
    window.addEventListener('tandem-jump-message', onJump)
    return () => window.removeEventListener('tandem-jump-message', onJump)
  }, [messages, windowSize, windowCap])

  const visibleMessages = messages.slice(windowFrom)

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
  for (const m of visibleMessages) {
    if (m.summary) continue
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
    // 浏览器工具带页面截图/URL，逐张显示比折叠成「使用了 N 个工具」更有用
    const hasBrowserTool = m.content.some(
      (b) => b.type === 'tool_use' && b.name.startsWith('browser_'),
    )
    if (hasText || hasBrowserTool) {
      flushRun()
      segments.push({ kind: 'message', message: m, animate: animateIds.has(m.id) })
    } else {
      toolRun.push(m)
    }
  }
  flushRun()

  const hooksByMessage = new Map<string, HookNotice[]>()
  const messageIds = new Set(visibleMessages.map((m) => m.id))
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
    if (m.summary) continue
    if (!hasUserContent(m)) continue
    turnIndex.set(m.id, turn++)
  }

  // 助理消息的操作条以它前面最近一条可见用户消息作为本轮锚点。
  const turnUserByAssistant = new Map<string, UiMessage>()
  let lastUser: UiMessage | undefined
  for (const m of messages) {
    if (m.role === 'user') {
      if (!m.summary && hasUserContent(m)) lastUser = m
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
      {messages.length > MAX_WINDOW && windowSize < messages.length && windowSize < windowCap && (
        <div className="px-1 text-center text-[12px] text-muted" data-loading-history="true">
          正在载入更早的消息…
        </div>
      )}
      {windowFrom > 0 && windowSize >= windowCap && (
        <div className="flex justify-center pb-1" data-load-more="true">
          <button
            type="button"
            onClick={loadEarlier}
            className="rounded-lg px-3 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
          >
            加载更早的 {Math.min(LOAD_MORE_STEP, windowFrom)} 条消息（共 {windowFrom} 条）
          </button>
        </div>
      )}
      {segments.map((seg) => {
        if (seg.kind === 'run') {
          return (
            <ToolRunRow
              key={seg.key}
              messages={seg.messages}
              animate={seg.animate}
              streamingId={streamingId}
              toolResults={toolResults}
              cwd={cwd}
            />
          )
        }
        if (seg.kind === 'notice') {
          return <NoticeRow key={seg.message.id} message={seg.message} animate={seg.animate} />
        }
        const m = seg.message
        if (m.role === 'user') {
          return (
            <UserRow
              key={m.id}
              message={m}
              animate={seg.animate}
              readOnly={readOnly}
              turnIndex={turnIndex.get(m.id)}
              change={
                changesByMessage.has(m.id) ? (
                  <InjectionChangeNote change={changesByMessage.get(m.id)!} />
                ) : undefined
              }
              fork={forkLinks(m.id)}
              hook={hookLine(m.id)}
            />
          )
        }
        const turnUser = turnUserByAssistant.get(m.id)
        return (
          <AssistantRow
            key={m.id}
            message={m}
            streaming={!!streamingId && m.id === streamingId}
            animate={seg.animate}
            toolResults={toolResults}
            cwd={cwd}
            readOnly={readOnly}
            turnUser={turnUser}
            checkpointId={turnUser ? checkpoints?.get(turnUser.id) : undefined}
            fork={forkLinks(m.id)}
            hook={hookLine(m.id)}
          />
        )
      })}
      {!messagesProp &&
        handoffStatus &&
        handoffStatus !== 'done' &&
        handoffStatus !== 'failed' && <HandoffCard />}
      {!messagesProp && orphanHooks.length > 0 && <HookNoticeLine notices={orphanHooks} />}
    </div>
  )
}

