import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ContentBlock } from '@tandem/protocol'
import {
  Check,
  Copy,
  Loader2,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  Undo2,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { cn } from '../lib/cn'
import { copyText } from '../lib/clipboard'
import { formatCost, formatTokens } from '../lib/format'
import type { HookNotice, ToolResultBlock, UiMessage } from '../lib/types'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCard, type ToolUseBlock } from './ToolCard'
import { RewindDialog } from './RewindDialog'
import { Popover } from './ui/Popover'
import { Tip } from './ui/Tooltip'
import { MenuItem, MenuList } from './ui/Menu'
import { Button, IconButton } from './ui/Button'
import {
  ToolGroup,
  entriesFromMessages,
  type ToolRunEntry,
} from './chat/ToolGroup'
import { HookNoticeLine } from './chat/HookNoticeLine'
import '../styles/chat.css'

const EMPTY: UiMessage[] = []
const EMPTY_HOOKS: HookNotice[] = []

function TypingIndicator() {
  return (
    <div className="thinking-dots flex items-center gap-1 py-2" aria-label="正在回复">
      <span />
      <span />
      <span />
    </div>
  )
}

function dataUrl(block: Extract<ContentBlock, { type: 'image' }>): string {
  return `data:${block.mediaType};base64,${block.dataBase64}`
}

export const UserMessage = memo(function UserMessage({
  message,
  animate,
  readOnly = false,
}: {
  message: UiMessage
  animate: boolean
  readOnly?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [rewindOpen, setRewindOpen] = useState(false)
  const running = useAppStore((s) => s.active?.running ?? false)
  const timer = useRef<number | null>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const blocks = message.content.filter((b) => b.type !== 'tool_result')
  const images = blocks.filter(
    (b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image',
  )
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )

  useEffect(() => {
    if (!editing) return
    const el = editRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  if (!text.trim() && images.length === 0) return null

  const copy = async () => {
    if (!(await copyText(text))) return
    setCopied(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  const startEdit = () => {
    setDraft(text)
    setEditing(true)
  }

  const submitEdit = () => {
    const next = draft.trim()
    if (!next) return
    if (next === text.trim()) {
      setEditing(false)
      return
    }
    if (useAppStore.getState().send([{ type: 'text', text: next }])) {
      setEditing(false)
    }
  }

  return (
    <div className={cn('msg-group flex justify-end', animate && 'chat-msg-enter')}>
      <div className="relative min-w-0 max-w-[80%]">
        {images.length > 0 && (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {images.map((img, i) => (
              <img
                key={i}
                src={dataUrl(img)}
                alt={`图片 ${i + 1}`}
                className="max-h-64 max-w-full rounded-[14px] border border-border object-contain"
              />
            ))}
          </div>
        )}
        {editing ? (
          <div className="rounded-[14px] bg-surface-2 px-3 py-2.5 text-left">
            <textarea
              ref={editRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditing(false)
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  submitEdit()
                }
              }}
              rows={3}
              aria-label="编辑并重发"
              className="min-h-16 w-full resize-y bg-transparent text-[14.5px] leading-[1.68] text-text outline-none"
            />
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                取消
              </Button>
              <Button size="sm" variant="primary" onClick={submitEdit} disabled={!draft.trim()}>
                编辑并重发
              </Button>
            </div>
          </div>
        ) : (
          text.trim() && (
            <div className="whitespace-pre-wrap break-words rounded-[14px] bg-surface-2 px-4 py-2.5 text-[14.5px] leading-[1.68] text-text">
              {text}
            </div>
          )
        )}
        {text.trim() && !editing && (
          <>
            <div className="msg-actions mt-0.5 flex h-7 justify-end gap-0.5">
              <IconButton
                size="sm"
                onClick={copy}
                label={copied ? '已复制' : '复制消息'}
                tooltip={copied ? '已复制' : '复制'}
                className="[&_svg]:size-[12.5px]"
              >
                {copied ? <Check size={12.5} className="text-success" /> : <Copy size={12.5} />}
              </IconButton>
              {!readOnly && (
                <>
                  <IconButton
                    size="sm"
                    onClick={startEdit}
                    label="编辑并重发"
                    className="[&_svg]:size-[12.5px]"
                  >
                    <PencilLine size={12.5} />
                  </IconButton>
                  <IconButton
                    size="sm"
                    onClick={() => setRewindOpen(true)}
                    disabled={running}
                    label="回退到此处"
                    tooltip={running ? '会话运行中，结束后才能回退' : '回退到此处'}
                    className="[&_svg]:size-[12.5px]"
                  >
                    <Undo2 size={12.5} />
                  </IconButton>
                </>
              )}
            </div>
            <div className="msg-more mt-0.5 h-7 justify-end max-md:h-11">
              {readOnly ? (
                <IconButton
                  onClick={() => void copy()}
                  label={copied ? '已复制' : '复制消息'}
                  className="[&_svg]:size-[13px] max-md:size-11 [&_svg]:max-md:size-[17px]"
                >
                  {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                </IconButton>
              ) : (
              <Popover
                align="right"
                side="top"
                padded={false}
                trigger={({ open, toggle }) => (
                  <IconButton onClick={toggle} label="消息操作" tooltip={open ? '' : undefined} className="[&_svg]:size-[15px] max-md:size-11 [&_svg]:max-md:size-[17px]">
                    <MoreHorizontal size={15} />
                  </IconButton>
                )}
              >
                {(close) => (
                  <MenuList aria-label="消息操作">
                    <MenuItem
                      icon={<Copy />}
                      onSelect={() => {
                        close()
                        void copy()
                      }}
                    >
                      {copied ? '已复制' : '复制消息'}
                    </MenuItem>
                    <MenuItem
                      icon={<PencilLine />}
                      onSelect={() => {
                        close()
                        startEdit()
                      }}
                    >
                      编辑并重发
                    </MenuItem>
                    <MenuItem
                      icon={<Undo2 />}
                      disabled={running}
                      hint={running ? '会话运行中，结束后才能回退' : undefined}
                      onSelect={() => {
                        close()
                        setRewindOpen(true)
                      }}
                    >
                      回退到此处
                    </MenuItem>
                  </MenuList>
                )}
              </Popover>
              )}
            </div>
          </>
        )}
        {message.queued && (
          <div className="mt-1 text-right text-[11px] text-muted">已排队，当前回合结束后发送</div>
        )}
      </div>
      {rewindOpen && (
        <RewindDialog message={message} onClose={() => setRewindOpen(false)} />
      )}
    </div>
  )
})

export const AssistantMessage = memo(function AssistantMessage({
  message,
  streaming,
  animate,
  toolResults,
  cwd,
  readOnly = false,
  turnUser,
  checkpointId,
}: {
  message: UiMessage
  streaming: boolean
  animate: boolean
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
  readOnly?: boolean
  /** 本轮对应的用户消息；助理消息的操作条以它为回退/重新生成的锚点。 */
  turnUser?: UiMessage
  /** 本轮用户消息对应的检查点 id。 */
  checkpointId?: string
}) {
  const lastIndex = message.content.length - 1
  const [copied, setCopied] = useState(false)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const running = useAppStore((s) => s.active?.running ?? false)
  const copyTimer = useRef<number | null>(null)
  const rawText = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const copyAll = async () => {
    if (!(await copyText(rawText))) return
    setCopied(true)
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  const regenerate = async () => {
    if (!turnUser || !checkpointId || regenerating || running) return
    setRegenerating(true)
    const store = useAppStore.getState()
    const ok = await store.rewind({
      checkpointId,
      restoreFiles: false,
      restoreConversation: true,
    })
    if (ok) store.send(turnUser.content.filter((b) => b.type !== 'tool_result'))
    setRegenerating(false)
  }

  const rendered: ReactNode[] = []
  let i = 0
  while (i < message.content.length) {
    const block = message.content[i]
    if (block.type === 'text') {
      if (block.text) {
        rendered.push(
          <Markdown
            key={`${message.id}-t-${i}`}
            text={block.text}
            streaming={streaming && i === lastIndex}
            cwd={cwd}
          />,
        )
      }
      i++
      continue
    }
    if (block.type === 'thinking') {
      rendered.push(
        <ThinkingBlock
          key={`${message.id}-k-${i}`}
          text={block.text}
          streaming={streaming && i === lastIndex}
        />,
      )
      i++
      continue
    }
    if (block.type === 'tool_use') {
      let j = i
      while (j < message.content.length && message.content[j].type === 'tool_use') j++
      const run: ToolRunEntry[] = message.content.slice(i, j).map((b, k) => ({
        kind: 'tool',
        block: b as ToolUseBlock,
        index: i + k,
        messageId: message.id,
        streaming,
      }))
      if (run.length >= 3) {
        rendered.push(
          <ToolGroup
            key={`${message.id}-g-${i}`}
            entries={run}
            toolResults={toolResults}
            cwd={cwd}
          />,
        )
      } else {
        for (const item of run) {
          if (item.kind !== 'tool') continue
          rendered.push(
            <ToolCard
              key={`${message.id}-u-${item.index}-${item.block.id}`}
              block={item.block}
              messageId={message.id}
              index={item.index}
              streaming={streaming}
              toolResults={toolResults}
              cwd={cwd}
            />,
          )
        }
      }
      i = j
      continue
    }
    i++
  }

  return (
    <div className={cn('msg-group relative flex flex-col', animate && 'chat-msg-enter')}>
      {rendered}
      {message.content.length === 0 && streaming && <TypingIndicator />}
      {rawText.trim() && !streaming && (
        <>
          <div className="msg-actions mt-0.5 flex h-7 justify-start gap-0.5">
            <IconButton
              size="sm"
              onClick={copyAll}
              label={copied ? '已复制' : '复制整条回复'}
              tooltip={copied ? '已复制' : '复制整条回复（Markdown）'}
              className="[&_svg]:size-[12.5px]"
            >
              {copied ? <Check size={12.5} className="text-success" /> : <Copy size={12.5} />}
            </IconButton>
            {!readOnly && turnUser && checkpointId && (
              <IconButton
                size="sm"
                onClick={() => setRewindOpen(true)}
                disabled={running}
                label="回退到此处"
                tooltip={running ? '会话运行中，结束后才能回退' : '回退到此处'}
                className="[&_svg]:size-[12.5px]"
              >
                <Undo2 size={12.5} />
              </IconButton>
            )}
            {!readOnly && turnUser && checkpointId && (
              <IconButton
                size="sm"
                onClick={() => void regenerate()}
                disabled={running || regenerating}
                label="重新生成"
                tooltip={running ? '会话运行中，结束后才能重新生成' : '重新生成'}
                className="[&_svg]:size-[12.5px]"
              >
                {regenerating ? (
                  <Loader2 size={12.5} className="animate-spin" />
                ) : (
                  <RefreshCw size={12.5} />
                )}
              </IconButton>
            )}
            {message.usage && (
              <span className="relative ml-auto flex cursor-default items-center pr-1 font-mono text-[10.5px] tabular-nums text-muted">
                {formatTokens(message.usage.inputTokens)} → {formatTokens(message.usage.outputTokens)}
                {message.usage.costUsd !== undefined && ` · ${formatCost(message.usage.costUsd)}`}
                <Tip
                  side="top"
                  label={[
                    `未命中输入 ${Math.round(message.usage.inputTokens).toLocaleString('en-US')}`,
                    `缓存读 ${Math.round(message.usage.cacheReadTokens ?? 0).toLocaleString('en-US')}`,
                    `缓存写 ${Math.round(message.usage.cacheWriteTokens ?? 0).toLocaleString('en-US')}`,
                    `输出 ${Math.round(message.usage.outputTokens).toLocaleString('en-US')}`,
                    `推理 ${Math.round(message.usage.reasoningTokens ?? 0).toLocaleString('en-US')}`,
                    `花费 ${formatCost(message.usage.costUsd)}`,
                    `模型 ${message.model ?? '未知'}`,
                  ].join(' · ')}
                />
              </span>
            )}
          </div>
          <div className="msg-more mt-0.5 h-7 justify-start max-md:h-11">
            <Popover
              align="left"
              side="bottom"
              padded={false}
              trigger={({ open, toggle }) => (
                <IconButton onClick={toggle} label="回复操作" tooltip={open ? '' : undefined} className="[&_svg]:size-[15px] max-md:size-11 [&_svg]:max-md:size-[17px]">
                  <MoreHorizontal size={15} />
                </IconButton>
              )}
            >
              {(close) => (
                <MenuList aria-label="回复操作">
                  <MenuItem
                    icon={<Copy />}
                    onSelect={() => {
                      close()
                      void copyAll()
                    }}
                  >
                    {copied ? '已复制' : '复制整条回复'}
                  </MenuItem>
                  {!readOnly && turnUser && checkpointId && (
                    <MenuItem
                      icon={<Undo2 />}
                      disabled={running}
                      hint={running ? '会话运行中，结束后才能回退' : undefined}
                      onSelect={() => {
                        close()
                        setRewindOpen(true)
                      }}
                    >
                      回退到此处
                    </MenuItem>
                  )}
                  {!readOnly && turnUser && checkpointId && (
                    <MenuItem
                      icon={<RefreshCw />}
                      disabled={running || regenerating}
                      hint={running ? '会话运行中，结束后才能重新生成' : undefined}
                      onSelect={() => {
                        close()
                        void regenerate()
                      }}
                    >
                      重新生成
                    </MenuItem>
                  )}
                </MenuList>
              )}
            </Popover>
          </div>
        </>
      )}
      {rewindOpen && turnUser && (
        <RewindDialog message={turnUser} onClose={() => setRewindOpen(false)} />
      )}
    </div>
  )
})

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

  const turnIndex = new Map<string, number>()
  let turn = 0
  for (const m of messages) {
    if (m.role !== 'user') continue
    if (m.content.every((b) => b.type === 'tool_result')) continue
    turnIndex.set(m.id, turn++)
  }

  // 助理消息的操作条以它前面最近一条可见用户消息作为本轮锚点。
  const turnUserByAssistant = new Map<string, UiMessage>()
  let lastUser: UiMessage | undefined
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content.some((b) => b.type !== 'tool_result')) lastUser = m
    } else if (lastUser) {
      turnUserByAssistant.set(m.id, lastUser)
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-2">
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
                'msg-row px-1 text-[11px] leading-4 text-muted',
                seg.animate && 'chat-msg-enter',
              )}
            >
              {text}
            </div>
          )
        }
        const m = seg.message
        if (m.role === 'user') {
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
              <UserMessage message={m} animate={seg.animate} readOnly={readOnly} />
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
            {hookLine(m.id)}
          </div>
        )
      })}
      {!messagesProp && orphanHooks.length > 0 && <HookNoticeLine notices={orphanHooks} />}
    </div>
  )
}
