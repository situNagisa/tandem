import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ContentBlock } from '@tandem/protocol'
import { Check, Copy, PencilLine, Undo2 } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { cn } from '../lib/cn'
import { copyText } from '../lib/clipboard'
import type { UiMessage } from '../lib/types'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCard, type ToolUseBlock } from './ToolCard'
import { RewindDialog } from './RewindDialog'
import {
  ToolGroup,
  entriesFromMessages,
  type ToolRunEntry,
} from './chat/ToolGroup'
import '../styles/chat.css'

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
        {editing ? (
          <div className="rounded-2xl bg-surface-2 px-3 py-2.5 text-left">
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
              className="min-h-16 w-full resize-y bg-transparent text-[15px] leading-[1.65] text-text outline-none"
            />
            <div className="mt-1 flex items-center justify-end gap-1.5">
              <button
                onClick={() => setEditing(false)}
                className="rounded-md px-2 py-1 text-[11.5px] text-muted transition-colors hover:bg-bg-hover hover:text-text"
              >
                取消
              </button>
              <button
                onClick={submitEdit}
                disabled={!draft.trim()}
                className="rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                编辑并重发
              </button>
            </div>
          </div>
        ) : (
          text.trim() && (
            <div className="whitespace-pre-wrap break-words rounded-2xl bg-surface-2 px-4 py-2.5 text-[15px] leading-[1.65] text-text">
              {text}
            </div>
          )
        )}
        {text.trim() && !editing && (
          <div className="msg-actions absolute -left-9 bottom-0 flex flex-col gap-0.5">
            <button
              onClick={copy}
              aria-label={copied ? '已复制' : '复制消息'}
              title={copied ? '已复制' : '复制'}
              className="flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-hover hover:text-text-soft md:size-7"
            >
              {copied ? <Check size={12.5} className="text-success" /> : <Copy size={12.5} />}
            </button>
            <button
              onClick={startEdit}
              aria-label="编辑并重发"
              title="编辑并重发"
              className="flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-hover hover:text-text-soft md:size-7"
            >
              <PencilLine size={12.5} />
            </button>
            <button
              onClick={() => setRewindOpen(true)}
              disabled={running}
              aria-label="回退到此处"
              title={running ? '会话运行中，结束后才能回退' : '回退到此处'}
              className="flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-hover hover:text-text-soft disabled:cursor-not-allowed disabled:opacity-40 md:size-7"
            >
              <Undo2 size={12.5} />
            </button>
          </div>
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
}: {
  message: UiMessage
  streaming: boolean
  animate: boolean
}) {
  const lastIndex = message.content.length - 1
  const [copied, setCopied] = useState(false)
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
    <div className={cn('msg-group relative flex flex-col', animate && 'chat-msg-enter')}>
      {rendered}
      {message.content.length === 0 && streaming && <TypingIndicator />}
      {rawText.trim() && (
        <button
          onClick={copyAll}
          aria-label={copied ? '已复制' : '复制整条回复'}
          title={copied ? '已复制' : '复制整条回复（Markdown）'}
          className="msg-actions absolute bottom-1 right-1 z-10 flex size-7 items-center justify-center rounded-md border border-border/70 bg-surface/90 text-muted shadow-sm backdrop-blur-sm transition-colors hover:bg-bg-hover hover:text-text-soft"
        >
          {copied ? <Check size={12.5} className="text-success" /> : <Copy size={12.5} />}
        </button>
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

export function MessageList({ showSkeleton }: { showSkeleton?: boolean }) {
  const messages = useAppStore((s) => s.active?.messages ?? EMPTY)
  const sessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const streamingId = useAppStore((s) => s.active?.streamingMessageId)

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
            <div key={seg.key} className="msg-row">
              <ToolGroup
                entries={entriesFromMessages(seg.messages, streamingId)}
                animate={seg.animate}
              />
            </div>
          )
        }
        const m = seg.message
        if (m.role === 'user') {
          return (
            <div key={m.id} className="msg-row">
              <UserMessage message={m} animate={seg.animate} />
            </div>
          )
        }
        return (
          <div key={m.id} className="msg-row">
            <AssistantMessage
              message={m}
              streaming={!!streamingId && m.id === streamingId}
              animate={seg.animate}
            />
          </div>
        )
      })}
    </div>
  )
}
