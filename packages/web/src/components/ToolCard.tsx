import { memo, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
  ArrowUpRight,
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
  MousePointerClick,
  ScrollText,
  Search,
  Square,
  Sparkles,
  SquareTerminal,
  Terminal,
  Wrench,
} from 'lucide-react'
import { Spinner } from './ui/Spinner'
import { diffLines } from 'diff'
import type { ContentBlock, Todo, ToolOutputTruncation } from '@tandem/protocol'
import { api } from '../lib/api'
import { useAppStore } from '../store/useAppStore'
import { useUiStore } from '../store/useUiStore'
import { useSessionTarget, useSessionView } from './session/SessionScope'
import { useNow } from '../lib/hooks'
import { runningSince } from '../lib/runClock'
import type { SubagentSession, ToolResultBlock } from '../lib/types'
import { ReadOnlySessionGraph } from './sessionGraph/SessionGraphCard'
import { cn } from '../lib/cn'
import { firstLine, formatBytes, formatElapsed, formatTokens, truncate } from '../lib/format'
import { useBrowserShot } from '../lib/browserShot'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'
import { Tooltip } from './ui/Tooltip'
export type { ToolUseBlock } from './toolcard/helpers'
import { ToolCardBody } from './toolcard/ToolCardBody'
import { BrowserShotThumb } from './toolcard/BrowserShotThumb'
import {
  TOOL_META,
  AgentElapsed,
  agentKind,
  asRecord,
  diffStats,
  isAgentDescendant,
  parseMcpName,
  partialString,
  previewValue,
  shortPath,
  str,
  urlHost,
  type ToolUseBlock,
} from './toolcard/helpers'
import { Markdown, openFileRef } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'

export const ToolCard = memo(function ToolCard({
  block,
  messageId,
  index,
  streaming,
  live = false,
  subagentId,
  toolResults,
  cwd: cwdProp,
}: {
  block: ToolUseBlock
  messageId: string
  index: number
  streaming: boolean
  /** 本轮仍在执行这个工具（消息已结束、等工具返回时也显示转圈与已运行时长）。 */
  live?: boolean
  /** 在 Task 子代理消息流里渲染时传入，用于取子会话的工具状态。 */
  subagentId?: string
  /** 外部会话只读预览：显式传入工具结果，不读活动会话。 */
  toolResults?: Record<string, ToolResultBlock>
  cwd?: string
}) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const storeCwd = useSessionView((s) => s?.summary?.cwd)
  const cwd = cwdProp ?? storeCwd
  const subagents = useSessionView((s) => s?.subagents)
  const activeSessionId = useSessionView((s) => s?.sessionId)
  const agentFocus = useUiStore((s) => s.agentFocus)
  const openBackgroundTasks = useUiStore((s) => s.openBackgroundTasks)
  const openAgentSession = useUiStore((s) => s.openAgentSession)
  const activeHostId = useSessionView((s) => s?.hostId)
  const raw = useSessionView((s) =>
    subagentId
      ? (s?.subagents[subagentId]?.liveToolInputs[`${messageId}:${index}`] ?? '')
      : (s?.liveToolInputs[`${messageId}:${index}`] ?? ''),
  )
  const storeResult = useSessionView((s) =>
    subagentId
      ? s?.subagents[subagentId]?.toolResults[block.id]
      : s?.toolResults[block.id],
  )
  const result = toolResults ? toolResults[block.id] : storeResult
  const isError = !!result?.isError
  const running = (streaming || live) && !result
  const runningStart = useRef(Date.now())
  useEffect(() => {
    if (running) runningStart.current = Date.now()
  }, [running])
  const runningNow = useNow(running)
  const runningElapsed = running ? formatElapsed(runningNow - runningStart.current) : undefined
  const activeHost = useAppStore((s) =>
    activeHostId ? (s.hosts.find((host) => host.id === activeHostId) ?? null) : null,
  )
  const resultSessionId = subagentId ?? activeSessionId
  const loadFullOutput = async (): Promise<string | null> => {
    if (!activeHost || !resultSessionId) return null
    try {
      const { block: fullBlock } = await api.messageBlock(activeHost, resultSessionId, {
        toolUseId: block.id,
      })
      return fullBlock.type === 'tool_result' ? fullBlock.content : null
    } catch {
      return null
    }
  }
  const mcp = useMemo(() => parseMcpName(block.name), [block.name])
  const meta = TOOL_META[block.name] ?? (mcp ? { icon: Wrench, verb: '调用' } : { icon: Wrench, verb: '使用' })
  const isTask = block.name === 'Task'
  const taskDescription = isTask ? str(asRecord(block.input).description) || partialString(raw, 'description') || '' : ''
  const parentId = subagentId ?? activeSessionId
  // 反馈12#05：优先用 tool_result 里记录的 subagent.id；旧数据没有时按标题匹配，
  // 只有一个候选子会话时直接用它（演示数据/旧会话的标题未必等于 Task description）。
  const sub = isTask && subagents
    ? (() => {
        const linkedId = result?.subagent?.id
        if (linkedId && subagents[linkedId]) return subagents[linkedId]
        const candidates = Object.values(subagents)
          .filter((item) => item.summary?.parentId === parentId)
          .sort((a, b) => (b.summary?.createdAt ?? 0) - (a.summary?.createdAt ?? 0))
        return (
          // 服务端记录的 parentToolUseId 是最稳的关联；旧数据再按标题/唯一候选兜底。
          candidates.find((item) => item.summary?.parentToolUseId === block.id) ??
          candidates.find((item) => item.summary?.title === taskDescription) ??
          (candidates.length === 1 ? candidates[0] : undefined)
        )
      })()
    : undefined
  const parentDepth = subagentId
    ? (subagents?.[subagentId]?.summary?.depth ?? 1)
    : 0
  const agentDepth = sub?.summary?.depth ?? parentDepth + 1
  const displayMeta = isTask
    ? { ...meta, verb: agentKind() }
    : meta
  const onOpenAgent =
    sub?.summary?.id && activeHostId
      ? () => openAgentSession(activeHostId, sub.summary!.id)
      : undefined
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



  return (
    <div className="my-1" ref={cardRef} data-tool-use-id={block.id}>
      <button data-raw-button
        onClick={() => {
          // 反馈2108#02：子代理行点击直接进入子代理会话，不再展开卡片。
          if (onOpenAgent) {
            onOpenAgent()
            return
          }
          setMounted(true)
          setOpen((v) => !v)
        }}
        aria-expanded={onOpenAgent ? undefined : open}
        data-tip={fullTarget || undefined}
        className="tool-row"
      >
        {running || (isTask && sub?.running) ? (
          <Spinner size={14} className="shrink-0 text-text-secondary" />
        ) : (
          <Icon size={14} className={cn('shrink-0', isError ? 'text-danger' : 'text-muted')} />
        )}
        <span className={cn('shrink-0', isError && 'text-danger')}>{displayMeta.verb}</span>
        {(isTask || block.name === 'Skill' || block.name === 'Memory') && target && (
          <span className="shrink-0 text-muted">·</span>
        )}
        {target && filePath && (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write') ? (
          <span
            role="link"
            tabIndex={0}
            data-tip={`打开 ${filePath}`}
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
            data-tip={`子代理模型：${sub.summary.model}`}
          >
            {sub.summary.model}
          </span>
        )}
        {suffix && (
          <span className={cn('shrink-0', isError ? 'text-danger' : 'text-muted')}>{suffix}</span>
        )}
        {runningElapsed && (
          <span data-tool-elapsed="" className="shrink-0 tabular-nums text-[11.5px] text-muted">
            已运行 {runningElapsed}
          </span>
        )}
        <ChevronRight size={12} className="tool-chevron shrink-0 text-muted" />
      </button>
      {backgroundId && activeHostId && (subagentId ?? activeSessionId) && (
        <button data-raw-button
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
            <div className="tool-detail">
              <ToolCardBody
                block={block}
                input={input}
                raw={raw}
                output={output}
                isError={isError}
                running={running}
                waitingInput={waitingInput}
                oldString={oldString}
                newString={newString}
                content={content}
                command={command}
                displayPath={displayPath}
                filePath={filePath}
                result={result}
                readLines={readLines}
                loadFullOutput={loadFullOutput}
                pick={pick}
                sub={sub}
                agentDepth={agentDepth}
                linkedId={result?.subagent?.id}
                parentId={parentId}
                activeHostId={activeHostId}
                mcp={mcp}
                onOpenAgent={onOpenAgent}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
