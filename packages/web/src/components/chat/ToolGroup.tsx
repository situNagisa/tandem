import { memo, useEffect, useState } from 'react'
import { ChevronRight, Layers, Loader2 } from 'lucide-react'
import type { UiMessage } from '../../lib/types'
import { useAppStore } from '../../store/useAppStore'
import { cn } from '../../lib/cn'
import { ThinkingBlock } from '../ThinkingBlock'
import { ToolCard, type ToolUseBlock } from '../ToolCard'

export type ToolRunEntry =
  | {
      kind: 'tool'
      block: ToolUseBlock
      index: number
      messageId: string
      streaming: boolean
    }
  | { kind: 'thinking'; text: string; streaming: boolean }

function sameEntry(a: ToolRunEntry, b: ToolRunEntry): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'thinking' && b.kind === 'thinking') {
    return a.text === b.text && a.streaming === b.streaming
  }
  if (a.kind === 'tool' && b.kind === 'tool') {
    return (
      a.block === b.block &&
      a.index === b.index &&
      a.messageId === b.messageId &&
      a.streaming === b.streaming
    )
  }
  return false
}

function sameEntries(a: ToolRunEntry[], b: ToolRunEntry[]): boolean {
  return a.length === b.length && a.every((entry, i) => sameEntry(entry, b[i]))
}

/** 连续 3 个以上工具调用折叠成一行，展开后按原顺序显示思考与工具详情。 */
export const ToolGroup = memo(
  function ToolGroup({
    entries,
    animate,
  }: {
    entries: ToolRunEntry[]
    animate?: boolean
  }) {
    const [open, setOpen] = useState(false)
    const results = useAppStore((s) => s.active?.toolResults)
    const tools = entries.filter(
      (e): e is Extract<ToolRunEntry, { kind: 'tool' }> => e.kind === 'tool',
    )
    const anyRunning = tools.some((t) => t.streaming && !results?.[t.block.id])
    const anyError = tools.some((t) => results?.[t.block.id]?.isError)

    useEffect(() => {
      if (anyError) setOpen(true)
    }, [anyError])

    return (
      <div className={cn('my-0.5', animate && 'chat-msg-enter')}>
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="tool-row">
          {anyRunning ? (
            <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
          ) : (
            <Layers
              size={14}
              className={cn('shrink-0', anyError ? 'text-danger' : 'text-muted')}
            />
          )}
          <span className={cn('shrink-0', anyError && 'text-danger')}>
            使用了 {tools.length} 个工具
          </span>
          {anyError && <span className="shrink-0 text-[11.5px] text-danger">· 有错误</span>}
          <ChevronRight size={12} className="tool-chevron ml-auto shrink-0 text-muted" />
        </button>
        <div className="collapse-grid" data-open={open}>
          <div className="collapse-inner">
            <div className="my-1 ml-1.5 border-l border-border py-0.5 pl-2">
              {entries.map((entry, i) =>
                entry.kind === 'thinking' ? (
                  <ThinkingBlock key={`k-${i}`} text={entry.text} streaming={entry.streaming} />
                ) : (
                  <ToolCard
                    key={`${entry.messageId}-u-${entry.index}-${entry.block.id}`}
                    block={entry.block}
                    messageId={entry.messageId}
                    index={entry.index}
                    streaming={entry.streaming}
                  />
                ),
              )}
            </div>
          </div>
        </div>
      </div>
    )
  },
  (prev, next) =>
    prev.animate === next.animate && sameEntries(prev.entries, next.entries),
)

/** 把一组 assistant 消息里的思考与工具块按原顺序摊平。 */
export function entriesFromMessages(messages: UiMessage[], streamingId?: string): ToolRunEntry[] {
  const entries: ToolRunEntry[] = []
  for (const m of messages) {
    const streaming = !!streamingId && m.id === streamingId
    const lastIndex = m.content.length - 1
    m.content.forEach((block, i) => {
      if (block.type === 'tool_use') {
        entries.push({ kind: 'tool', block, index: i, messageId: m.id, streaming })
      } else if (block.type === 'thinking' && block.text) {
        entries.push({
          kind: 'thinking',
          text: block.text,
          streaming: streaming && i === lastIndex,
        })
      }
    })
  }
  return entries
}
