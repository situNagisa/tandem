import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ContentBlock } from '@tandem/protocol'
import { Check, Copy } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { cn } from '../lib/cn'
import { copyText } from '../lib/clipboard'
import type { UiMessage } from '../lib/types'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCard, type ToolUseBlock } from './ToolCard'
import {
  ToolGroup,
  entriesFromMessages,
  type ToolRunEntry,
} from './chat/ToolGroup'

const EMPTY: UiMessage[] = []

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
}: {
  message: UiMessage
  animate: boolean
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  const blocks = message.content.filter((b) => b.type !== 'tool_result')
  const images = blocks.filter(
    (b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image',
  )
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
  if (!text.trim() && images.length === 0) return null

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )

  const copy = async () => {
    if (!(await copyText(text))) return
    setCopied(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={cn('msg-group flex justify-end', animate && 'chat-msg-enter')}>
      <div className="relative min-w-0 max-w-[85%]">
        {images.length > 0 && (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {images.map((img, i) => (
              <img
                key={i}
                src={dataUrl(img)}
                alt={`图片 ${i + 1}`}
                className="max-h-64 max-w-full rounded-xl border border-border object-contain"
              />
            ))}
          </div>
        )}
        {text.trim() && (
          <div className="whitespace-pre-wrap break-words rounded-2xl bg-surface-2 px-4 py-2.5 text-[15px] leading-[1.65] text-text">
            {text}
          </div>
        )}
        {text.trim() && (
          <button
            onClick={copy}
            aria-label={copied ? '已复制' : '复制消息'}
            title={copied ? '已复制' : '复制'}
            className="msg-copy absolute -left-8 bottom-1 flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-hover hover:text-text-soft"
          >
            {copied ? <Check size={12.5} className="text-success" /> : <Copy size={12.5} />}
          </button>
        )}
        {message.queued && (
          <div className="mt-1 text-right text-[11px] text-muted">已排队，当前回合结束后发送</div>
        )}
      </div>
    </div>
  )
})

export const AssistantMessage = memo(function AssistantMessage({
  message,
  streaming,
  animate,
}: {
  message: UiMessage
  streaming: boolean
  animate: boolean
}) {
  const lastIndex = message.content.length - 1
  const lastBlock = message.content[lastIndex]

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
        rendered.push(<ToolGroup key={`${message.id}-g-${i}`} entries={run} />)
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
    <div className={cn('flex flex-col', animate && 'chat-msg-enter')}>
      {rendered}
      {message.content.length === 0 && streaming && <TypingIndicator />}
      {streaming && lastBlock?.type === 'thinking' && !lastBlock.text && <TypingIndicator />}
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

export function MessageList({ showSkeleton }: { showSkeleton?: boolean }) {
  const messages = useAppStore((s) => s.active?.messages ?? EMPTY)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const streamingId = useAppStore((s) => s.active?.streamingMessageId)

  // 首屏加载的消息不播放进入动画；之后新增的消息才淡入上移。
  const seen = useRef<{ sessionId: string | null; primed: boolean; ids: Set<string> }>({
    sessionId: null,
    primed: false,
    ids: new Set(),
  })
  if (seen.current.sessionId !== sessionId) {
    seen.current = { sessionId, primed: false, ids: new Set() }
  }
  const animateIds = new Set<string>()
  if (seen.current.primed) {
    for (const m of messages) if (!seen.current.ids.has(m.id)) animateIds.add(m.id)
  }

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

  return (
    <div className="flex flex-col gap-6 pb-2">
      {segments.map((seg) => {
        if (seg.kind === 'run') {
          return (
            <ToolGroup
              key={seg.key}
              entries={entriesFromMessages(seg.messages, streamingId)}
              animate={seg.animate}
            />
          )
        }
        const m = seg.message
        if (m.role === 'user') {
          return <UserMessage key={m.id} message={m} animate={seg.animate} />
        }
        return (
          <AssistantMessage
            key={m.id}
            message={m}
            streaming={!!streamingId && m.id === streamingId}
            animate={seg.animate}
          />
        )
      })}
    </div>
  )
}
