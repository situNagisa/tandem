import { FileText } from 'lucide-react'
import type { Todo, ToolOutputTruncation } from '@tandem/protocol'
import type { SubagentSession, ToolResultBlock } from '../../lib/types'
import { CodeBlock } from '../CodeBlock'
import { DiffView } from '../DiffView'
import { firstLine } from '../../lib/format'
import { OutputBlock } from './OutputBlock'
import { TodoList } from './TodoList'
import { TaskBody } from './TaskBody'
import type { ToolUseBlock } from './helpers'

interface ToolCardBodyProps {
  block: ToolUseBlock
  input: Record<string, unknown>
  raw: string
  output: string
  isError: boolean
  running: boolean
  waitingInput: boolean
  oldString: string
  newString: string
  content: string
  command: string
  displayPath: string
  filePath: string
  result: ToolResultBlock | undefined
  readLines: number
  loadFullOutput: () => Promise<string | null>
  pick: (key: string) => string
  sub: SubagentSession | undefined
  agentDepth: number
  linkedId: string | undefined
  parentId: string | null | undefined
  activeHostId: string | undefined
  mcp: { server: string; tool: string } | null
  onOpenAgent: (() => void) | undefined
}

export function ToolCardBody({
  block,
  input,
  raw,
  output,
  isError,
  running,
  waitingInput,
  oldString,
  newString,
  content,
  command,
  displayPath,
  filePath,
  result,
  readLines,
  loadFullOutput,
  pick,
  sub,
  agentDepth,
  linkedId,
  parentId,
  activeHostId,
  mcp,
  onOpenAgent,
}: ToolCardBodyProps) {
  const isTask = block.name === 'Task'
    if (block.name === 'Bash') {
      return (
        <div className="space-y-2">
          <div className="overflow-x-auto rounded-md bg-[color-mix(in_srgb,var(--t-bg)_45%,transparent)] px-2.5 py-2 font-mono text-[12px] leading-[1.6] text-text">
            <span className="select-none text-muted">$ </span>
            {command || <span className="shimmer-text">生成命令…</span>}
          </div>
          <OutputBlock
            text={output}
            isError={isError}
            running={running}
            maxHeight={320}
            truncated={result?.truncated}
            onLoadFull={result?.truncated ? loadFullOutput : undefined}
          />
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
            <OutputBlock
              text={output}
              isError
              truncated={result?.truncated}
              onLoadFull={result?.truncated ? loadFullOutput : undefined}
            />
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
          {isError && <OutputBlock
              text={output}
              isError
              truncated={result?.truncated}
              onLoadFull={result?.truncated ? loadFullOutput : undefined}
            />}
        </div>
      )
    }
    if (block.name === 'Read') {
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-md bg-[color-mix(in_srgb,var(--t-bg)_45%,transparent)] px-2.5 py-1.5 font-mono text-[12px] text-text-soft">
            <FileText size={13} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate" data-tip={filePath}>
              {displayPath || '…'}
            </span>
            <span className="shrink-0 text-[12px] text-muted">
              {result ? `${readLines} 行` : running ? '读取中…' : ''}
            </span>
          </div>
          {isError && <OutputBlock
              text={output}
              isError
              truncated={result?.truncated}
              onLoadFull={result?.truncated ? loadFullOutput : undefined}
            />}
        </div>
      )
    }
    if (block.name === 'Glob' || block.name === 'Grep') {
      return <OutputBlock
            text={output}
            isError={isError}
            running={running}
            maxHeight={320}
            truncated={result?.truncated}
            onLoadFull={result?.truncated ? loadFullOutput : undefined}
          />
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
          <OutputBlock
            text={output}
            isError={isError}
            running={running}
            maxHeight={320}
            truncated={result?.truncated}
            onLoadFull={result?.truncated ? loadFullOutput : undefined}
          />
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
          linkedId={result?.subagent?.id}
          parentSessionId={parentId}
          hostId={activeHostId}
          onOpen={onOpenAgent}
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
          <OutputBlock
            text={output}
            isError={isError}
            running={running}
            maxHeight={320}
            truncated={result?.truncated}
            onLoadFull={result?.truncated ? loadFullOutput : undefined}
          />
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
        <OutputBlock
            text={output}
            isError={isError}
            running={running}
            maxHeight={320}
            truncated={result?.truncated}
            onLoadFull={result?.truncated ? loadFullOutput : undefined}
          />
      </div>
    )
}
