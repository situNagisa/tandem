import { memo, useEffect, useMemo, useState, type ComponentType } from 'react'
import {
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  FilePenLine,
  FilePlus2,
  FileText,
  Globe,
  ListChecks,
  Loader2,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react'
import type { ContentBlock, Todo } from '@tandem/protocol'
import { useAppStore } from '../store/useAppStore'
import { cn } from '../lib/cn'
import { languageFromPath } from '../lib/highlight'
import { firstLine, truncate } from '../lib/format'
import { CodeBlock } from './CodeBlock'
import { DiffView } from './DiffView'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

interface ToolMeta {
  icon: ComponentType<{ size?: number | string; className?: string }>
  label: string
}

const TOOL_META: Record<string, ToolMeta> = {
  Bash: { icon: Terminal, label: 'Bash' },
  Read: { icon: FileText, label: 'Read' },
  Write: { icon: FilePlus2, label: 'Write' },
  Edit: { icon: FilePenLine, label: 'Edit' },
  Glob: { icon: Search, label: 'Glob' },
  Grep: { icon: Search, label: 'Grep' },
  TodoWrite: { icon: ListChecks, label: 'TodoWrite' },
  WebFetch: { icon: Globe, label: 'WebFetch' },
  Task: { icon: Wrench, label: 'Task' },
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
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

function toolSummary(name: string, input: Record<string, unknown>, raw: string): string {
  const pick = (key: string) => str(input[key]) || partialString(raw, key) || ''
  if (name === 'Bash') return firstLine(pick('command'), 90)
  if (name === 'Read' || name === 'Edit' || name === 'Write') return pick('file_path')
  if (name === 'Glob') return pick('pattern')
  if (name === 'Grep') {
    const pattern = pick('pattern')
    const path = pick('path')
    return path ? `${pattern}  ${path}` : pattern
  }
  if (name === 'WebFetch') return pick('url')
  if (name === 'TodoWrite') {
    const todos = Array.isArray(input.todos) ? input.todos : []
    return todos.length ? `${todos.length} 项任务` : ''
  }
  if (Object.keys(input).length) {
    try {
      return truncate(JSON.stringify(input), 80)
    } catch {
      return ''
    }
  }
  return ''
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
      <div
        className={cn(
          'rounded-lg border px-3 py-2 font-mono text-[11.5px]',
          isError
            ? 'border-danger/30 bg-danger-soft/60 text-danger'
            : 'border-border/60 bg-surface-2/30 text-muted',
        )}
      >
        {running ? <span className="shimmer-text">等待输出…</span> : '无输出'}
      </div>
    )
  }
  const shown =
    text.length > 200_000 ? text.slice(0, 200_000) + '\n…（输出过长，已截断）' : text
  return (
    <div
      className={cn(
        'overflow-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 font-mono text-[11.5px] leading-[1.6]',
        isError
          ? 'border-danger/35 bg-danger-soft/60 text-danger'
          : 'border-border/60 bg-surface-2/30 text-text-soft',
      )}
      style={{ maxHeight }}
    >
      {shown}
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
                    ? 'text-accent'
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

export const ToolCard = memo(function ToolCard({
  block,
  messageId,
  index,
  streaming,
}: {
  block: ToolUseBlock
  messageId: string
  index: number
  streaming: boolean
}) {
  const [open, setOpen] = useState(false)
  const raw = useAppStore((s) => s.active?.liveToolInputs[`${messageId}:${index}`] ?? '')
  const result = useAppStore((s) => s.active?.toolResults[block.id])
  const isError = !!result?.isError
  const running = streaming && !result
  const meta = TOOL_META[block.name] ?? { icon: Wrench, label: block.name }

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

  useEffect(() => {
    if (isError) setOpen(true)
  }, [isError])

  const baseSummary = toolSummary(block.name, input, raw)
  const output = result?.content ?? ''
  const readLines = output ? output.split('\n').length : 0
  const summary =
    block.name === 'Read' && result
      ? `${baseSummary}${baseSummary ? ' · ' : ''}${readLines} 行`
      : baseSummary
  const command = str(input.command) || partialString(raw, 'command') || ''
  const filePath = str(input.file_path) || partialString(raw, 'file_path') || ''
  const oldString = str(input.old_string)
  const newString = str(input.new_string)
  const content = str(input.content)
  const language = languageFromPath(filePath)
  const waitingInput = running && !raw && Object.keys(input).length === 0
  const Icon = meta.icon

  let body: React.ReactNode = null
  if (block.name === 'Bash') {
    body = (
      <div className="space-y-2">
        <div className="overflow-x-auto rounded-lg border border-border/60 bg-surface-2/30 px-3 py-2 font-mono text-[11.5px] leading-relaxed">
          <span className="select-none text-muted">$ </span>
          <span className="text-text">{command || <span className="shimmer-text">生成命令…</span>}</span>
        </div>
        <OutputBlock
          text={output}
          isError={isError}
          running={running}
          maxHeight={320}
        />
      </div>
    )
  } else if (block.name === 'Edit') {
    body = (
      <div className="space-y-2">
        {waitingInput ? (
          <div className="shimmer-text py-1 text-[12px]">正在生成改动…</div>
        ) : oldString || newString ? (
          <DiffView oldText={oldString} newText={newString} fileName={filePath || 'Edit'} />
        ) : (
          <div className="text-[12px] text-muted">没有可显示的改动内容</div>
        )}
        {isError && <OutputBlock text={output} isError />}
        {!isError && result && output && (
          <div className="text-[11px] text-muted">{firstLine(output, 200)}</div>
        )}
      </div>
    )
  } else if (block.name === 'Write') {
    body = (
      <div className="space-y-2">
        {waitingInput ? (
          <div className="shimmer-text py-1 text-[12px]">正在生成文件内容…</div>
        ) : content ? (
          <DiffView oldText="" newText={content} fileName={filePath || 'Write'} />
        ) : (
          <div className="text-[12px] text-muted">没有文件内容</div>
        )}
        {isError && <OutputBlock text={output} isError />}
      </div>
    )
  } else if (block.name === 'Read') {
    body = (
      <div className="space-y-2">
        <div className="text-[11.5px] text-muted">
          {result ? `读取 ${readLines} 行` : running ? '读取中…' : '尚未读取'}
        </div>
        {output && !isError ? (
          <CodeBlock code={output} language={language} fileName={filePath} maxHeight={280} />
        ) : (
          <OutputBlock text={output} isError={isError} running={running} />
        )}
      </div>
    )
  } else if (block.name === 'Glob' || block.name === 'Grep') {
    body = (
      <div className="space-y-2">
        <OutputBlock
          text={output}
          isError={isError}
          running={running}
          maxHeight={320}
        />
      </div>
    )
  } else if (block.name === 'TodoWrite') {
    const todos = Array.isArray(input.todos) ? (input.todos as Todo[]) : []
    body = todos.length ? (
      <TodoList todos={todos} />
    ) : (
      <div className="shimmer-text text-[12px]">正在更新任务…</div>
    )
  } else if (block.name === 'WebFetch') {
    body = (
      <div className="space-y-2">
        <div className="break-all font-mono text-[11.5px] text-text-soft">{str(input.url)}</div>
        <OutputBlock text={output} isError={isError} running={running} maxHeight={320} />
      </div>
    )
  } else {
    body = (
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
    <div
      className={cn(
        'group/tool relative my-2.5 overflow-hidden rounded-xl border bg-surface transition-colors duration-150',
        isError
          ? 'border-danger/40'
          : running
            ? 'border-accent/25'
            : 'border-border/80 hover:border-border-strong/70',
      )}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-10 w-full items-center gap-2 px-2.5 py-1.5 text-left"
        aria-expanded={open}
      >
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md',
            isError
              ? 'bg-danger-soft text-danger'
              : running
                ? 'bg-accent-soft text-accent'
                : 'bg-surface-2 text-text-soft',
          )}
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} />}
        </span>
        <span className="shrink-0 text-[12px] font-medium">{meta.label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted">
          {summary || (running ? '运行中…' : '')}
        </span>
        {isError && (
          <span className="shrink-0 rounded-full bg-danger-soft px-1.5 py-px text-[10px] font-medium text-danger">
            错误
          </span>
        )}
        <ChevronRight
          size={13}
          className={cn(
            'shrink-0 text-muted transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
      </button>
      {running && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent/70" />
        </div>
      )}
      {open && (
        <div className="border-t border-border/70 bg-surface px-3 py-2.5">
          {body}
          {result && !isError && block.name === 'Edit' && !output && (
            <div className="mt-1.5 text-[11px] text-muted">修改完成</div>
          )}
        </div>
      )}
    </div>
  )
})
