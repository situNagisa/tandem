import { memo } from 'react'
import type { ContentBlock } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { cn } from '../lib/cn'
import type { UiMessage } from '../lib/types'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCard } from './ToolCard'

const EMPTY: UiMessage[] = []

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 py-1.5" aria-label="正在回复">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-muted"
          style={{ animationDelay: `${i * 120}ms`, animationDuration: '1s' }}
        />
      ))}
    </div>
  )
}

function dataUrl(block: Extract<ContentBlock, { type: 'image' }>): string {
  return `data:${block.mediaType};base64,${block.dataBase64}`
}

export const UserMessage = memo(function UserMessage({ message }: { message: UiMessage }) {
  const blocks = message.content.filter((b) => b.type !== 'tool_result')
  const images = blocks.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
  if (!text.trim() && images.length === 0) return null

  return (
    <div className="anim-fade-in flex justify-end">
      <div className="max-w-[88%] md:max-w-[76%]">
        {images.length > 0 && (
          <div
            className={cn(
              'mb-1.5 flex flex-wrap justify-end gap-1.5',
              images.length === 1 && 'justify-end',
            )}
          >
            {images.map((img, i) => (
              <img
                key={i}
                src={dataUrl(img)}
                alt={`图片 ${i + 1}`}
                className="max-h-56 max-w-full rounded-xl border border-border object-contain"
              />
            ))}
          </div>
        )}
        {text.trim() && (
          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-border bg-surface-2/85 px-3.5 py-2.5 text-[14px] leading-6 text-text shadow-[0_1px_2px_rgba(40,30,20,0.05)]">
            {text}
          </div>
        )}
        {message.queued && (
          <div className="mt-1 text-right text-[10.5px] text-muted">已排队，当前回合结束后发送</div>
        )}
      </div>
    </div>
  )
})

export const AssistantMessage = memo(function AssistantMessage({
  message,
  streaming,
}: {
  message: UiMessage
  streaming: boolean
}) {
  const lastIndex = message.content.length - 1
  const lastBlock = message.content[lastIndex]
  const showCaret = streaming && lastBlock?.type === 'text' && !!lastBlock.text

  return (
    <div className="anim-fade-in">
      {message.content.map((block, i) => {
        if (block.type === 'text') {
          if (!block.text) return null
          return <Markdown key={`${message.id}-t-${i}`} text={block.text} />
        }
        if (block.type === 'thinking') {
          return (
            <ThinkingBlock
              key={`${message.id}-k-${i}`}
              text={block.text}
              streaming={streaming && i === lastIndex}
            />
          )
        }
        if (block.type === 'tool_use') {
          return (
            <ToolCard
              key={`${message.id}-u-${i}-${block.id}`}
              block={block}
              messageId={message.id}
              index={i}
              streaming={streaming}
            />
          )
        }
        return null
      })}
      {message.content.length === 0 && streaming && <TypingIndicator />}
      {showCaret && <span className="stream-caret" aria-hidden="true" />}
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
  const streamingId = useAppStore((s) => s.active?.streamingMessageId)

  if (showSkeleton) return <SkeletonMessages />

  return (
    <div className="space-y-5 pb-2">
      {messages.map((m) => {
        if (m.role === 'user') {
          const visible = m.content.filter((b) => b.type !== 'tool_result')
          if (visible.length === 0) return null
          return <UserMessage key={m.id} message={m} />
        }
        return (
          <AssistantMessage
            key={m.id}
            message={m}
            streaming={!!streamingId && m.id === streamingId}
          />
        )
      })}
    </div>
  )
}
