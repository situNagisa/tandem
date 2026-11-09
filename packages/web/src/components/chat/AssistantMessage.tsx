import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ContentBlock } from '@tandem/protocol'
import { Check, Copy, GitFork, Loader2, MoreHorizontal, RefreshCw, Undo2 } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useSessionTarget, useSessionView } from '../session/SessionScope'
import { cn } from '../../lib/cn'
import { copyText } from '../../lib/clipboard'
import { formatCost, formatDurationMs, formatTokens } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import type { ToolResultBlock, UiMessage } from '../../lib/types'
import { Markdown } from '../Markdown'
import { ThinkingBlock } from '../ThinkingBlock'
import { ToolCard, type ToolUseBlock } from '../ToolCard'
import { RewindDialog } from '../RewindDialog'
import { Menu } from '../ui/Menu'
import { IconButton } from '../ui/Button'
import { ToolGroup, type ToolRunEntry } from './ToolGroup'
import { MessageTime, UsageLine } from './UsageLine'

export const AssistantMessage = memo(function AssistantMessage({
  message,
  streaming,
  animate,
  toolResults,
  cwd,
  readOnly = false,
  subagentId,
  turnUser,
  checkpointId,
  runningToolIds,
}: {
  message: UiMessage
  streaming: boolean
  animate: boolean
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
  readOnly?: boolean
  /** 子代理只读视图中渲染时传入，让 Task 卡片定位下一层子会话。 */
  subagentId?: string
  /** 本轮对应的用户消息；助理消息的操作条以它为回退/重新生成的锚点。 */
  turnUser?: UiMessage
  /** 本轮用户消息对应的检查点 id。 */
  checkpointId?: string
  /** 本轮仍在执行的工具 id：消息已结束、等工具返回时也显示转圈与已运行时长。 */
  runningToolIds?: Set<string>
}) {
  const lastIndex = message.content.length - 1
  const [copied, setCopied] = useState(false)
  const [rewindOpen, setRewindOpen] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  // 流式进行中从本条消息开始出现时计时；结束后改用服务端记录的准确耗时。
  const liveStartedAt = useRef(Date.now())
  const liveNow = useNow(streaming, 100)
  useEffect(() => {
    if (streaming) liveStartedAt.current = Date.now()
  }, [streaming])
  const scopeTarget = useSessionTarget() ?? undefined
  const running = useSessionView((s) => s?.running ?? false)
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

  const forkFromHere = () => {
    const state = useAppStore.getState()
    const view = scopeTarget
      ? state.sessionViews[`${scopeTarget.hostId}:${scopeTarget.sessionId}`]
      : state.active
    if (!view) return
    void state.forkSession(view.hostId, view.sessionId, message.id)
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
    if (ok) store.send(turnUser.content.filter((b) => b.type !== 'tool_result'), scopeTarget)
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
        live: runningToolIds?.has((b as ToolUseBlock).id) ?? false,
      }))
      if (run.length >= 3) {
        rendered.push(
          <ToolGroup
            key={`${message.id}-g-${i}`}
            entries={run}
            toolResults={toolResults}
            cwd={cwd}
            subagentId={subagentId}
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
              live={runningToolIds?.has(item.block.id) ?? false}
              toolResults={toolResults}
              cwd={cwd}
              subagentId={subagentId}
            />,
          )
        }
      }
      i = j
      continue
    }
    i++
  }

  const liveDuration = Math.max(0, liveNow - liveStartedAt.current)
  const durationMs = streaming ? liveDuration : message.durationMs
  const hasTime = typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)
  const showUsage = !streaming && !!message.usage
  const sepBefore = (previous: boolean) => (previous ? ' · ' : '')

  return (
    <div className={cn('msg-group relative flex flex-col', animate && 'chat-msg-enter')}>
      {rendered}
      <div className="mt-0.5 flex h-7 items-center justify-start gap-1" data-msg-meta>
        <UsageLine>
          <MessageTime createdAt={message.createdAt} durationMs={durationMs} />
          {showUsage && (
            <span>
              {sepBefore(hasTime)}
              输入 {formatTokens(message.usage!.inputTokens)} · 输出{' '}
              {formatTokens(message.usage!.outputTokens)} · 缓存命中{' '}
              {formatTokens(message.usage!.cacheReadTokens ?? 0)} · 花费{' '}
              {formatCost(message.usage!.costUsd)}
            </span>
          )}
          {streaming && (
            <span data-live-duration>
              {sepBefore(hasTime)}
              {formatDurationMs(liveDuration)}
            </span>
          )}
          {!streaming && typeof message.durationMs === 'number' && (
            <span>
              {sepBefore(hasTime || showUsage)}
              {formatDurationMs(message.durationMs)}
            </span>
          )}
        </UsageLine>
        {rawText.trim() && !streaming && (
          <div className="msg-actions flex items-center gap-0.5">
            <IconButton
              size="sm"
              onClick={copyAll}
              label={copied ? '已复制' : '复制整条回复'}
              tooltip={copied ? '已复制' : '复制整条回复（Markdown）'}
              className="[&_svg]:size-[12.5px]"
            >
              {copied ? <Check size={12.5} className="text-success" /> : <Copy size={12.5} />}
            </IconButton>
            {!readOnly && (
              <IconButton
                size="sm"
                onClick={forkFromHere}
                label="从这里分叉"
                tooltip="从这里分叉（复制到这条回复为止）"
                className="[&_svg]:size-[12.5px]"
              >
                <GitFork size={12.5} />
              </IconButton>
            )}
            {!readOnly && turnUser && checkpointId && (
              <IconButton
                size="sm"
                onClick={() => setRewindOpen(true)}
                disabled={running}
                label="回退到此处"
                tooltip={running ? '运行中，结束后可回退' : '回退到此处'}
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
                tooltip={running ? '运行中，结束后可重新生成' : '重新生成'}
                className="[&_svg]:size-[12.5px]"
              >
                {regenerating ? (
                  <Loader2 size={12.5} className="animate-spin" />
                ) : (
                  <RefreshCw size={12.5} />
                )}
              </IconButton>
            )}
          </div>
        )}
      </div>
      {rawText.trim() && !streaming && (
        <>
          <div className="msg-more mt-0.5 h-7 justify-start max-md:h-11">
            <Menu
              aria-label="回复操作"
              align="left"
              side="bottom"
              trigger={({ open }) => (
                <IconButton label="回复操作" tooltip={open ? '' : undefined} className="[&_svg]:size-[15px] max-md:size-11 [&_svg]:max-md:size-[17px]">
                  <MoreHorizontal size={15} />
                </IconButton>
              )}
            >
              <>
                  <Menu.Item
                    icon={<Copy />}
                    onSelect={() => {
                      void copyAll()
                    }}
                  >
                    {copied ? '已复制' : '复制整条回复'}
                  </Menu.Item>
                  {!readOnly && (
                    <Menu.Item
                      icon={<GitFork />}
                      onSelect={() => {
                        forkFromHere()
                      }}
                    >
                      从这里分叉
                    </Menu.Item>
                  )}
                  {!readOnly && turnUser && checkpointId && (
                    <Menu.Item
                      icon={<Undo2 />}
                      disabled={running}
                      disabledReason={running ? '运行中，结束后可回退' : undefined}
                      onSelect={() => {
                        setRewindOpen(true)
                      }}
                    >
                      回退到此处
                    </Menu.Item>
                  )}
                  {!readOnly && turnUser && checkpointId && (
                    <Menu.Item
                      icon={<RefreshCw />}
                      disabled={running || regenerating}
                      disabledReason={running ? '运行中，结束后可重新生成' : undefined}
                      onSelect={() => {
                        void regenerate()
                      }}
                    >
                      重新生成
                    </Menu.Item>
                  )}
</>
            </Menu>
          </div>
        </>
      )}
      {rewindOpen && turnUser && (
        <RewindDialog message={turnUser} onClose={() => setRewindOpen(false)} />
      )}
    </div>
  )
})
