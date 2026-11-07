import { memo, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
  Bot,
  Brain,
  Camera,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  FilePenLine,
  FilePlus2,
  FileText,
  Globe,
  Keyboard,
  ListChecks,
  ListTree,
  Loader2,
  MousePointerClick,
  ScrollText,
  Search,
  Square,
  Sparkles,
  SquareTerminal,
  Terminal,
  Wrench,
} from 'lucide-react'
import { diffLines } from 'diff'
import type { ContentBlock, Todo } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useNow } from '../lib/hooks'
import { runningSince } from '../lib/runClock'
import type { ToolResultBlock } from '../lib/types'
import { cn } from '../lib/cn'
import { firstLine, formatElapsed, truncate } from '../lib/format'
import { useBrowserShot } from '../lib/browserShot'
import { CodeBlock } from './CodeBlock'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'
import { Tooltip } from './ui/Tooltip'
import { DiffView } from './DiffView'
import { Markdown, openFileRef } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'

export type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

interface ToolMeta {
  icon: ComponentType<{ size?: number | string; className?: string }>
  verb: string
}

const TOOL_META: Record<string, ToolMeta> = {
  Bash: { icon: Terminal, verb: '运行' },
  BashOutput: { icon: Terminal, verb: '读取后台输出' },
  KillBash: { icon: Square, verb: '终止后台任务' },
  Read: { icon: FileText, verb: '读取' },
  Write: { icon: FilePlus2, verb: '写入' },
  Edit: { icon: FilePenLine, verb: '编辑' },
  Glob: { icon: Search, verb: '列出' },
  Grep: { icon: Search, verb: '搜索' },
  TodoWrite: { icon: ListChecks, verb: '更新待办' },
  WebFetch: { icon: Globe, verb: '获取' },
  Task: { icon: Bot, verb: '子代理' },
  Skill: { icon: Sparkles, verb: '使用技能' },
  Memory: { icon: Brain, verb: '记住' },
  browser_navigate: { icon: Globe, verb: '浏览器 · 打开' },
  browser_snapshot: { icon: ListTree, verb: '浏览器 · 快照' },
  browser_click: { icon: MousePointerClick, verb: '浏览器 · 点击' },
  browser_type: { icon: Keyboard, verb: '浏览器 · 输入' },
  browser_screenshot: { icon: Camera, verb: '浏览器 · 截图' },
  browser_console: { icon: ScrollText, verb: '浏览器 · 控制台' },
  browser_close: { icon: Square, verb: '浏览器 · 关闭' },
}

/** mcp__server__tool → { server, tool }。 */
function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const idx = rest.indexOf('__')
  if (idx <= 0 || idx >= rest.length - 2) return null
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function agentKind(depth: number): string {
  return depth <= 1 ? '子代理' : depth === 2 ? '孙代理' : `第${depth}层代理`
}

function agentTag(depth: number): string {
  return depth <= 1 ? '子' : depth === 2 ? '孙' : `${depth}`
}

/** target 是否为 ancestor 的后代（用于定位时逐层展开祖先 Task 卡片）。 */
function isAgentDescendant(
  subagents: Record<string, { summary: SessionSummaryLike | null }> | undefined,
  targetId: string,
  ancestorId: string,
): boolean {
  let cursor = subagents?.[targetId]
  const seen = new Set<string>()
  while (cursor?.summary?.parentId && !seen.has(cursor.summary.parentId)) {
    if (cursor.summary.parentId === ancestorId) return true
    seen.add(cursor.summary.parentId)
    cursor = subagents?.[cursor.summary.parentId]
  }
  return false
}

interface SessionSummaryLike {
  id: string
  parentId?: string
  depth?: number
}

function AgentElapsed({ id, since, running }: { id: string; since: number; running: boolean }) {
  const now = useNow(running)
  if (!running) return null
  const start = runningSince(`agent:${id}`, since)
  return <span className="tabular-nums">{formatElapsed(now - start)}</span>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function previewValue(value: unknown): string {
  if (typeof value === 'string') return truncate(value, 36)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return truncate(value.map(String).join(', '), 36)
  if (value && typeof value === 'object') return truncate(JSON.stringify(value), 36)
  return ''
}

/** 从流式半截 JSON 里尽力取出某个字符串字段，让摘要能在生成过程中出现。 */
function partialString(raw: string, key: string): string | undefined {
  if (!raw) return undefined
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = raw.match(re)
  if (!m) return undefined
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return m[1]
  }
}

/** 会话 cwd 内的路径显示为相对路径，和 Claude Code 一致。 */
function shortPath(path: string, cwd?: string): string {
  if (!path) return ''
  if (!cwd) return path
  const normalized = path.replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === base) return '.'
  if (normalized.startsWith(base + '/')) return normalized.slice(base.length + 1)
  return path
}

function urlHost(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return truncate(url, 60)
  }
}

function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  if (!oldText && !newText) return { added: 0, removed: 0 }
  const oldSafe = oldText.length > 50_000 ? oldText.slice(0, 50_000) : oldText
  const newSafe = newText.length > 50_000 ? newText.slice(0, 50_000) : newText
  try {
    let added = 0
    let removed = 0
    for (const change of diffLines(oldSafe, newSafe)) {
      const lines = change.value.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      if (change.added) added += lines.length
      else if (change.removed) removed += lines.length
    }
    return { added, removed }
  } catch {
    return { added: 0, removed: 0 }
  }
}

function OutputBlock({
  text,
  isError,
  running,
  maxHeight = 300,
}: {
  text: string
  isError?: boolean
  running?: boolean
  maxHeight?: number
}) {
  if (!text) {
    return (
      <div className="px-1 py-1 text-[12px] text-muted">
        {running ? <span className="shimmer-text">等待输出…</span> : '无输出'}
      </div>
    )
  }
  const shown =
    text.length > 200_000 ? text.slice(0, 200_000) + '\n…（输出过长，已截断）' : text
  return (
    <div
      className={cn('tool-output', isError && 'is-error')}
      style={{ maxHeight }}
    >
      {shown.split(/(\[secret:[A-Za-z0-9_-]+\])/g).map((part, index) => {
        const match = /^\[secret:([A-Za-z0-9_-]+)\]$/.exec(part)
        if (!match) return part
        const name = match[1]!
        return (
          <Tooltip key={index} label={`已隐藏 secret：${name}`} className="inline">
            <span
              data-secret-redacted={name}
              className="mx-px inline-flex items-center rounded border border-warning/30 bg-warning-soft/50 px-1 font-mono text-[11px] leading-[16px] text-warning"
            >
              {part}
            </span>
          </Tooltip>
        )
      })}
    </div>
  )
}

const TODO_ICONS = {
  completed: CircleCheck,
  in_progress: CircleDot,
  pending: Circle,
} as const

function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="space-y-1.5">
      {todos.map((t, i) => {
        const Icon = TODO_ICONS[t.status] ?? Circle
        return (
          <li key={i} className="flex items-start gap-2 text-[12.5px] leading-5">
            <Icon
              size={14}
              className={cn(
                'mt-0.5 shrink-0',
                t.status === 'completed'
                  ? 'text-success'
                  : t.status === 'in_progress'
                    ? 'text-text-secondary'
                    : 'text-muted',
              )}
            />
            <span
              className={cn(
                t.status === 'completed' ? 'text-muted line-through' : 'text-text-soft',
              )}
            >
              {t.content}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** 浏览器截图缩略图：点开看大图。 */
function BrowserShotThumb({
  hostId,
  sessionId,
  shotId,
}: {
  hostId: string
  sessionId: string
  shotId: string
}) {
  const host = useAppStore((s) => s.hosts.find((h) => h.id === hostId) ?? null)
  const { url, error } = useBrowserShot(host, sessionId, shotId)
  const [open, setOpen] = useState(false)
  if (error) return <p className="mt-1 text-[12px] text-danger">截图加载失败：{error}</p>
  if (!url) return <p className="mt-1 text-[12px] text-muted">截图加载中…</p>
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="查看浏览器截图大图"
        className="mt-1 block max-w-full overflow-hidden rounded-lg border border-border bg-[var(--t-bg)] transition-colors hover:border-border-strong"
      >
        <img
          src={url}
          alt="浏览器截图"
          className="block h-24 w-auto max-w-full object-cover object-top"
        />
      </button>
      {open && (
        <Modal
          open
          onClose={() => setOpen(false)}
          ariaLabel="浏览器截图"
          title="浏览器截图"
          className="w-[min(94vw,1100px)] max-w-none"
          bodyClassName="p-2"
        >
          <img src={url} alt="浏览器截图大图" className="mx-auto block h-auto max-h-[75vh] w-auto max-w-full object-contain" />
        </Modal>
      )}
    </>
  )
}

export const ToolCard = memo(function ToolCard({
  block,
  messageId,
  index,
  streaming,
  subagentId,
  toolResults,
  cwd: cwdProp,
}: {
  block: ToolUseBlock
  messageId: string
  index: number
  streaming: boolean
  /** 在 Task 子代理消息流里渲染时传入，用于取子会话的工具状态。 */
  subagentId?: string
  /** 外部会话只读预览：显式传入工具结果，不读活动会话。 */
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
}) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const storeCwd = useAppStore((s) => s.active?.summary?.cwd)
  const cwd = cwdProp ?? storeCwd
  const subagents = useAppStore((s) => s.active?.subagents)
  const activeSessionId = useAppStore((s) => s.active?.sessionId)
  const agentFocus = useUiStore((s) => s.agentFocus)
  const openBackgroundTasks = useUiStore((s) => s.openBackgroundTasks)
  const activeHostId = useAppStore((s) => s.active?.hostId)
  const raw = useAppStore((s) =>
    subagentId
      ? (s.active?.subagents[subagentId]?.liveToolInputs[`${messageId}:${index}`] ?? '')
      : (s.active?.liveToolInputs[`${messageId}:${index}`] ?? ''),
  )
  const storeResult = useAppStore((s) =>
    subagentId
      ? s.active?.subagents[subagentId]?.toolResults[block.id]
      : s.active?.toolResults[block.id],
  )
  const result = toolResults ? toolResults[block.id] : storeResult
  const isError = !!result?.isError
  const running = streaming && !result
  const mcp = useMemo(() => parseMcpName(block.name), [block.name])
  const meta = TOOL_META[block.name] ?? (mcp ? { icon: Wrench, verb: '调用' } : { icon: Wrench, verb: '使用' })
  const isTask = block.name === 'Task'
  const taskDescription = isTask ? str(asRecord(block.input).description) || partialString(raw, 'description') || '' : ''
  const parentId = subagentId ?? activeSessionId
  const sub = isTask && subagents
    ? Object.values(subagents)
        .filter(
          (item) =>
            item.summary?.parentId === parentId &&
            item.summary?.title === taskDescription,
        )
        .sort((a, b) => (b.summary?.createdAt ?? 0) - (a.summary?.createdAt ?? 0))[0]
    : undefined
  const parentDepth = subagentId
    ? (subagents?.[subagentId]?.summary?.depth ?? 1)
    : 0
  const agentDepth = sub?.summary?.depth ?? parentDepth + 1
  const displayMeta = isTask
    ? { ...meta, verb: agentKind(agentDepth) }
    : meta
  const cardRef = useRef<HTMLDivElement>(null)
  const focusAncestor = useMemo(
    () =>
      !!agentFocus &&
      !!sub?.summary &&
      isAgentDescendant(subagents, agentFocus.id, sub.summary.id),
    [agentFocus, sub?.summary?.id, subagents],
  )
  useEffect(() => {
    if (!agentFocus || !sub?.summary) return
    if (agentFocus.id === sub.summary.id || focusAncestor) {
      setMounted(true)
      setOpen(true)
    }
    if (agentFocus.id === sub.summary.id) {
      const timer = window.setTimeout(
        () => cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
        60,
      )
      return () => window.clearTimeout(timer)
    }
  }, [agentFocus?.nonce])

  const input = useMemo(() => {
    if (raw) {
      try {
        return asRecord(JSON.parse(raw))
      } catch {
        /* 仍是半截 JSON */
      }
    }
    return asRecord(block.input)
  }, [raw, block.input])

  const pick = (key: string) => str(input[key]) || partialString(raw, key) || ''
  const command = pick('command')
  const filePath = pick('file_path')
  const oldString = str(input.old_string)
  const newString = str(input.new_string)
  const content = str(input.content)
  const output = result?.content ?? ''
  const waitingInput = running && !raw && Object.keys(input).length === 0
  const displayPath = shortPath(filePath, cwd)
  const readLines = output ? output.split('\n').length : 0
  const backgroundId =
    block.name === 'Bash'
      ? /Command running in background with ID: (bash_[A-Za-z0-9_-]+)/.exec(output)?.[1]
      : undefined
  const browserShotId =
    block.name === 'browser_screenshot' && result && !isError
      ? /screenshotId=(shot_\d+)/.exec(output)?.[1]
      : undefined
  const Icon = displayMeta.icon

  const editStats = useMemo(
    () => (block.name === 'Edit' ? diffStats(oldString, newString) : { added: 0, removed: 0 }),
    [block.name, oldString, newString],
  )

  let target = ''
  let suffix: ReactNode = null
  switch (block.name) {
    case 'Bash':
      target = firstLine(command, 120)
      break
    case 'BashOutput':
      target = pick('bash_id')
      break
    case 'KillBash':
      target = pick('shell_id')
      break
    case 'Read':
      target = displayPath
      if (result && !isError) suffix = `· ${readLines} 行`
      break
    case 'Edit':
      target = displayPath
      suffix =
        oldString || newString ? (
          <span className="shrink-0 font-mono text-[12px]">
            <span className="text-text-soft">+{editStats.added}</span>{' '}
            <span className="text-muted">−{editStats.removed}</span>
          </span>
        ) : null
      break
    case 'Write':
      target = displayPath
      break
    case 'Glob':
      target = pick('pattern')
      break
    case 'Grep':
      target = pick('pattern') ? `'${pick('pattern')}'` : ''
      break
    case 'WebFetch': {
      const url = pick('url')
      target = urlHost(url) || url
      break
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : []
      target = ''
      if (todos.length) suffix = `· ${todos.length} 项`
      break
    }
    case 'Task':
      target = pick('description') || pick('prompt')
      break
    case 'Skill':
      target = pick('skill')
      break
    case 'Memory': {
      const action = pick('action')
      target =
        action === 'view'
          ? '查看记忆'
          : pick('text') || pick('old') || (running ? '…' : '更新记忆')
      break
    }
    case 'browser_navigate': {
      const url = pick('url')
      target = urlHost(url) || url
      break
    }
    case 'browser_click': {
      const label = /已点击 "([^"]+)"/.exec(output)?.[1]
      target = label ? `'${truncate(label, 40)}'` : pick('ref') || (running ? '…' : '点击')
      break
    }
    case 'browser_type': {
      const label = /已在 "([^"]+)"/.exec(output)?.[1]
      const text = /输入"([^"]{0,40})"/.exec(output)?.[1]
      target = label
        ? `'${truncate(label, 30)}'${text ? ` 输入 "${truncate(text, 24)}"` : ''}`
        : pick('ref') || (running ? '…' : '输入')
      break
    }
    case 'browser_screenshot':
      target = input.fullPage === true ? '整页' : '当前视口'
      break
    case 'browser_snapshot':
      target = '当前页面'
      break
    case 'browser_console':
      target = '最近输出与报错'
      break
    case 'browser_close':
      target = ''
      break
    default:
      target = mcp ? `${mcp.server} · ${mcp.tool}` : block.name
  }

  if (!target && block.name !== 'TodoWrite') {
    target = running ? '…' : block.name
  }
  const fullTarget =
    block.name === 'Bash' ? command : block.name === 'Edit' || block.name === 'Read' || block.name === 'Write' ? filePath : target
  if (mcp) {
    const first = Object.entries(input).find(([, value]) => typeof value === 'string' || typeof value === 'number')
    if (first) {
      suffix = (
        <span className="max-w-[180px] shrink-0 truncate font-mono text-[10.5px] text-muted">
          {previewValue(first[1])}
        </span>
      )
    }
  }
  if (isTask) {
    const subFailed = sub?.summary?.status === 'error' || !!sub?.error
    suffix = (
      <span
        className={cn(
          'shrink-0 text-[10.5px]',
          sub?.running ? 'text-text-secondary' : subFailed ? 'text-danger' : 'text-muted',
        )}
      >
        {sub?.running ? (
          <>
            运行中 <AgentElapsed id={sub.summary?.id ?? ''} since={sub.summary?.createdAt ?? Date.now()} running />
          </>
        ) : sub?.summary?.status === 'error' ? (
          '出错'
        ) : sub?.summary ? (
          '已结束'
        ) : running ? (
          '启动中…'
        ) : result ? (
          '已结束'
        ) : (
          ''
        )}
      </span>
    )
  }

  const body = mounted ? (() => {
    if (block.name === 'Bash') {
      return (
        <div className="space-y-2">
          <div className="overflow-x-auto rounded-md bg-[color-mix(in_srgb,var(--t-bg)_45%,transparent)] px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-text">
            <span className="select-none text-muted">$ </span>
            {command || <span className="shimmer-text">生成命令…</span>}
          </div>
          <OutputBlock text={output} isError={isError} running={running} maxHeight={320} />
        </div>
      )
    }
    if (block.name === 'Edit') {
      return (
        <div className="space-y-2">
          {waitingInput ? (
            <div className="shimmer-text py-1 text-[12px] text-muted">正在生成改动…</div>
          ) : oldString || newString ? (
            <DiffView oldText={oldString} newText={newString} fileName={displayPath || 'Edit'} maxHeight={380} />
          ) : (
            <div className="py-1 text-[12px] text-muted">没有可显示的改动内容</div>
          )}
          {isError ? (
            <OutputBlock text={output} isError />
          ) : (
            result &&
            output && <div className="text-[12px] text-muted">{firstLine(output, 200)}</div>
          )}
        </div>
      )
    }
    if (block.name === 'Write') {
      return (
        <div className="space-y-2">
          {waitingInput ? (
            <div className="shimmer-text py-1 text-[12px] text-muted">正在生成文件内容…</div>
          ) : content ? (
            <DiffView oldText="" newText={content} fileName={displayPath || 'Write'} maxHeight={380} />
          ) : (
            <div className="py-1 text-[12px] text-muted">没有文件内容</div>
          )}
          {isError && <OutputBlock text={output} isError />}
        </div>
      )
    }
    if (block.name === 'Read') {
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-md bg-[color-mix(in_srgb,var(--t-bg)_45%,transparent)] px-2.5 py-1.5 font-mono text-[12px] text-text-soft">
            <FileText size={13} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate" title={filePath}>
              {displayPath || '…'}
            </span>
            <span className="shrink-0 text-[12px] text-muted">
              {result ? `${readLines} 行` : running ? '读取中…' : ''}
            </span>
          </div>
          {isError && <OutputBlock text={output} isError />}
        </div>
      )
    }
    if (block.name === 'Glob' || block.name === 'Grep') {
      return <OutputBlock text={output} isError={isError} running={running} maxHeight={320} />
    }
    if (block.name === 'TodoWrite') {
      const todos = Array.isArray(input.todos) ? (input.todos as Todo[]) : []
      return todos.length ? (
        <TodoList todos={todos} />
      ) : (
        <div className="shimmer-text text-[12px] text-muted">正在更新任务…</div>
      )
    }
    if (block.name === 'WebFetch') {
      return (
        <div className="space-y-2">
          <div className="break-all font-mono text-[12px] text-text-soft">{pick('url')}</div>
          <OutputBlock text={output} isError={isError} running={running} maxHeight={320} />
        </div>
      )
    }
    if (isTask) {
      return (
        <TaskBody
          input={input}
          raw={raw}
          sub={sub}
          output={output}
          isError={isError}
          running={running}
          depth={agentDepth}
        />
      )
    }
    if (mcp) {
      return (
        <div className="space-y-2">
          {Object.keys(input).length > 0 && (
            <CodeBlock
              code={JSON.stringify(input, null, 2)}
              language="json"
              showHeader={false}
              maxHeight={220}
            />
          )}
          <OutputBlock text={output} isError={isError} running={running} maxHeight={320} />
        </div>
      )
    }
    return (
      <div className="space-y-2">
        {Object.keys(input).length > 0 && (
          <CodeBlock
            code={JSON.stringify(input, null, 2)}
            language="json"
            showHeader={false}
            maxHeight={220}
          />
        )}
        <OutputBlock text={output} isError={isError} running={running} maxHeight={320} />
      </div>
    )
  })() : null

  return (
    <div className="my-0.5" ref={cardRef}>
      <button
        onClick={() => {
          setMounted(true)
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        title={fullTarget || undefined}
        className="tool-row"
      >
        {running || (isTask && sub?.running) ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-text-secondary" />
        ) : (
          <Icon size={14} className={cn('shrink-0', isError ? 'text-danger' : 'text-muted')} />
        )}
        {isTask && (
          <span className="shrink-0 text-[9.5px] font-normal text-muted">
            {agentTag(agentDepth)}
          </span>
        )}
        <span className={cn('shrink-0', isError && 'text-danger')}>{displayMeta.verb}</span>
        {(isTask || block.name === 'Skill' || block.name === 'Memory') && target && (
          <span className="shrink-0 text-muted">·</span>
        )}
        {target && filePath && (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write') ? (
          <span
            role="link"
            tabIndex={0}
            title={`打开 ${filePath}`}
            onClick={(e) => {
              e.stopPropagation()
              openFileRef({ path: filePath }, cwd)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              e.stopPropagation()
              openFileRef({ path: filePath }, cwd)
            }}
            className={cn(
              'file-ref min-w-0 truncate font-mono text-[12.5px]',
              isError ? 'text-danger' : 'text-text-soft',
            )}
          >
            {target}
          </span>
        ) : target ? (
          <span
            className={cn(
              'min-w-0 truncate font-mono text-[12.5px]',
              isError ? 'text-danger' : 'text-text-soft',
            )}
          >
            {target}
          </span>
        ) : null}
        {isTask && sub?.summary?.model && (
          <span
            className="max-w-[130px] shrink-0 truncate rounded bg-[var(--t-bg-active)] px-1 py-px font-mono text-[9.5px] font-normal text-muted"
            title={`子代理模型：${sub.summary.model}`}
          >
            {sub.summary.model}
          </span>
        )}
        {suffix && (
          <span className={cn('shrink-0', isError ? 'text-danger' : 'text-muted')}>{suffix}</span>
        )}
        <ChevronRight size={12} className="tool-chevron shrink-0 text-muted" />
      </button>
      {backgroundId && activeHostId && (subagentId ?? activeSessionId) && (
        <button
          type="button"
          onClick={() =>
            openBackgroundTasks(activeHostId, subagentId ?? activeSessionId!, backgroundId)
          }
          className="mt-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-text-soft hover:bg-[var(--t-bg-hover)] hover:text-text"
        >
          <SquareTerminal size={12} />
          后台运行 · 查看输出
        </button>
      )}
      {browserShotId && activeHostId && (subagentId ?? activeSessionId) && (
        <BrowserShotThumb
          hostId={activeHostId}
          sessionId={subagentId ?? activeSessionId!}
          shotId={browserShotId}
        />
      )}
      {mounted && (
        <div className="collapse-grid" data-open={open}>
          <div className="collapse-inner">
            <div className="tool-detail">{body}</div>
          </div>
        </div>
      )}
    </div>
  )
})

function SubagentStream({ id, depth }: { id: string; depth: number }) {
  const sub = useAppStore((s) => s.active?.subagents[id])
  const stopSubagent = useAppStore((s) => s.interruptSubagent)
  const listRef = useRef<HTMLDivElement>(null)
  const subDepth = sub?.summary?.depth ?? depth
  useEffect(() => {
    if (!sub?.running) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sub?.running, sub?.messages.length])
  if (!sub) {
    return <div className="py-2 text-[12px] text-muted">正在等待{agentKind(depth)}会话…</div>
  }
  const subFailed = sub.summary?.status === 'error' || !!sub.error
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border bg-[var(--t-bg)]',
        subDepth > 1 && 'border-l-2 border-l-border/80',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-1.5 text-[10.5px] text-muted">
        {sub.summary?.model && (
          <span className="max-w-[150px] shrink-0 truncate font-mono" title={`模型：${sub.summary.model}`}>
            {sub.summary.model}
          </span>
        )}
        {sub.running ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-text-secondary" />
        ) : (
          <Bot
            size={12}
            className={subFailed ? 'text-danger' : 'text-muted'}
          />
        )}
        <span className="text-[9.5px] text-muted">{agentTag(subDepth)}</span>
        <span>{agentKind(subDepth)}会话</span>
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
            onClick={() => stopSubagent(id)}
            className="h-6! gap-1 px-1.5 text-[10px] [&_svg]:size-[9px]"
          >
            <Square size={9} /> 停止{agentKind(subDepth)}
          </Button>
        )}
      </div>
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
                <div className="mb-0.5 text-[9.5px] text-muted">{agentKind(subDepth)}任务</div>
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

function TaskBody({
  input,
  raw,
  sub,
  output,
  isError,
  running,
  depth,
}: {
  input: Record<string, unknown>
  raw: string
  sub: { summary: { id: string; model?: string } | null } | undefined
  output: string
  isError: boolean
  running: boolean
  depth: number
}) {
  const description =
    str(input.description) || partialString(raw, 'description') || str(input.prompt).slice(0, 80)
  const prompt = str(input.prompt) || partialString(raw, 'prompt') || ''
  const type = str(input.subagent_type) || 'general-purpose'
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border/70 bg-[var(--t-bg)] px-2.5 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] font-medium text-text">
            {agentKind(depth)} · {description || '未命名任务'}
          </span>
          <span className="rounded bg-[var(--t-bg-active)] px-1.5 py-px font-mono text-[9.5px] text-muted">
            {type}
          </span>
          {sub?.summary?.model && (
            <span
              className="max-w-[220px] truncate rounded bg-[var(--t-bg-active)] px-1.5 py-px font-mono text-[9.5px] text-muted"
              title={`子代理模型：${sub.summary.model}`}
            >
              {sub.summary.model}
            </span>
          )}
        </div>
        {prompt && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[10.5px] text-muted hover:text-text-soft">
              查看任务提示词
            </summary>
            <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-5 text-text-soft">
              {prompt}
            </pre>
          </details>
        )}
      </div>
      {sub?.summary ? (
        <div className={cn(depth > 1 && 'ml-2 border-l border-border/70 pl-2')}>
          <SubagentStream id={sub.summary.id} depth={depth} />
        </div>
      ) : (
        <div className="text-[12px] text-muted">
          {running ? `正在创建${agentKind(depth)}会话…` : `没有找到${agentKind(depth)}会话`}
        </div>
      )}
      {output && (isError || !sub?.summary) && (
        <OutputBlock text={output} isError={isError} maxHeight={220} />
      )}
    </div>
  )
}
