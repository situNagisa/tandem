import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ContentBlock, InjectionChange, PermissionRequest, SessionSummary } from '@tandem/protocol'
import { GitFork } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useSessionView } from './session/SessionScope'
import { cn } from '../lib/cn'
import { MESSAGE_PAGE_SIZE, gapMessage } from '../lib/messagePaging'
import { activeToolUses } from '../lib/turnActivity'
import { navigate } from '../lib/router'
import { prettyModel } from '../lib/modelName'
import type { HookNotice, PermissionTrailEntry, ToolResultBlock, UiMessage } from '../lib/types'
import { PermissionCard, PermissionResultLine } from './PermissionCard'
import { ToolGroup, entriesFromMessages } from './chat/ToolGroup'
import { HookNoticeLine } from './chat/HookNoticeLine'
import { CompactionNoticeLine } from './chat/CompactionNoticeLine'
import { HandoffCard } from './chat/HandoffCard'
import { RoutePlanLine } from './chat/RoutePlanLine'
import { TurnActivity } from './chat/TurnActivity'
import { DivisionPlanCard } from './chat/DivisionPlanCard'
import { delegationLabel, routeBiasLabel } from '../lib/routeLabels'
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
const EMPTY_IDS: string[] = []
const EMPTY_REQUESTS: PermissionRequest[] = []
const EMPTY_TRAIL: PermissionTrailEntry[] = []
const EMPTY_RUNNING_TOOLS: { ids: Set<string>; name?: string } = { ids: new Set() }

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

/** 未加载 / 未挂载的连续轮次：固定高度占位条，加载后原位替换，滚动位置不跳。 */
const GapBand = memo(function GapBand({
  gap,
  gapId,
  fromTurn,
  toTurn,
  loading,
  onLoad,
  onShow,
}: {
  gap: NonNullable<UiMessage['gap']>
  gapId: string
  fromTurn?: number
  toTurn?: number
  loading: boolean
  onLoad?: (count: 'first' | 'all') => void
  onShow?: () => void
}) {
  const count =
    fromTurn !== undefined && toTurn !== undefined && toTurn >= fromTurn
      ? toTurn - fromTurn + 1
      : 0
  const label = count
    ? `第 ${fromTurn}${count > 1 ? `–${toTurn}` : ''} 轮${gap.unmounted ? '未显示' : '未加载'}（${count} 轮）`
    : gap.unmounted
      ? '这一段更早的对话未显示'
      : '中间还有未加载的消息'
  return (
    <div
      className="msg-gap-band"
      data-message-gap={gapId}
      data-unmounted={gap.unmounted ? 'true' : undefined}
    >
      <span className="msg-gap-label">
        <span aria-hidden>⋯</span> {label}
      </span>
      {gap.unmounted ? (
        <button data-raw-button type="button" className="msg-gap-btn" onClick={onShow}>
          显示
        </button>
      ) : (
        <>
          <button data-raw-button
            type="button"
            disabled={loading}
            onClick={() => onLoad?.('first')}
            className="msg-gap-btn"
          >
            {loading ? '加载中…' : '加载前 10 轮'}
          </button>
          <button data-raw-button
            type="button"
            disabled={loading}
            onClick={() => onLoad?.('all')}
            className="msg-gap-btn"
          >
            全部
          </button>
        </>
      )}
    </div>
  )
})

/**
 * 每行单独 memo：流式输出时只有正在增长的那条重新渲染，
 * 避免上千条历史消息在每次 delta 时全部参与协调。
 */
const NoticeRow = memo(function NoticeRow({
  message,
  animate,
  hostId,
  sessionId,
}: {
  message: UiMessage
  animate: boolean
  hostId: string | null
  sessionId: string | null
}) {
  const route = message.route
  const rawText = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
  const text = route
    ? `自动：本轮使用 ${prettyModel(route.model)}（理由：${route.reason}）`
    : rawText
  if (message.compaction) {
    return (
      <CompactionNoticeLine
        message={message}
        hostId={hostId}
        sessionId={sessionId}
        animate={animate}
      />
    )
  }
  if (message.divisionPlan) {
    return (
      <DivisionPlanCard
        request={message.divisionPlan}
        hostId={hostId}
        sessionId={sessionId}
      />
    )
  }
  if (message.routePlan) {
    return (
      <RoutePlanLine text={rawText} plan={message.routePlan} />
    )
  }
  return (
    <div
      className={cn('msg-row px-1 text-[12px] leading-4 text-muted', animate && 'chat-msg-enter')}
      data-message-id={message.id}
      {...(route ? { 'data-route-notice': '', title: routeDetailText(route) } : {})}
    >
      {text}
    </div>
  )
})

/** hover 时的打分明细：一条紧凑字符串，交给统一 tooltip 展示。 */
function routeDetailText(route: NonNullable<UiMessage['route']>): string {
  const scores = route.scores
  const tier = { fast: '快速', balanced: '均衡', power: '强力' }[route.tier]
  return [
    `复杂度 ${scores.complexity}/100`,
    `消息 ${scores.messageChars} 字`,
    `关键词 ${scores.keywords.length ? scores.keywords.join('、') : '无'}`,
    `上下文 ${scores.contextTokens ? `${Math.round(scores.contextTokens / 1000)}k tok` : '未计'}`,
    `图片 ${scores.hasImage ? '是' : '否'}`,
    `上轮失败 ${scores.previousFailed ? '是' : '否'}`,
    `不确定 ${scores.uncertain ? '是' : '否'}`,
    `工具深度 ${scores.toolDepth}`,
    `分工 ${delegationLabel(scores.delegation)}`,
    `取向 ${routeBiasLabel(scores.preference)}`,
    `预算压力 ${Math.round((scores.budgetPressure ?? 0) * 100)}%`,
    `档位 ${tier}${scores.escalated ? ' · 升级' : ''}${scores.downgraded ? ' · 回落' : ''}`,
  ].join('；')
}

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
  subagentId,
  turnUser,
  checkpointId,
  runningToolIds,
  fork,
  hook,
}: {
  message: UiMessage
  streaming: boolean
  animate: boolean
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
  readOnly: boolean
  subagentId?: string
  turnUser?: UiMessage
  checkpointId?: string
  runningToolIds?: Set<string>
  fork?: ReactNode
  hook?: ReactNode
}) {
  return (
    <div
      className="msg-row"
      data-message-id={message.id}
      data-streaming={streaming ? 'true' : undefined}
      data-tool-only={
        !message.content.some((b) => b.type === 'text' && b.text.trim()) &&
        message.content.some((b) => b.type === 'tool_use')
          ? 'true'
          : undefined
      }
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
        subagentId={subagentId}
        turnUser={turnUser}
        checkpointId={checkpointId}
        runningToolIds={runningToolIds}
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
  runningToolIds,
}: {
  messages: UiMessage[]
  animate: boolean
  streamingId?: string
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
  runningToolIds?: Set<string>
}) {
  return (
    <div className="msg-row" data-message-id={messages[0]?.id} data-tool-only="true">
      {messages.slice(1).map((message) => (
        <span key={message.id} data-message-id={message.id} aria-hidden="true" />
      ))}
      <ToolGroup
        entries={entriesFromMessages(messages, streamingId, runningToolIds)}
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

/** 长会话渐进渲染：先显示最近 60 条，再分批补齐更早的历史。 */
export function MessageList(props: {
  showSkeleton?: boolean
  messages?: UiMessage[]
  readOnly?: boolean
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
  checkpoints?: Map<string, string>
  /** 在子代理会话的只读视图中渲染时传入，让内部 Task 卡片能定位下一层子会话。 */
  subagentId?: string
  /** 待审批请求：按 toolUseId 作为对话流里的一条消息渲染在触发它的工具调用之后。 */
  permissions?: PermissionRequest[]
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
  subagentId,
  permissions = EMPTY_REQUESTS,
}: {
  showSkeleton?: boolean
  /** 传入时渲染这份消息（如外部会话只读预览），不读当前活动会话。 */
  messages?: UiMessage[]
  readOnly?: boolean
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
  /** 用户消息 id → 检查点 id，用于操作条判断能否回退/重新生成。 */
  checkpoints?: Map<string, string>
  subagentId?: string
  permissions?: PermissionRequest[]
}) {
  const storeMessages = useSessionView((s) => s?.messages ?? EMPTY)
  const storeSessionId = useSessionView((s) => s?.sessionId ?? null)
  const storeStreamingId = useSessionView((s) => s?.streamingMessageId)
  const storeRunning = useSessionView((s) => (messagesProp ? false : (s?.running ?? false)))
  const storeSummaryUpdatedAt = useSessionView((s) => s?.summary?.updatedAt ?? 0)
  const storeHooks = useSessionView((s) => s?.hookEvents ?? EMPTY_HOOKS)
  const messages = messagesProp ?? storeMessages
  const hooks = messagesProp ? EMPTY_HOOKS : storeHooks
  const storeTrail = useSessionView((s) => (messagesProp ? undefined : s?.permissionTrail))
  const permissionResults = storeTrail ?? EMPTY_TRAIL
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
  // 本轮仍在执行的工具：消息已结束、等工具返回时用它们显示转圈与已运行时长（反馈16#10）。
  // 只在消息条数/末条 id/工具结果变化时重算，流式 delta 期间保持同一个 Set 引用，
  // 让 memo 的行不必跟着每个 token 重新渲染。
  const tailMessage = messages[messages.length - 1]
  // 流式消息先创建空壳、再用 block_delta 补内容，所以签名里要带末条消息的块数与工具结果数，
  // 这样工具调用/工具返回到达时重算，而普通文本 delta 保持同一个 Set 引用。
  const activitySignature = `${messages.length}:${tailMessage?.id ?? ''}:${tailMessage?.content.length ?? 0}:${
    toolResults ? Object.keys(toolResults).length : 0
  }`
  const runningTools = useMemo(
    () => (storeRunning ? activeToolUses(messages, toolResults) : EMPTY_RUNNING_TOOLS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storeRunning, activitySignature],
  )
  // 流式消息还没有任何文字（等首个 token）时也算「在等待」，在流末尾显示活动行。
  const streamingMessage = streamingId ? messages.find((m) => m.id === streamingId) : undefined
  const streamingStarted = !!streamingMessage?.content.some(
    (block) => (block.type === 'text' || block.type === 'thinking') && !!block.text.trim(),
  )
  const scopedHasEarlier = useSessionView((s) => s?.hasEarlier ?? false)
  const scopedLoadingEarlier = useSessionView((s) => s?.loadingEarlier ?? false)
  const scopedLoadingSegment = useSessionView((s) => s?.loadingSegment ?? false)
  const scopedTurns = useSessionView((s) => s?.turns)
  const scopedPinnedTurns = useSessionView((s) => (messagesProp ? undefined : s?.summary?.pinnedTurns))
  const hasEarlier = messagesProp ? false : scopedHasEarlier
  const loadingEarlier = messagesProp ? false : scopedLoadingEarlier
  const loadingSegment = messagesProp ? false : scopedLoadingSegment
  const serverTurns = messagesProp ? undefined : scopedTurns
  const pinnedTurns = scopedPinnedTurns ?? EMPTY_IDS
  const rootRef = useRef<HTMLDivElement>(null)

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
  const [bandBusy, setBandBusy] = useState<string | null>(null)
  /**
   * 挂载窗口的起点（消息 id）。null = 跟随尾部（流式/日常滚动）。
   * 跳到早期轮次时把窗口移到目标附近，窗口外的消息不挂载，由占位条代替。
   */
  const [windowAnchorId, setWindowAnchorId] = useState<string | null>(null)
  const anchorIndex = windowAnchorId
    ? messages.findIndex((message) => message.id === windowAnchorId)
    : -1
  // 未超过常驻上限的会话一次渲完，避免历史补进时滚动位置跳动；
  // 只有超长会话才启用渐进窗口。
  const effectiveWindow =
    messages.length <= MAX_WINDOW ? messages.length : Math.min(windowSize, messages.length)
  const tailFrom = Math.max(0, messages.length - effectiveWindow)
  const windowFrom =
    anchorIndex >= 0 ? Math.min(anchorIndex, tailFrom) : tailFrom
  const windowTo = Math.min(messages.length, windowFrom + effectiveWindow)
  const target = Math.min(messages.length, windowCap)
  useEffect(() => {
    if (anchorIndex >= 0) return
    if (messages.length <= MAX_WINDOW) return
    if (windowSize >= target) return
    const timer = setTimeout(() => {
      setWindowSize((size) => Math.min(target, size + BACKFILL_STEP))
    }, 30)
    return () => clearTimeout(timer)
  }, [windowSize, target, messages.length, anchorIndex])

  // 服务端分页：滚到顶部附近时向前取一页，并按新增高度补回滚动位置。
  const scrollBox = useCallback((): HTMLElement | null => {
    return (rootRef.current?.closest('.chat-scroll') as HTMLElement | null) ?? null
  }, [])
  const pendingAnchor = useRef<{
    id?: string
    offset?: number
    height: number
    top: number
  } | null>(null)
  const prevLength = useRef(messages.length)
  const captureAnchor = useCallback(() => {
    const box = scrollBox()
    if (!box) return null
    const boxTop = box.getBoundingClientRect().top
    const row = [...box.querySelectorAll<HTMLElement>('.msg-row[data-message-id]')].find(
      (el) => el.getBoundingClientRect().bottom > boxTop + 1,
    )
    return {
      ...(row?.dataset.messageId ? { id: row.dataset.messageId } : {}),
      ...(row ? { offset: row.getBoundingClientRect().top - boxTop } : {}),
      height: box.scrollHeight,
      top: box.scrollTop,
    }
  }, [scrollBox])
  const restoreAnchor = useCallback(() => {
    const anchor = pendingAnchor.current
    const box = scrollBox()
    if (!anchor || !box) return
    if (anchor.id) {
      const row = box
        .querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`)
        ?.closest<HTMLElement>('.msg-row')
      if (row && anchor.offset !== undefined) {
        const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top
        box.scrollTop += offset - anchor.offset
        return
      }
    }
    box.scrollTop = box.scrollHeight - anchor.height + anchor.top
  }, [scrollBox])
  const requestOlder = useCallback(() => {
    if (messagesProp || !sessionId || !activeHostId || !hasEarlier) return
    const box = scrollBox()
    if (!box || pendingAnchor.current) return
    pendingAnchor.current = captureAnchor()
    // 先扩大渲染窗口，新页到达时才有位置可挂载。
    setWindowCap((cap) => cap + MESSAGE_PAGE_SIZE)
    setWindowSize((size) => size + MESSAGE_PAGE_SIZE)
    void useAppStore.getState().loadEarlierMessages({
      hostId: activeHostId,
      sessionId,
    })
  }, [messagesProp, sessionId, activeHostId, hasEarlier, scrollBox, captureAnchor])

  useEffect(() => {
    if (messagesProp || !sessionId) return
    const box = scrollBox()
    if (!box) return
    const onScroll = () => {
      const distance = box.scrollHeight - box.scrollTop - box.clientHeight
      // 锚定窗口往下滚到头：先扩大挂载窗口；已经到会话末尾就恢复跟随尾部。
      if (windowAnchorId && distance < 100) {
        if (windowTo < messages.length && windowSize < MAX_WINDOW) {
          setWindowSize((size) => Math.min(messages.length, MAX_WINDOW, size + BACKFILL_STEP))
        } else {
          setWindowAnchorId(null)
        }
      }
      if (!hasEarlier) return
      if (box.scrollTop > 240) return
      if (box.scrollHeight <= box.clientHeight + 120) return
      requestOlder()
    }
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => box.removeEventListener('scroll', onScroll)
  }, [
    messagesProp,
    sessionId,
    hasEarlier,
    requestOlder,
    scrollBox,
    windowAnchorId,
    windowTo,
    windowSize,
    messages.length,
  ])

  useLayoutEffect(() => {
    if (messages.length > prevLength.current && pendingAnchor.current) {
      restoreAnchor()
      // 在顶部继续加载更早的历史时，把已加载的部分都挂上；否则新取回的一页会立刻被窗口裁掉。
      const box = scrollBox()
      if (box && box.scrollTop < 240) {
        setWindowSize(messages.length)
        setWindowCap(messages.length)
      }
    }
    prevLength.current = messages.length
  }, [messages, restoreAnchor, scrollBox])

  // 内容可见性/异步排版会让高度在后续帧继续变化：锚点期间持续观察，稳定后再放开。
  useEffect(() => {
    if (!pendingAnchor.current) return
    const content = rootRef.current
    const ro =
      content && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => restoreAnchor())
        : null
    if (content) ro?.observe(content)
    const timers = [0, 120, 320, 700, 1200].map((delay) =>
      window.setTimeout(() => restoreAnchor(), delay),
    )
    const fallback = window.setTimeout(() => {
      pendingAnchor.current = null
      ro?.disconnect()
    }, 2600)
    return () => {
      ro?.disconnect()
      timers.forEach((timer) => window.clearTimeout(timer))
      window.clearTimeout(fallback)
    }
  }, [messages.length, loadingEarlier, loadingSegment, restoreAnchor])

  const fillGap = (gapId: string) => {
    if (!sessionId || !activeHostId) return
    pendingAnchor.current = captureAnchor()
    setWindowCap((cap) => cap + MESSAGE_PAGE_SIZE)
    setWindowSize((size) => size + MESSAGE_PAGE_SIZE)
    void useAppStore.getState().fillMessageGap(activeHostId, sessionId, gapId)
  }

  // 上下文面板/搜索/收件箱：必要时扩大渲染窗口，再把目标消息或工具卡滚到视口中部
  const jumpTimers = useRef<number[]>([])
  const settleTimers = useRef<number[]>([])
  useEffect(() => {
    const onJump = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: string; toolUseId?: string }>).detail
      const messageId = detail?.messageId
      const toolUseId = detail?.toolUseId
      if (!messageId && !toolUseId) return
      // 后一次跳转取消前一次还没执行的滚动，否则旧目标会在新目标之后再滚一次（反馈2102#02）。
      for (const timer of jumpTimers.current) window.clearTimeout(timer)
      jumpTimers.current = []
      const index = toolUseId
        ? messages.findIndex((message) =>
            message.content.some((block) => block.type === 'tool_use' && block.id === toolUseId),
          )
        : messages.findIndex((message) => message.id === messageId)
      if (index < 0) {
        // 大纲/全文搜索跳到尚未加载的历史：先按需取该段，事件会重复触发以完成定位。
        if (messageId && !messagesProp && activeHostId && sessionId) {
          void useAppStore.getState().ensureMessageLoaded(activeHostId, sessionId, messageId)
        }
        return
      }
      // 窗口跟着跳转目标走：起点放在目标前约 60 条，窗口大小保持在常驻上限内，
      // 不再「从目标一直挂到末尾」（超大会话会一次挂上千条）。
      const anchor = messages[Math.max(0, index - 60)]
      if (anchor) setWindowAnchorId(anchor.id)
      setWindowSize((size) => Math.max(size, Math.min(MAX_WINDOW, 320)))
      setWindowCap((cap) => Math.max(cap, Math.min(MAX_WINDOW, 320)))
      const scroll = () => {
        const find = () =>
          toolUseId
            ? document.querySelector<HTMLElement>(`[data-tool-use-id="${CSS.escape(toolUseId)}"]`)
            : document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId!)}"]`)
        const el = find()
        if (!el) return
        if (toolUseId) {
          el.querySelector<HTMLElement>('.tool-row[aria-expanded="false"]')?.click()
        }
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        // 目标上下的 content-visibility 行会在滚动中才按实际高度展开，平滑滚动按开始时的
        // 布局落点会偏一截（会话图连点后目标不居中）。布局稳定后按实际位置补正到居中。
        for (const timer of settleTimers.current) window.clearTimeout(timer)
        settleTimers.current = []
        const settle = (attempt: number) => {
          const target = find()
          const box = target?.closest<HTMLElement>('.chat-scroll')
          if (!target || !box) return
          const view = box.getBoundingClientRect()
          const rect = target.getBoundingClientRect()
          const offset = rect.top + rect.height / 2 - (view.top + view.height / 2)
          if (Math.abs(offset) <= 16) return
          box.scrollTop += offset
          if (attempt < 4) {
            settleTimers.current.push(window.setTimeout(() => settle(attempt + 1), 180))
          }
        }
        settleTimers.current.push(window.setTimeout(() => settle(0), 420))
      }
      jumpTimers.current = [window.setTimeout(scroll, 80), window.setTimeout(scroll, 300)]
    }
    window.addEventListener('tandem-jump-message', onJump)
    return () => window.removeEventListener('tandem-jump-message', onJump)
  }, [messages, windowSize, windowCap, messagesProp, activeHostId, sessionId])
  useEffect(
    () => () => {
      for (const timer of jumpTimers.current) window.clearTimeout(timer)
      for (const timer of settleTimers.current) window.clearTimeout(timer)
    },
    [],
  )

  // 固定轮次必须始终可用：即使不在挂载窗口里也要先取回并保持挂载（反馈11#05）。
  const pinnedLoadRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (messagesProp || !activeHostId || !sessionId || pinnedTurns.length === 0) return
    const loaded = new Set(messages.map((message) => message.id))
    const missing = pinnedTurns.filter((id) => !loaded.has(id) && !pinnedLoadRef.current.has(id))
    if (missing.length === 0) return
    for (const id of missing) pinnedLoadRef.current.add(id)
    void useAppStore
      .getState()
      .loadTurnRange(activeHostId, sessionId, missing)
      .then((ok) => {
        // 被其他取段占用而没成功时允许下次消息变化后重试。
        if (!ok) for (const id of missing) pinnedLoadRef.current.delete(id)
      })
  }, [pinnedTurns, messages, messagesProp, activeHostId, sessionId])

  // 挂载集合 = 窗口 [windowFrom, windowTo) + 固定轮（含该轮的 assistant 回复）。
  // 两段之间不连续的部分用固定高度占位条代替，已加载但未挂载与尚未加载分开标注。
  const pinnedSet = new Set(pinnedTurns)
  const selectedIndexes: number[] = []
  for (let i = windowFrom; i < windowTo; i++) selectedIndexes.push(i)
  messages.forEach((message, index) => {
    if (!pinnedSet.has(message.id)) return
    selectedIndexes.push(index)
    for (let i = index + 1; i < messages.length; i++) {
      const next = messages[i]!
      if (next.role === 'user' || next.gap) break
      selectedIndexes.push(i)
    }
  })
  const orderedIndexes = [...new Set(selectedIndexes)].sort((a, b) => a - b)
  const visibleMessages: UiMessage[] = []
  // 服务端还有更早的消息、而挂载窗口已经覆盖到第一条：顶部也放一条固定高度占位条。
  if (!messagesProp && hasEarlier && messages.length > 0 && !messages[0]!.gap) {
    visibleMessages.push(gapMessage({ beforeId: messages[0]!.id }))
  }
  let prevIndex = -1
  for (const index of orderedIndexes) {
    if (index > prevIndex + 1) {
      const skipped = messages.slice(prevIndex + 1, index)
      visibleMessages.push(
        gapMessage({
          ...(prevIndex >= 0 ? { afterId: messages[prevIndex]!.id } : {}),
          beforeId: messages[index]!.id,
          unmounted: skipped.every((message) => !message.gap),
        }),
      )
    }
    visibleMessages.push(messages[index]!)
    prevIndex = index
  }

  useEffect(() => {
    const state = seen.current
    if (!state.primed) {
      if (messages.length === 0) return
      state.primed = true
    }
    for (const m of messages) state.ids.add(m.id)
  }, [messages, sessionId])

  // 当前待处理的审批若在视野之外（用户上翻过），自动滚进来。
  // 必须放在 showSkeleton 的提前 return 之前：否则骨架屏与本体会调用不同数量的 Hook（R310）。
  const firstPendingId = permissions[0]?.id
  useEffect(() => {
    if (!firstPendingId) return
    const timer = window.setTimeout(() => {
      const card = rootRef.current?.querySelector<HTMLElement>(
        `[data-permission-id="${CSS.escape(firstPendingId)}"]`,
      )
      const box = scrollBox()
      if (!card || !box) return
      const c = card.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      if (c.top < b.top + 12) {
        box.scrollTo({ top: box.scrollTop + c.top - b.top - 12, behavior: 'smooth' })
      } else if (c.bottom > b.bottom - 12) {
        box.scrollTo({ top: box.scrollTop + c.bottom - b.bottom + 12, behavior: 'smooth' })
      }
    }, 120)
    return () => window.clearTimeout(timer)
  }, [firstPendingId, scrollBox])

  if (showSkeleton) return <SkeletonMessages />

  // 工具调用常常跨多条 assistant 消息（中间夹着隐藏的 tool_result）。
  // 连续、无文本的 assistant 消息合并成一个工具运行段。
  type Segment =
    | { kind: 'message'; message: UiMessage; animate: boolean }
    | { kind: 'notice'; message: UiMessage; animate: boolean }
    | { kind: 'gap'; message: UiMessage }
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
    if (m.gap) {
      flushRun()
      segments.push({ kind: 'gap', message: m })
      continue
    }
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
          <button data-raw-button
            key={child.id}
            type="button"
            onClick={() => navigate({ kind: 'session', hostId: activeHostId, sessionId: child.id })}
            className="inline-flex min-w-0 max-w-[280px] items-center gap-0.5 rounded px-1 py-0.5 text-left text-text-tertiary transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
            data-tip={`打开分叉会话：${child.title}`}
          >
            → <span className="truncate">{child.title || '未命名会话'}</span>
          </button>
        ))}
      </div>
    )
  }

  // 轮次序号以服务端大纲为全局基准：分页只加载了尾部时，本地从 0 数会错位。
  const turnIndex = new Map<string, number>()
  serverTurns?.forEach((mark, index) => turnIndex.set(mark.messageId, index))
  let turn = serverTurns?.length ?? 0
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (m.summary || m.gap) continue
    if (!hasUserContent(m)) continue
    if (turnIndex.has(m.id)) continue
    turnIndex.set(m.id, turn++)
  }

  // 占位条的轮次范围：取占位条两侧最近的已知用户轮次，区间内的轮都算未加载/未显示。
  const turnNoById = new Map<string, number>()
  serverTurns?.forEach((mark) => turnNoById.set(mark.messageId, mark.turn))
  const lastTurnNo = serverTurns?.length ?? 0
  const gapRangeAt = (index: number): { fromTurn?: number; toTurn?: number } => {
    if (!lastTurnNo) return {}
    let prevNo = 0
    for (let i = index - 1; i >= 0; i--) {
      const no = turnNoById.get(visibleMessages[i]!.id)
      if (no) {
        prevNo = no
        break
      }
    }
    let nextNo = lastTurnNo + 1
    for (let i = index + 1; i < visibleMessages.length; i++) {
      const no = turnNoById.get(visibleMessages[i]!.id)
      if (no) {
        nextNo = no
        break
      }
    }
    const fromTurn = prevNo + 1
    const toTurn = nextNo - 1
    return toTurn >= fromTurn ? { fromTurn, toTurn } : {}
  }
  const gapRanges = new Map<string, { fromTurn?: number; toTurn?: number }>()
  visibleMessages.forEach((message, index) => {
    if (message.gap) gapRanges.set(message.id, gapRangeAt(index))
  })

  /** 占位条「加载前 10 轮 / 全部」：按大纲里的轮次 id 逐段取回。 */
  const loadGapBand = (
    gap: NonNullable<UiMessage['gap']>,
    gapId: string,
    range: { fromTurn?: number; toTurn?: number },
    mode: 'first' | 'all',
  ) => {
    if (!sessionId || !activeHostId) return
    if (!serverTurns?.length || range.fromTurn === undefined || range.toTurn === undefined) {
      const real = messages.find(
        (message) =>
          message.gap?.beforeId === gap.beforeId &&
          (message.gap?.afterId ?? '') === (gap.afterId ?? ''),
      )
      if (real) fillGap(real.id)
      else void useAppStore.getState().loadEarlierMessages({ hostId: activeHostId, sessionId })
      return
    }
    const total = range.toTurn - range.fromTurn + 1
    const count = mode === 'first' ? Math.min(10, total) : total
    const ids = serverTurns
      .slice(range.fromTurn - 1, range.fromTurn - 1 + count)
      .map((mark) => mark.messageId)
    pendingAnchor.current = captureAnchor()
    setBandBusy(gapId)
    void useAppStore
      .getState()
      .loadTurnRange(activeHostId, sessionId, ids)
      .finally(() => setBandBusy(null))
  }

  /** 已加载但不在挂载窗口里：把窗口移到这一段，并停在原占位条位置。 */
  const showUnmounted = (gap: NonNullable<UiMessage['gap']>) => {
    const afterIndex = gap.afterId
      ? messages.findIndex((message) => message.id === gap.afterId)
      : -1
    const next = messages[afterIndex + 1] ?? messages[0]
    if (!next) return
    setWindowAnchorId(next.id)
    setWindowSize((size) => Math.max(size, Math.min(MAX_WINDOW, 320)))
    setWindowCap((cap) => Math.max(cap, Math.min(MAX_WINDOW, 320)))
    window.setTimeout(() => {
      scrollBox()
        ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(next.id)}"]`)
        ?.scrollIntoView({ block: 'start' })
    }, 60)
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

  // 反馈14#07：审批请求是对话流里的一条消息，渲染在触发它的工具调用之后；
  // 处理完的结果也按 toolUseId 留在原处，随消息一起滚动，不再停靠输入框上方。
  const pendingByTool = new Map<string, PermissionRequest[]>()
  for (const request of permissions) {
    const list = pendingByTool.get(request.toolUseId)
    if (list) list.push(request)
    else pendingByTool.set(request.toolUseId, [request])
  }
  const resultsByTool = new Map<string, PermissionTrailEntry[]>()
  for (const entry of permissionResults) {
    const list = resultsByTool.get(entry.toolUseId)
    if (list) list.push(entry)
    else resultsByTool.set(entry.toolUseId, [entry])
  }
  const placedPending = new Set<string>()
  const placedResults = new Set<string>()
  const activePermissionId = permissions[0]?.id
  const toolUseIdsOf = (message: UiMessage): string[] =>
    message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []))
  const permissionRows = (toolUseIds: string[]) => {
    const nodes: ReactNode[] = []
    for (const toolUseId of toolUseIds) {
      for (const entry of resultsByTool.get(toolUseId) ?? []) {
        if (placedResults.has(entry.id)) continue
        placedResults.add(entry.id)
        nodes.push(<PermissionResultLine key={`pr-${entry.id}`} entry={entry} />)
      }
      for (const request of pendingByTool.get(toolUseId) ?? []) {
        if (placedPending.has(request.id)) continue
        placedPending.add(request.id)
        nodes.push(
          <PermissionCard
            key={`pp-${request.id}`}
            request={request}
            active={request.id === activePermissionId}
          />,
        )
      }
    }
    return nodes
  }

  const segmentRows = segments.map((seg) => {
    if (seg.kind === 'run') {
      return (
        <Fragment key={seg.key}>
          <ToolRunRow
            messages={seg.messages}
            animate={seg.animate}
            streamingId={streamingId}
            toolResults={toolResults}
            cwd={cwd}
            runningToolIds={runningTools.ids}
          />
          {permissionRows(seg.messages.flatMap(toolUseIdsOf))}
        </Fragment>
      )
    }
    if (seg.kind === 'notice') {
      return (
        <NoticeRow
          key={seg.message.id}
          message={seg.message}
          animate={seg.animate}
          hostId={activeHostId}
          sessionId={storeSessionId}
        />
      )
    }
    if (seg.kind === 'gap') {
      const range = gapRanges.get(seg.message.id) ?? {}
      const gap = seg.message.gap!
      return (
        <GapBand
          key={seg.message.id}
          gap={gap}
          gapId={seg.message.id}
          fromTurn={range.fromTurn}
          toTurn={range.toTurn}
          loading={bandBusy === seg.message.id || loadingSegment}
          onLoad={(mode) => loadGapBand(gap, seg.message.id, range, mode)}
          onShow={() => showUnmounted(gap)}
        />
      )
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
      <Fragment key={m.id}>
        <AssistantRow
          message={m}
          streaming={!!streamingId && m.id === streamingId}
          animate={seg.animate}
          toolResults={toolResults}
          cwd={cwd}
          readOnly={readOnly}
          subagentId={subagentId}
          turnUser={turnUser}
          checkpointId={turnUser ? checkpoints?.get(turnUser.id) : undefined}
          runningToolIds={runningTools.ids}
          fork={forkLinks(m.id)}
          hook={hookLine(m.id)}
        />
        {permissionRows(toolUseIdsOf(m))}
      </Fragment>
    )
  })

  // 触发它们的工具调用不在当前挂载/加载范围内（子代理冒泡、历史未加载）：放到流末尾，
  // 保证审批准能处理。已渲染过的不会重复。
  const leftoverRows = [
    ...permissionResults
      .filter((entry) => !placedResults.has(entry.id))
      .map((entry) => <PermissionResultLine key={`pr-${entry.id}`} entry={entry} />),
    ...permissions
      .filter((request) => !placedPending.has(request.id))
      .map((request) => (
        <PermissionCard
          key={`pp-${request.id}`}
          request={request}
          active={request.id === activePermissionId}
        />
      )),
  ]

  return (
    <div ref={rootRef} className="flex flex-col gap-6 pb-2">
      {!messagesProp && <InjectionsNote cwd={cwd} />}
      {messages.length > MAX_WINDOW && windowSize < messages.length && windowSize < windowCap && (
        <div className="px-1 text-center text-[12px] text-muted" data-loading-history="true">
          正在载入更早的消息…
        </div>
      )}
      {segmentRows}
      {leftoverRows}
      {storeRunning &&
        !readOnly &&
        !messagesProp &&
        permissions.length === 0 &&
        activeHostId &&
        sessionId &&
        (runningTools.ids.size > 0 || !streamingId || !streamingStarted) && (
          <TurnActivity
            toolName={runningTools.name}
            since={storeSummaryUpdatedAt || Date.now()}
            runKey={`${activeHostId}:${sessionId}`}
          />
        )}
      {!messagesProp &&
        handoffStatus &&
        handoffStatus !== 'done' &&
        handoffStatus !== 'failed' && <HandoffCard />}
      {!messagesProp && orphanHooks.length > 0 && <HookNoticeLine notices={orphanHooks} />}
    </div>
  )
}

