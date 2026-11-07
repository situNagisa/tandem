import { useMemo } from 'react'
import type { SubagentSession } from '../../lib/types'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { useNow } from '../../lib/hooks'
import { runningSince } from '../../lib/runClock'
import { formatElapsed, formatTokens } from '../../lib/format'
import { cn } from '../../lib/cn'

function AgentRow({ sub, depth }: { sub: SubagentSession; depth: number }) {
  const focusAgent = useUiStore((s) => s.focusAgent)
  const id = sub.summary?.id ?? ''
  const status = sub.summary?.status
  const running =
    sub.running || status === 'running' || status === 'waiting_permission' || status === 'retrying'
  const now = useNow(running)
  const since = runningSince(`agent:${id}`, sub.summary?.createdAt ?? Date.now())
  const usage = sub.summary?.usage
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  const failed = status === 'error' || !!sub.error
  const text = failed
    ? '出错'
    : status === 'waiting_permission'
      ? '待审批'
      : status === 'retrying'
        ? '等待网络'
        : running
        ? '运行中'
        : sub.loading
          ? '加载中'
          : '已结束'
  return (
    <button
      type="button"
      onClick={() => id && focusAgent(id)}
      className="flex min-h-8 w-full items-center gap-1.5 rounded-md pr-1 text-left text-[13px] transition-colors hover:bg-[var(--t-bg-hover)]"
      style={{ paddingLeft: 4 + Math.max(0, depth - 1) * 14 }}
      title={sub.summary ? `${sub.summary.title} · ${sub.summary.model}` : undefined}
    >
      <span className="shrink-0 text-[12px] text-muted">
        {depth <= 1 ? '子' : depth === 2 ? '孙' : depth}
      </span>
      <span className="min-w-0 flex-1 truncate text-text-soft">
        {sub.summary?.title || '未命名子代理'}
      </span>
      {sub.summary?.model && (
        <span className="max-w-[92px] shrink-0 truncate font-mono text-[10.5px] text-muted" title={`模型：${sub.summary.model}`}>
          {sub.summary.model}
        </span>
      )}
      <span
        className={cn(
          'shrink-0 text-[12px]',
          failed ? 'text-danger' : running ? 'text-text-secondary' : 'text-muted',
        )}
      >
        {text}
        {running && ` ${formatElapsed(now - since)}`}
      </span>
      <span className="w-9 shrink-0 text-right text-[12px] tabular-nums text-muted">
        {formatTokens(tokens)}
      </span>
    </button>
  )
}

export function AgentsCard() {
  const subagents = useAppStore((s) => s.active?.subagents)
  const activeSessionId = useAppStore((s) => s.active?.sessionId)
  const rows = useMemo(() => {
    if (!subagents || !activeSessionId) return []
    const children = new Map<string, SubagentSession[]>()
    for (const sub of Object.values(subagents)) {
      const parentId = sub.summary?.parentId
      if (!parentId) continue
      const list = children.get(parentId) ?? []
      list.push(sub)
      children.set(parentId, list)
    }
    const out: Array<{ sub: SubagentSession; depth: number }> = []
    const walk = (parentId: string, depth: number) => {
      const list = (children.get(parentId) ?? [])
        .slice()
        .sort((a, b) => (a.summary?.createdAt ?? 0) - (b.summary?.createdAt ?? 0))
      for (const sub of list) {
        out.push({ sub, depth })
        if (sub.summary?.id) walk(sub.summary.id, depth + 1)
      }
    }
    walk(activeSessionId, 1)
    return out
  }, [subagents, activeSessionId])

  if (rows.length === 0) return <p className="text-[12px] text-muted">暂无子代理</p>
  return (
    <div className="space-y-0.5">
      {rows.map(({ sub, depth }) => (
        <AgentRow key={sub.summary?.id} sub={sub} depth={depth} />
      ))}
    </div>
  )
}

/** 右侧栏上下文卡片：与输入框上下文环同源，紧凑展示占用、分类与缓存命中率。 */
