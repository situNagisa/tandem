import { useEffect, useRef } from 'react'
import type { ContentBlock } from '@tandem/protocol'
import { Bot, Square } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { Button } from '../ui/Button'
import { useAppStore } from '../../store/useAppStore'
import { useSessionTarget, useSessionView } from '../session/SessionScope'
import { ReadOnlySessionGraph } from '../sessionGraph/SessionGraphCard'
import { Markdown } from '../Markdown'
import { ThinkingBlock } from '../ThinkingBlock'
import { cn } from '../../lib/cn'
import { ToolCard } from '../ToolCard'
import { AgentElapsed, agentKind } from './helpers'

export function SubagentStream({ id, depth }: { id: string; depth: number }) {
  const scopeTarget = useSessionTarget() ?? undefined
  const sub = useSessionView((s) => s?.subagents[id])
  const stopSubagent = useAppStore((s) => s.interruptSubagent)
  const listRef = useRef<HTMLDivElement>(null)
  const subDepth = sub?.summary?.depth ?? depth
  useEffect(() => {
    if (!sub?.running) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sub?.running, sub?.messages.length])
  if (!sub) {
    return <div className="py-2 text-[12px] text-muted">正在等待{agentKind()}会话…</div>
  }
  const subFailed = sub.summary?.status === 'error' || !!sub.error
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border bg-[var(--t-bg)]',
        subDepth > 1 && 'border-l-2 border-l-border/80',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-1.5 text-[11px] text-muted">
        {sub.summary?.model && (
          <span className="max-w-[150px] shrink-0 truncate font-mono" data-tip={`模型：${sub.summary.model}`}>
            {sub.summary.model}
          </span>
        )}
        {sub.running ? (
          <Spinner size={12} className="shrink-0 text-text-secondary" />
        ) : (
          <Bot
            size={12}
            className={subFailed ? 'text-danger' : 'text-muted'}
          />
        )}
        <span>{agentKind()}会话</span>
        <span
          className={cn(
            sub.running ? 'text-text-secondary' : subFailed ? 'text-danger' : '',
          )}
        >
          {sub.running ? (
            <>
              运行中
              <AgentElapsed
                id={id}
                since={sub.summary?.createdAt ?? Date.now()}
                running
              />
            </>
          ) : sub.loading ? (
            '加载中…'
          ) : subFailed ? (
            '出错'
          ) : (
            '已结束'
          )}
        </span>
        <span className="flex-1" />
        {sub.running && (
          <Button
            size="sm"
            variant="danger-ghost"
            onClick={() => stopSubagent(id, scopeTarget)}
            className="h-6! gap-1 px-1.5 text-[11px] [&_svg]:size-[9px]"
          >
            <Square size={9} /> 停止{agentKind()}
          </Button>
        )}
      </div>
      {sub.messages.length > 1 && (
        <div className="border-b border-border/70 px-2.5 pb-1 pt-1.5">
          <ReadOnlySessionGraph
            messages={sub.messages}
            height={104}
            onOpen={() => {
              // 子代理视图内部不需要再跳回主会话。
            }}
          />
        </div>
      )}
      <div ref={listRef} className="max-h-[380px] space-y-2.5 overflow-y-auto px-2.5 py-2">
        {sub.messages.length === 0 && (
          <div className="shimmer-text py-1 text-[12px] text-muted">
            {sub.loading ? '正在读取子会话…' : '暂无消息'}
          </div>
        )}
        {sub.messages.map((m) => {
          if (m.role === 'user') {
            const text = m.content
              .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
              .map((b) => b.text)
              .join('\n\n')
            if (!text.trim()) return null
            return (
              <div key={m.id} className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12px] leading-5 text-text-soft">
                <div className="mb-0.5 text-[11px] text-muted">任务提示词</div>
                <div className="whitespace-pre-wrap break-words">{text}</div>
              </div>
            )
          }
          return (
            <div key={m.id} className="space-y-0.5">
              {m.content.map((b, i) => {
                if (b.type === 'text') {
                  return b.text.trim() ? (
                    <div key={i} className="text-[12px] leading-5">
                      <Markdown
                        text={b.text}
                        streaming={sub.running && m.id === sub.streamingMessageId && i === m.content.length - 1}
                      />
                    </div>
                  ) : null
                }
                if (b.type === 'thinking') {
                  return <ThinkingBlock key={i} text={b.text} streaming={sub.running && i === m.content.length - 1} />
                }
                if (b.type === 'tool_use') {
                  return (
                    <ToolCard
                      key={b.id}
                      block={b}
                      messageId={m.id}
                      index={i}
                      subagentId={id}
                      streaming={sub.running && m.id === sub.streamingMessageId}
                    />
                  )
                }
                return null
              })}
            </div>
          )
        })}
        {sub.error && <div className="text-[12px] text-danger">{sub.error}</div>}
      </div>
    </div>
  )
}

