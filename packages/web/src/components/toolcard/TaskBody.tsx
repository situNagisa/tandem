import { ArrowUpRight, Bot } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { cn } from '../../lib/cn'
import { formatTokens } from '../../lib/format'
import type { SubagentSession } from '../../lib/types'
import { AgentElapsed, agentKind, partialString, str } from './helpers'
import { OutputBlock } from './OutputBlock'
import { SubagentStream } from './SubagentStream'

export function TaskBody({
  input,
  raw,
  sub,
  output,
  isError,
  running,
  depth,
  linkedId,
  parentSessionId,
  hostId,
  onOpen,
}: {
  input: Record<string, unknown>
  raw: string
  sub: SubagentSession | undefined
  output: string
  isError: boolean
  running: boolean
  depth: number
  linkedId?: string
  parentSessionId?: string | null
  hostId?: string | null
  onOpen?: () => void
}) {
  const description =
    str(input.description) || partialString(raw, 'description') || str(input.prompt).slice(0, 80)
  const prompt = str(input.prompt) || partialString(raw, 'prompt') || ''
  const type = str(input.subagent_type) || 'general-purpose'
  const refreshSessions = useAppStore((s) => s.refreshSessions)
  const summary = sub?.summary
  const subRunning = !!sub?.running
  const status = summary?.status
  const failed = status === 'error'
  const tokens = (summary?.usage?.inputTokens ?? 0) + (summary?.usage?.outputTokens ?? 0)
  const statusText = failed
    ? '出错'
    : status === 'waiting_permission'
      ? '待审批'
      : status === 'retrying'
        ? '等待网络'
        : subRunning || status === 'running'
          ? '运行中'
          : summary
            ? '已结束'
            : running
              ? '启动中…'
              : ''
  return (
    <div className="group/task space-y-2">
      {/* 反馈12#04：一行标题（名称 + 类型 + 状态/耗时/token），提示词折叠成第二行；不再套两层边框。 */}
      <div className="rounded-md bg-[color-mix(in_srgb,var(--t-bg)_55%,transparent)] px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Bot size={12} className={cn('shrink-0', failed ? 'text-danger' : 'text-muted')} />
          <button data-raw-button
            type="button"
            onClick={onOpen}
            disabled={!onOpen}
            data-tip={onOpen ? `打开${agentKind()}会话` : description}
            className="min-w-0 truncate text-left text-[12.5px] font-medium text-text enabled:hover:underline enabled:hover:underline-offset-2 disabled:cursor-default"
          >
            {description || '未命名任务'}
          </button>
          <span className="shrink-0 rounded bg-[var(--t-bg-active)] px-1.5 py-px font-mono text-[9.5px] text-muted">
            {type}
          </span>
          <span className="flex-1" />
          {statusText && (
            <span
              className={cn(
                'shrink-0 text-[11px] tabular-nums',
                failed ? 'text-danger' : subRunning ? 'text-text-secondary' : 'text-muted',
              )}
            >
              {statusText}
              {subRunning && summary && (
                <>
                  {' '}
                  <AgentElapsed
                    id={summary.id}
                    since={summary.createdAt ?? Date.now()}
                    running
                  />
                </>
              )}
            </span>
          )}
          {summary && tokens > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted">{formatTokens(tokens)}</span>
          )}
          {onOpen && (
            <button data-raw-button
              type="button"
              onClick={onOpen}
              aria-label={`打开${agentKind()}会话`}
              data-tip={`打开${agentKind()}会话（只读）`}
              className="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-[var(--t-bg-hover)] hover:text-text"
            >
              <ArrowUpRight size={12} />
            </button>
          )}
        </div>
        {prompt && (
          <button data-raw-button
            type="button"
            onClick={onOpen}
            disabled={!onOpen}
            data-tip={prompt}
            className="mt-1 block w-full max-w-full overflow-hidden text-left text-[11px] leading-[17px] text-muted transition-colors enabled:hover:text-text-soft"
          >
            <span className="line-clamp-1 group-hover/task:line-clamp-4">{prompt}</span>
          </button>
        )}
      </div>
      {summary ? (
        <div className={cn(depth > 1 && 'pl-2 border-l border-border/60')}>
          <SubagentStream id={summary.id} depth={depth} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
          {running ? (
            <span className="shimmer-text">正在创建{agentKind()}会话…</span>
          ) : (
            <>
              <span>没有找到{agentKind()}会话</span>
              <span className="text-[11px] text-text-tertiary">
                {linkedId
                  ? '这次调用记录了子会话 id，但会话还没加载。'
                  : '这次 Task 调用没有记录子会话 id（可能来自旧版本会话或子会话已被清理）。'}
              </span>
              {linkedId && parentSessionId && (
                <Button size="inline" variant="ghost" onClick={() => hostId && void refreshSessions(hostId)}>
                  重新查找
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {output && (isError || !summary) && (
        <OutputBlock text={output} isError={isError} maxHeight={220} />
      )}
    </div>
  )
}
