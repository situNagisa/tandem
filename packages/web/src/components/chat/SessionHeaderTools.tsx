import { useMemo } from 'react'
import {
  ArrowUpRight,
  Bot,
  CircleDot,
  FileText,
  FolderTree,
  Loader2,
  SquareTerminal,
} from 'lucide-react'
import type { ContentBlock } from '@tandem/protocol'
import type { HostConfig, SubagentSession } from '../../lib/types'
import { useAppStore } from '../../store/useAppStore'
import { useUiStore } from '../../store/useUiStore'
import { useSessionChanges } from '../../lib/useChanges'
import { cn } from '../../lib/cn'
import { IconButton } from '../ui/Button'
import { Popover } from '../ui/Popover'

const EMPTY_SUBS: Record<string, SubagentSession> = {}

interface RunningItem {
  kind: 'tool' | 'agent'
  key: string
  name: string
  detail?: string
  id?: string
}

function toolSummary(block: Extract<ContentBlock, { type: 'tool_use' }>): string {
  const input = block.input
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const first = record.command ?? record.description ?? record.path ?? record.file_path ?? record.query
  return typeof first === 'string' ? first : ''
}

/** 顶栏「后台任务」：本会话正在运行的工具与子代理（后台任务能力落地前的等价视图）。 */
export function BackgroundTasksButton() {
  const running = useAppStore((s) => s.active?.running ?? false)
  const messages = useAppStore((s) => s.active?.messages)
  const toolResults = useAppStore((s) => s.active?.toolResults)
  const subagents = useAppStore((s) => s.active?.subagents) ?? EMPTY_SUBS

  const items = useMemo(() => {
    const list: RunningItem[] = []
    if (running) {
      for (const message of messages ?? []) {
        for (const block of message.content) {
          if (block.type !== 'tool_use' || toolResults?.[block.id]) continue
          list.push({
            kind: 'tool',
            key: block.id,
            name: block.name,
            detail: toolSummary(block),
          })
        }
      }
    }
    for (const sub of Object.values(subagents)) {
      const summary = sub.summary
      if (!summary) continue
      if (!(sub.running || summary.status === 'running' || summary.status === 'waiting_permission')) {
        continue
      }
      list.push({
        kind: 'agent',
        key: summary.id,
        id: summary.id,
        name: summary.title || '子代理',
        detail: summary.status === 'waiting_permission' ? '待审批' : '运行中',
      })
    }
    return list
  }, [running, messages, toolResults, subagents])

  return (
    <Popover
      align="right"
      padded={false}
      trigger={({ open, toggle }) => (
        <IconButton
          onClick={toggle}
          label="后台任务"
          tooltip={open ? '' : '后台任务'}
          aria-expanded={open}
          className={cn('text-text max-sm:size-11', open && 'bg-[var(--t-bg-active)]')}
        >
          <SquareTerminal size={16} />
        </IconButton>
      )}
    >
      {() => (
        <div className="w-[300px] max-w-[calc(100vw-1.5rem)]">
          <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
            <SquareTerminal size={11} />
            后台任务
            {items.length > 0 && <span className="ml-auto tabular-nums">{items.length}</span>}
          </div>
          {items.length === 0 ? (
            <p className="px-2 pb-2 pt-1 text-[12px] leading-5 text-muted">
              没有正在运行的工具或子代理
            </p>
          ) : (
            <div className="max-h-[320px] overflow-y-auto pb-1">
              {items.map((item) => (
                <div key={`${item.kind}:${item.key}`} className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5">
                  <span className="mt-0.5 shrink-0 text-text-soft">
                    {item.kind === 'agent' ? <Bot size={13} /> : <Loader2 size={13} className="animate-spin" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] leading-4 text-text">
                      {item.name}
                      {item.kind === 'agent' && <span className="ml-1 text-muted">子代理</span>}
                    </div>
                    {item.detail && (
                      <div className="truncate font-mono text-[11px] leading-4 text-muted" title={item.detail}>
                        {item.detail}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Popover>
  )
}

interface AgentRow {
  id: string
  title: string
  depth: number
  status?: string
  running: boolean
}

/** 顶栏「子代理」：复用右侧栏代理卡的数据，点行定位消息流里的 Task 卡片。 */
export function SubagentsButton() {
  const subagents = useAppStore((s) => s.active?.subagents) ?? EMPTY_SUBS
  const activeSessionId = useAppStore((s) => s.active?.sessionId ?? null)
  const focusAgent = useUiStore((s) => s.focusAgent)

  const rows = useMemo(() => {
    if (!activeSessionId) return []
    const children = new Map<string, string[]>()
    for (const sub of Object.values(subagents)) {
      const summary = sub.summary
      if (!summary?.parentId) continue
      const list = children.get(summary.parentId) ?? []
      list.push(summary.id)
      children.set(summary.parentId, list)
    }
    const out: AgentRow[] = []
    const seen = new Set<string>()
    const walk = (parentId: string, depth: number) => {
      for (const id of children.get(parentId) ?? []) {
        if (seen.has(id)) continue
        seen.add(id)
        const sub = subagents[id]
        const summary = sub?.summary
        if (!sub || !summary) continue
        const running =
          sub.running || summary.status === 'running' || summary.status === 'waiting_permission'
        out.push({
          id,
          title: summary.title || '未命名代理',
          depth,
          status: summary.status,
          running,
        })
        walk(id, depth + 1)
      }
    }
    walk(activeSessionId, 1)
    return out
  }, [subagents, activeSessionId])

  return (
    <Popover
      align="right"
      padded={false}
      trigger={({ open, toggle }) => (
        <IconButton
          onClick={toggle}
          label="子代理"
          tooltip={open ? '' : '子代理'}
          aria-expanded={open}
          className={cn('text-text max-sm:size-11', open && 'bg-[var(--t-bg-active)]')}
        >
          <Bot size={16} />
        </IconButton>
      )}
    >
      {(close) => (
        <div className="w-[300px] max-w-[calc(100vw-1.5rem)]">
          <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
            <Bot size={11} />
            子代理
            {rows.length > 0 && <span className="ml-auto tabular-nums">{rows.length}</span>}
          </div>
          {rows.length === 0 ? (
            <p className="px-2 pb-2 pt-1 text-[12px] leading-5 text-muted">本会话还没有子代理</p>
          ) : (
            <div className="max-h-[360px] overflow-y-auto pb-1">
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => {
                    close()
                    focusAgent(row.id)
                  }}
                  className="flex min-h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-[12.5px] transition-colors hover:bg-[var(--t-bg-hover)]"
                  style={{ paddingLeft: 8 + (row.depth - 1) * 14 }}
                >
                  <span className="shrink-0 text-[11px] text-muted">{row.depth <= 1 ? '子' : '孙'}</span>
                  <span className="min-w-0 flex-1 truncate text-text">{row.title}</span>
                  <span
                    className={cn(
                      'shrink-0 text-[11px]',
                      row.status === 'error'
                        ? 'text-danger'
                        : row.running
                          ? 'text-text-secondary'
                          : 'text-muted',
                    )}
                  >
                    {row.status === 'error'
                      ? '出错'
                      : row.status === 'waiting_permission'
                        ? '待审批'
                        : row.running
                          ? '运行中'
                          : '已结束'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Popover>
  )
}

/** 顶栏「文件」：会话改动文件入口，点击在右侧文件预览面板打开。 */
export function FilesButton({
  host,
  sessionId,
  changesNonce,
}: {
  host: HostConfig | null | undefined
  sessionId: string | null | undefined
  changesNonce: number
}) {
  const { changes } = useSessionChanges(host, sessionId, changesNonce, !!sessionId)
  const openFilePreview = useUiStore((s) => s.openFilePreview)
  const cwd = useAppStore((s) => s.active?.summary?.cwd ?? '')
  const files = changes?.files ?? []

  return (
    <Popover
      align="right"
      padded={false}
      trigger={({ open, toggle }) => (
        <IconButton
          onClick={toggle}
          label="文件"
          tooltip={open ? '' : '文件'}
          aria-expanded={open}
          className={cn('text-text max-sm:size-11', open && 'bg-[var(--t-bg-active)]')}
        >
          <FolderTree size={16} />
        </IconButton>
      )}
    >
      {(close) => (
        <div className="w-[320px] max-w-[calc(100vw-1.5rem)]">
          <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
            <FolderTree size={11} />
            改动文件
            {files.length > 0 && <span className="ml-auto tabular-nums">{files.length}</span>}
          </div>
          {files.length === 0 ? (
            <p className="px-2 pb-2 pt-1 text-[12px] leading-5 text-muted">当前会话还没有改动文件</p>
          ) : (
            <div className="max-h-[360px] overflow-y-auto pb-1">
              {files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => {
                    close()
                    if (!sessionId) return
                    openFilePreview({ path: file.path, cwd })
                  }}
                  className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-[var(--t-bg-hover)]"
                  title={`${file.path}  +${file.additions} −${file.deletions}`}
                >
                  <FileText size={12} className="shrink-0 text-text-tertiary" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text">
                    {file.path}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--t-git-plus)]">
                    +{file.additions}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-[var(--t-git-minus)]">
                    −{file.deletions}
                  </span>
                  <ArrowUpRight size={11} className="shrink-0 text-muted" />
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1.5 border-t border-border/60 px-2 py-1.5 text-[11px] text-muted">
            <CircleDot size={10} />
            点击文件在右侧预览
          </div>
        </div>
      )}
    </Popover>
  )
}
