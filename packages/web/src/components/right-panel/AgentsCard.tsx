import { useMemo } from 'react'
import { Bot, Ellipsis } from 'lucide-react'
import type { SubagentSession } from '../../lib/types'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { useNow } from '../../lib/hooks'
import { api } from '../../lib/api'
import { Menu } from '../ui/Menu'
import { IconButton } from '../ui/Button'
import { profileModelGroups } from '../../lib/profileModels'
import { useSessionView } from '../session/SessionScope'
import { runningSince } from '../../lib/runClock'
import { formatElapsed, formatTokens } from '../../lib/format'
import { cn } from '../../lib/cn'

function AgentRow({ sub, depth, hostId }: { sub: SubagentSession; depth: number; hostId: string | null }) {
  const focusAgent = useUiStore((s) => s.focusAgent)
  const openAgentSession = useUiStore((s) => s.openAgentSession)
  const toast = useUiStore((s) => s.toast)
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const profiles = useAppStore((s) => (hostId ? s.runtimes[hostId]?.profiles ?? [] : []))
  const modelRows = useMemo(
    () =>
      profiles.flatMap((profile) =>
        profileModelGroups(profile).flatMap((group) =>
          group.models.map((model) => ({
            key: `${profile.id}:${group.groupId ?? ''}:${model}`,
            label: `${profile.name} › ${group.name} › ${model}`,
            model,
          })),
        ),
      ),
    [profiles],
  )
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
  const rerun = async (model?: string) => {
    if (!host || !id) return
    try {
      await api.rerunSubagent(host, id, model)
      toast('已换模型重新派发子代理', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '重跑失败', 'error')
    }
  }
  const promote = async () => {
    if (!host || !id) return
    try {
      await api.promoteSubagent(host, id)
      toast('已交回主会话（单代理）', 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : '转交失败', 'error')
    }
  }
  // 反馈12#03：层级无限，用固定 12px 缩进 + 细竖引导线表示；最多缩进 6 层，
  // 再深不再增加缩进，改用「L8」这样的层号小字。统一叫「子代理」，不用子/孙文字。
  const level = Math.max(0, depth - 1)
  const visuals = Math.min(level, 6)
  return (
    <div className="group flex min-h-8 items-center gap-0.5">
      <span
        aria-hidden
        className="agent-guides flex shrink-0 self-stretch"
        style={{ width: visuals * 12 }}
      >
        {Array.from({ length: visuals }).map((_, i) => (
          <span key={i} className="agent-guide" />
        ))}
      </span>
      <button
        type="button"
        onClick={() => {
          if (!id) return
          if (hostId) openAgentSession(hostId, id)
          else focusAgent(id)
        }}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-[13px] transition-colors hover:bg-[var(--t-bg-hover)]"
        data-tip={sub.summary ? `${sub.summary.title} · ${sub.summary.model}` : undefined}
      >
      {depth > 6 && (
        <span className="shrink-0 text-[9.5px] tabular-nums text-muted" data-tip={`第 ${depth} 层`}>
          L{depth}
        </span>
      )}
      <Bot size={11} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-text-soft">
        {sub.summary?.title || '未命名子代理'}
      </span>
      {(failed || running || text === '待审批' || text === '等待网络') && (
        <span
          className={cn(
            'shrink-0 text-[12px]',
            failed ? 'text-danger' : running ? 'text-text-secondary' : 'text-muted',
          )}
        >
          {text}
          {running && ` ${formatElapsed(now - since)}`}
        </span>
      )}
      {tokens > 0 && (
        <span className="w-9 shrink-0 text-right text-[12px] tabular-nums text-muted">
          {formatTokens(tokens)}
        </span>
      )}
    </button>
    {!running && id && (
      <Menu
        side="bottom"
        align="end"
        className="w-[240px]"
        aria-label={`子代理操作：${sub.summary?.title ?? ''}`}
        trigger={({ open }) => (
          <IconButton
            size="sm"
            label="子代理操作"
            tooltip="换模型重跑 / 交回主会话（单代理）"
            className={cn('size-6! shrink-0 opacity-0 group-hover:opacity-100', open && 'opacity-100')}
          >
            <Ellipsis size={13} />
          </IconButton>
        )}
      >
        <Menu.Sub>
          <Menu.SubTrigger>换模型重跑</Menu.SubTrigger>
          <Menu.SubContent className="w-[280px]" aria-label="选择重跑模型">
            {modelRows.map((row) => (
              <Menu.Item key={row.key} onSelect={() => void rerun(row.model)}>
                {row.label}
              </Menu.Item>
            ))}
          </Menu.SubContent>
        </Menu.Sub>
        <Menu.Separator />
        <Menu.Item onSelect={() => void promote()}>交回主会话（单代理）</Menu.Item>
      </Menu>
    )}
    </div>
  )
}

export function AgentsCard() {
  const subagents = useAppStore((s) => s.active?.subagents)
  const activeSessionId = useAppStore((s) => s.active?.sessionId)
  const hostId = useSessionView((s) => s?.hostId ?? null)
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
        <AgentRow key={sub.summary?.id} sub={sub} depth={depth} hostId={hostId} />
      ))}
    </div>
  )
}

/** 右侧栏上下文卡片：与输入框上下文环同源，紧凑展示占用、分类与缓存命中率。 */
